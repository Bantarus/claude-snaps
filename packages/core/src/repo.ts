import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { apmLockHash as apmLockHashOf } from './apm.js';
import {
  ancestorsOf,
  isAncestor as dagIsAncestor,
  lcaOf,
} from './dag.js';
import { diff as moduleDiff } from './diff.js';
import { listSnapshots, readSnapshot, writeSnapshot } from './blob.js';
import { captureCurrentState } from './capture.js';
import { EmptyRepositoryError, IntegrityError, IoError } from './errors.js';
import { IndexDb, type ListSnapshotsFilter, type ReindexResult } from './index_db.js';
import { listRefs, readHead, readRef, resolveHead, writeRef } from './refs.js';
import type {
  DiffOp, HeadState, Module, Snapshot,
} from './types.js';

const DEFAULT_BRANCH = 'main';
const DEFAULT_CONFIG_TOML = `# .harness/config — TOML. See spec/format.md §7.

[core]
default_branch = "main"
format_version = "0.1"

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
 * CLI/TUI/hook consumers. Holds an open SQLite handle — call close().
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

  // ── hook helpers ─────────────────────────────────────────────────────

  /**
   * Find a snapshot by its `sessionId` field, or null. Used by the hook
   * for idempotency: a second fire for the same session is a no-op.
   */
  findSnapshotBySessionId(sessionId: string): Snapshot | null {
    return this.db.findSnapshotBySessionId(sessionId);
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
