import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { apmLockHash as apmLockHashOf } from './apm.js';
import { canonicalize } from './canonical.js';
import {
  ancestorsOf,
  isAncestor as dagIsAncestor,
  lcaOf,
} from './dag.js';
import { diff as moduleDiff } from './diff.js';
import { listSnapshots, readSnapshot, writeSnapshot } from './blob.js';
import { captureCurrentState } from './capture.js';
import { EmptyRepositoryError, IntegrityError, InvalidStateError, IoError } from './errors.js';
import { IndexDb, type ListSnapshotsFilter, type ReindexResult } from './index_db.js';
import { listRefs, readHead, readRef, resolveHead, writeRef } from './refs.js';
import type {
  Attribution, AttributionEventKind, DiffOp, HeadState, Module, Snapshot,
} from './types.js';

const DEFAULT_BRANCH = 'main';
const DEFAULT_CONFIG_TOML = `# .harness/config — TOML. See spec/format.md §7.

[core]
default_branch = "main"
format_version = "0.2"

[capture]
auto_snapshot_on_session = true
include_transcripts = false
mask_paths = []

[apm]
detect_lockfile = true
lockfile_path = "apm.lock.yaml"

[gitignore]
policy = "private"
`;

export interface RepoInitOptions {
  defaultBranch?: string;
}

/**
 * High-level facade. Composes blob/refs/dag/index_db/capture/diff for
 * CLI/hook consumers. Holds an open SQLite handle — call close().
 */
export class Repo {
  private constructor(
    public readonly projectRoot: string,
    public readonly harnessDir: string,
    private readonly db: IndexDb,
  ) {}

  /**
   * Initialize a fresh `<projectRoot>/.harness/` per spec §4.4. Idempotent
   * if `.harness/` already exists with a valid HEAD; otherwise creates
   * the empty-repository state (HEAD pointing at the default branch
   * which has no commits yet).
   */
  static init(projectRoot: string, options: RepoInitOptions = {}): Repo {
    const harnessDir = join(projectRoot, '.harness');
    const branch = options.defaultBranch ?? DEFAULT_BRANCH;
    try {
      mkdirSync(join(harnessDir, 'snapshots'), { recursive: true });
      mkdirSync(join(harnessDir, 'refs', 'heads'), { recursive: true });
    } catch (cause) {
      throw new IoError(`failed to create ${harnessDir}`, cause);
    }
    if (!existsSync(join(harnessDir, 'HEAD'))) {
      writeFileSync(join(harnessDir, 'HEAD'), `ref: refs/heads/${branch}\n`, 'utf-8');
    }
    if (!existsSync(join(harnessDir, 'config'))) {
      writeFileSync(join(harnessDir, 'config'), DEFAULT_CONFIG_TOML, 'utf-8');
    }
    return Repo.open(projectRoot);
  }

  /**
   * Open an existing repository. Errors loudly if `.harness/` is missing
   * or unreadable.
   */
  static open(projectRoot: string): Repo {
    const harnessDir = join(projectRoot, '.harness');
    if (!existsSync(harnessDir)) {
      throw new IoError(`no .harness/ directory at ${projectRoot}; call Repo.init() first`);
    }
    const db = IndexDb.open(harnessDir);
    return new Repo(projectRoot, harnessDir, db);
  }

  // ── HEAD / refs ──────────────────────────────────────────────────────

  /** The raw HEAD state — symbolic, detached, or null when malformed. */
  head(): HeadState {
    return readHead(this.harnessDir);
  }

  /** Resolve HEAD to a snapshot id, or null on the empty-repo case. */
  resolveHead(): string | null {
    return resolveHead(this.harnessDir);
  }

  branches(): Record<string, string> {
    return listRefs(this.harnessDir, 'heads/');
  }

  tags(): Record<string, string> {
    return listRefs(this.harnessDir, 'tags/');
  }

  /** Read a branch ref: returns the snapshot id at the branch tip. */
  branchTip(name: string): string {
    return readRef(this.harnessDir, `heads/${name}`);
  }

  /** Read a tag ref: returns the snapshot id the tag points at. */
  tagTarget(name: string): string {
    return readRef(this.harnessDir, `tags/${name}`);
  }

  /** Set a branch ref to a specific id. */
  setBranch(name: string, id: string): void {
    writeRef(this.harnessDir, `heads/${name}`, id);
  }

  /** Set a tag ref to a specific id. */
  setTag(name: string, id: string): void {
    writeRef(this.harnessDir, `tags/${name}`, id);
  }

  // ── snapshot read / write ────────────────────────────────────────────

  /** Load a single snapshot blob with hash verification. */
  snapshot(id: string): Snapshot {
    return readSnapshot(this.harnessDir, id);
  }

  /**
   * Append a snapshot blob to disk. The caller supplies everything
   * except `id`, which is computed from the canonical bytes. Does NOT
   * advance any branch ref — that's a separate, deliberate step
   * (`setBranch(name, returnedId)`).
   *
   * @internal — new consumers SHOULD use `observe()` (the v0.2.0
   * decoupled API). This method stays exported for migration tooling
   * and direct CLI commands that mint specific snapshot kinds (`tag`).
   */
  writeSnapshot(snap: Snapshot | Omit<Snapshot, 'id'>): Snapshot {
    const written = writeSnapshot(this.harnessDir, snap);
    this.db.insertSnapshot(written);
    return written;
  }

  /** Enumerate all snapshot ids on disk (does not load blobs). */
  listSnapshotIds(): string[] {
    return listSnapshots(this.harnessDir);
  }

  // ── log / diff / DAG ─────────────────────────────────────────────────

  /**
   * List snapshots from the index, ordered by createdAt DESC.
   * @throws {EmptyRepositoryError} if the repo has no commits and a
   *   filter is supplied (the filter implies the caller expects at least
   *   one commit). With no filter, returns an empty array.
   */
  log(opts?: ListSnapshotsFilter): Snapshot[] {
    const out = this.db.listSnapshots(opts);
    if (out.length === 0 && opts !== undefined && this.resolveHead() === null) {
      throw new EmptyRepositoryError(
        'log() called on empty repository with a filter; no commits exist yet',
      );
    }
    return out;
  }

  /** Diff two snapshots' module compositions. */
  diff(idA: string, idB: string): DiffOp[] {
    const a = this.snapshot(idA);
    const b = this.snapshot(idB);
    return moduleDiff(a.modules, b.modules);
  }

  ancestors(id: string): string[] {
    return ancestorsOf(this.harnessDir, id);
  }

  isAncestor(maybeAncestor: string, descendant: string): boolean {
    return dagIsAncestor(this.harnessDir, maybeAncestor, descendant);
  }

  lca(idA: string, idB: string): string | null {
    return lcaOf(this.harnessDir, idA, idB);
  }

  // ── working tree ─────────────────────────────────────────────────────

  /**
   * Capture the live state of `.claude/` (and APM lockfile, if any) as a
   * Module[]. Same code path the SessionStart hook calls — see
   * spec/hooks.md §2.
   */
  workingTree(): Module[] {
    return captureCurrentState(this.projectRoot);
  }

  // ── observe / attribution (v0.2.0 — spec/format.md §2.7) ─────────────

  /**
   * Capture the current `.claude/` composition and record an
   * attribution event. The load-bearing v0.2.0 write API.
   *
   * If the captured composition matches an existing snapshot on the
   * current branch, no new snapshot blob is written; only the
   * attribution row is appended. Otherwise: writes a new `manual`-kind
   * snapshot (or `init` on the empty-repo first fire), advances the
   * current branch ref to its id, then appends the attribution.
   *
   * Returns the snapshot id the attribution points at (existing or new).
   *
   * Idempotent on the (sessionId, observedAt, eventKind) primary key
   * of the attributions table — a duplicate fire is silently dropped.
   *
   * @throws {InvalidStateError} if HEAD is detached. The hook always
   * operates on a branch; `harness checkout <id>` puts the repo into
   * detached state and observe() refuses to write under that condition.
   */
  observe(event: {
    sessionId: string;
    eventKind: AttributionEventKind;
    source?: string | null;
    /** Used only when a NEW snapshot is written. Persisted as snap.message. */
    message?: string | null;
    /** Optional pass-through onto a newly-written snapshot. */
    model?: string;
    permissionMode?: string;
    /**
     * Override createdAt / observedAt. Defaults to now. Tests use this
     * for deterministic timestamps; the hook should leave it unset.
     */
    now?: string;
  }): string {
    const observedAt = event.now ?? new Date().toISOString();

    const head = this.head();
    if (head !== null && head.type === 'detached') {
      throw new InvalidStateError(
        'observe() refuses to write on a detached HEAD; check out a branch first',
      );
    }
    const branchName = this.currentBranchName() ?? DEFAULT_BRANCH;
    const headId = this.resolveHead();
    const message = event.message ?? null;
    const modules = this.workingTree();
    const apmLockHash = this.apmLockHash();

    // No-change path: head exists, no user message, and the live
    // composition matches the head snapshot. Append attribution only;
    // do NOT advance the branch ref. A user-supplied message ALWAYS
    // forces a new snapshot — the message participates in canonical
    // bytes (§3.1), so a messaged capture is a distinct snapshot from
    // a no-message one even with identical modules.
    if (headId !== null && message === null) {
      const headSnap = this.snapshot(headId);
      if (
        headSnap.apmLockHash === apmLockHash &&
        modulesEqual(headSnap.modules, modules)
      ) {
        this.db.insertAttribution({
          sessionId: event.sessionId,
          snapshotId: headId,
          observedAt,
          eventKind: event.eventKind,
          source: event.source ?? null,
        });
        return headId;
      }
    }

    // Change path: write a new snapshot, advance branch ref, attribute.
    const baseBlob: Omit<Snapshot, 'id'> = {
      formatVersion: '0.2',
      parentIds: headId === null ? [] : [headId],
      branch: branchName,
      kind: headId === null ? 'init' : 'manual',
      message,
      codePin: this.gitSha(),
      apmLockHash,
      createdAt: observedAt,
      modules,
    };
    if (event.model !== undefined) baseBlob.model = event.model;
    if (event.permissionMode !== undefined) baseBlob.permissionMode = event.permissionMode;

    const written = this.writeSnapshot(baseBlob);
    if (head === null || head.type === 'symbolic') {
      this.setBranch(branchName, written.id);
    }
    this.db.insertAttribution({
      sessionId: event.sessionId,
      snapshotId: written.id,
      observedAt,
      eventKind: event.eventKind,
      source: event.source ?? null,
    });
    return written.id;
  }

  /**
   * Trajectory of a session: ordered list of attribution events
   * (sessionId, snapshotId, observedAt, eventKind). Empty if the
   * session was never observed.
   */
  trajectoryOf(sessionId: string): Attribution[] {
    return this.db.trajectoryOf(sessionId);
  }

  /**
   * Sessions that observed a given snapshot, with first/last observation
   * timestamps. Inverse of trajectoryOf.
   */
  sessionsAt(snapshotId: string): Array<{ sessionId: string; firstObservedAt: string; lastObservedAt: string }> {
    return this.db.sessionsAt(snapshotId);
  }

  // ── hot-path cache (hook internal; see spec/hooks.md §2.4) ──────────

  /**
   * Lookup the cached observation result for a session. Returns null
   * when there's no cache entry. Implementation-internal — the cache
   * is best-effort; treat null as "must re-observe."
   */
  readObservationCache(sessionId: string): { fastHash: string; snapshotId: string } | null {
    return this.db.readObservationCache(sessionId);
  }

  /**
   * Persist this fire's (fastHash, snapshotId) for the next fire of
   * the same session to short-circuit. Call this AFTER observe() has
   * committed the attribution; if it throws or the process dies before
   * this call, the next fire safely re-walks. Not in the same
   * transaction as the attribution write (deliberate).
   */
  writeObservationCache(sessionId: string, fastHash: string, snapshotId: string): void {
    this.db.writeObservationCache(sessionId, fastHash, snapshotId);
  }

  /**
   * Append an attribution event referencing an existing snapshot,
   * without doing the full filesystem walk. Used by the hook's
   * hot-path: a fastHash cache hit means composition is unchanged
   * since the last fire, so we can attribute against the cached
   * snapshot id without re-running observe(). Idempotent on PK.
   */
  appendAttribution(event: {
    sessionId: string;
    snapshotId: string;
    eventKind: AttributionEventKind;
    source?: string | null;
    now?: string;
  }): void {
    this.db.insertAttribution({
      sessionId: event.sessionId,
      snapshotId: event.snapshotId,
      observedAt: event.now ?? new Date().toISOString(),
      eventKind: event.eventKind,
      source: event.source ?? null,
    });
  }

  /**
   * Current branch name when HEAD is symbolic, null when HEAD is detached
   * or absent. The branch name is the path under `refs/heads/`, e.g. `main`.
   */
  currentBranchName(): string | null {
    const head = this.head();
    if (head === null || head.type !== 'symbolic') return null;
    const prefix = 'refs/heads/';
    if (!head.ref.startsWith(prefix)) return null;
    return head.ref.slice(prefix.length);
  }

  /**
   * Current git sha at the project root, or null if the project is not a
   * git repository or git is unavailable. Used to populate `codePin`.
   */
  gitSha(): string | null {
    if (!existsSync(join(this.projectRoot, '.git'))) return null;
    try {
      const out = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: this.projectRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const sha = out.trim();
      return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    } catch {
      return null;
    }
  }

  /** sha256 of the apm.lock.yaml at the project root, prefixed `sha256:`, or null. */
  apmLockHash(): string | null {
    return apmLockHashOf(this.projectRoot);
  }

  // ── index ────────────────────────────────────────────────────────────

  reindex(): ReindexResult {
    const result = this.db.reindex();
    // Surface integrity errors during reindex — readSnapshot inside
    // reindex() throws, but we want a final cross-check that all blobs
    // are present.
    return result;
  }

  // ── lifecycle ────────────────────────────────────────────────────────

  /** Close the underlying SQLite handle. Safe to call multiple times. */
  close(): void {
    try {
      this.db.close();
    } catch (cause) {
      throw new IntegrityError('failed to close index db', cause);
    }
  }
}

// Module-array structural equality. Used by observe() to decide
// whether composition changed since the head snapshot. Modules are
// already in canonical order per spec/hooks.md §2.2, so position-wise
// canonical-JSON equality is sufficient.
function modulesEqual(a: Module[], b: Module[]): boolean {
  if (a.length !== b.length) return false;
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}
