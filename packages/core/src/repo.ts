import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { apmLockHash as apmLockHashOf, readApmLockfileContent } from './apm.js';
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
import { parseTranscriptJsonl } from './ingest.js';
import { listRefs, readHead, readRef, resolveHead, writeRef } from './refs.js';
import { reproduceSnapshot } from './reproduce.js';
import type {
  Attribution, AttributionEventKind, DiffOp, HeadState,
  IngestSessionOptions, IngestSessionResult, Module,
  ReproduceOptions, ReproduceResult, SessionCostSummary, Snapshot,
  TurnRecord,
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
   * decoupled API) or `note()` (v0.3.0). This method stays exported
   * for migration tooling and other writers that need direct blob
   * control. v0.3.1 has only `init` and `auto` kinds; tags are
   * lightweight refs, not snapshots (format.md §4.2).
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

  // ── observe / note / attribution (v0.3.0 — spec/format.md §2.7) ──────

  /**
   * Capture the current `.claude/` composition and record an
   * attribution event WITHOUT a free-form note. The load-bearing v0.3
   * write API for hook-driven captures and other automated writers.
   *
   * If the captured composition matches the snapshot at the current
   * branch tip, no new snapshot blob is written; only the attribution
   * row is appended. Otherwise: writes a new `auto`-kind snapshot (or
   * `init` on the empty-repo first fire), advances the current branch
   * ref to its id, then appends the attribution.
   *
   * Returns the snapshot id the attribution points at (existing or new).
   *
   * Idempotent on the (sessionId, observedAt, eventKind) primary key
   * of the attributions table — a duplicate fire is silently dropped.
   *
   * The `eventKind` is narrowed to exclude `'note'` and `'migrated'`:
   * note events go through `note()` (which carries the required text),
   * and `migrated` is reserved for backfill and not emitted by any v0.3
   * writer.
   *
   * @throws {InvalidStateError} if HEAD is detached. The hook always
   * operates on a branch; `harness checkout <id>` puts the repo into
   * detached state and observe() refuses to write under that condition.
   */
  observe(event: {
    sessionId: string;
    eventKind: Exclude<AttributionEventKind, 'note' | 'migrated'>;
    source?: string | null;
    /** Optional pass-through onto a newly-written snapshot. */
    model?: string;
    permissionMode?: string;
    /** Claude Code CLI version observed at hook-fire (v0.5.0). */
    claudeCodeVersion?: string;
    /**
     * Override createdAt / observedAt. Defaults to now. Tests use this
     * for deterministic timestamps; the hook should leave it unset.
     */
    now?: string;
  }): string {
    return this.#captureAndAttribute({
      sessionId: event.sessionId,
      eventKind: event.eventKind,
      source: event.source ?? null,
      noteText: null,
      ...(event.model !== undefined ? { model: event.model } : {}),
      ...(event.permissionMode !== undefined ? { permissionMode: event.permissionMode } : {}),
      ...(event.claudeCodeVersion !== undefined ? { claudeCodeVersion: event.claudeCodeVersion } : {}),
      ...(event.now !== undefined ? { now: event.now } : {}),
    });
  }

  /**
   * Capture current composition (writing a new snapshot if novel) and
   * attach a `note` attribution carrying the user's text. The text is
   * required; per spec/format.md §2.7 there is no anonymous CLI
   * capture path.
   *
   * Returns the snapshot id the note is attached to.
   *
   * Atomic at the writer-API level: either both the capture and the
   * note succeed, or neither does (any throw before insertAttribution
   * leaves the snapshot table unchanged because writeSnapshot's effects
   * are visible only after a successful return; the SQL insert and any
   * blob/ref writes commit together inside writeSnapshot).
   *
   * @throws {InvalidStateError} on detached HEAD (same as observe).
   */
  note(args: {
    sessionId: string;
    noteText: string;
    /** Optional pass-through onto a newly-written snapshot. */
    model?: string;
    permissionMode?: string;
    claudeCodeVersion?: string;
    now?: string;
  }): string {
    if (typeof args.noteText !== 'string' || args.noteText.length === 0) {
      throw new InvalidStateError('note() requires a non-empty noteText');
    }
    return this.#captureAndAttribute({
      sessionId: args.sessionId,
      eventKind: 'note',
      source: null,
      noteText: args.noteText,
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(args.permissionMode !== undefined ? { permissionMode: args.permissionMode } : {}),
      ...(args.claudeCodeVersion !== undefined ? { claudeCodeVersion: args.claudeCodeVersion } : {}),
      ...(args.now !== undefined ? { now: args.now } : {}),
    });
  }

  /**
   * Trajectory of a session: ordered list of attribution events
   * (sessionId, snapshotId, observedAt, eventKind, source, noteText).
   * Notes appear inline at their observation timestamps. Empty if the
   * session was never observed.
   */
  trajectoryOf(sessionId: string): Attribution[] {
    return this.db.trajectoryOf(sessionId);
  }

  /**
   * Every `note` attribution attached to a snapshot, regardless of
   * which session attached it. Ordered by observed_at. Empty if the
   * snapshot has never been annotated.
   */
  notesOf(snapshotId: string): Attribution[] {
    return this.db.notesOf(snapshotId);
  }

  /**
   * Sessions that observed a given snapshot, with first/last observation
   * timestamps. Inverse of trajectoryOf.
   */
  sessionsAt(snapshotId: string): Array<{ sessionId: string; firstObservedAt: string; lastObservedAt: string }> {
    return this.db.sessionsAt(snapshotId);
  }

  /**
   * Distinct session ids that ever fired hooks into this `.harness/`,
   * ordered by earliest observation. Used by `harness ingest-session
   * --all` to enumerate transcripts to ingest.
   */
  sessionIds(): Array<{ sessionId: string; firstObservedAt: string }> {
    return this.db.distinctSessionIds();
  }

  /**
   * Distinct session ids with at least one `turn_metrics` row.
   * Ordered by earliest ingested_at. Used by `harness session-cost
   * --all` so backfilled sessions (ingested without attribution)
   * are listed too.
   */
  ingestedSessionIds(): string[] {
    return this.db.distinctIngestedSessionIds();
  }

  // ── session metrics (v0.5.0; spec/format.md §10) ─────────────────────

  /**
   * Read the strict-whitelist parser's output from a transcript JSONL
   * and persist new TurnRecord rows into `turn_metrics`.
   *
   * Idempotent on (sessionId, turn_index): re-running on an unchanged
   * JSONL produces zero new rows. Re-running after N turns appended
   * produces exactly N new rows; existing rows are unchanged.
   *
   * Privacy: extracts ONLY the whitelisted fields per
   * spec/format.md §10.2. The parser does not spread the parsed JSONL
   * into rows; every field is a named access. The fuzz gate W12.5
   * verifies this empirically against canary-laced fixtures.
   *
   * Caller controls the wall-clock-stamping of `ingestedAt` (the
   * `now` override is for tests).
   */
  ingestSession(args: {
    sessionId: string;
    transcriptPath: string;
    options?: IngestSessionOptions;
    /** Test-only override for `ingestedAt`. Production callers leave this unset. */
    now?: string;
  }): IngestSessionResult {
    const ingestedAt = args.now ?? new Date().toISOString();
    const dryRun = args.options?.dryRun === true;

    const stored = this.db.maxTurnIndex(args.sessionId);
    const sinceFloor = args.options?.sinceTurn;
    // Resume-floor: the first turn_index we will WRITE. If the caller
    // passes --since-turn N, force re-write from N (parser-bug
    // recovery — combined with INSERT OR IGNORE, this won't actually
    // overwrite existing rows; see ingestSession contract).
    let writeFrom: number;
    if (sinceFloor !== undefined) {
      writeFrom = Math.max(0, sinceFloor);
    } else {
      writeFrom = stored === null ? 0 : stored + 1;
    }

    const candidates = parseTranscriptJsonl(
      args.transcriptPath,
      args.sessionId,
      ingestedAt,
    );

    // Filter candidates to those at-or-after writeFrom. Anything
    // below the floor is a re-walked prefix that's already stored;
    // count it as skipped without sending it through INSERT OR IGNORE.
    const toWrite: typeof candidates = [];
    let skipped = 0;
    for (const c of candidates) {
      if (c.turnIndex < writeFrom) {
        skipped++;
      } else {
        toWrite.push(c);
      }
    }

    let added = 0;
    if (dryRun) {
      // No write; report what WOULD have been added. Defensive cap
      // against PK collisions (parser-bug recovery via --since-turn N
      // where N <= maxStored): only candidates whose index strictly
      // exceeds the stored max are net-new.
      const max = stored ?? -1;
      added = toWrite.filter((c) => c.turnIndex > max).length;
      skipped += toWrite.length - added;
    } else {
      added = this.db.insertTurnMetricsBatch(toWrite);
      skipped += toWrite.length - added;
    }

    const cost = this.sessionCost(args.sessionId) ?? {
      sessionId: args.sessionId,
      totalTurns: 0,
      userTurns: 0,
      assistantTurns: 0,
      models: [],
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      tools: {},
      claudeCodeVersion: null,
    };

    return { sessionId: args.sessionId, added, skipped, cost, dryRun };
  }

  /**
   * Aggregate per-session cost summary from `turn_metrics`. Returns
   * null when no turn_metrics row exists for the session (e.g. before
   * `ingestSession` has been run, or for a session whose JSONL is
   * absent).
   */
  sessionCost(sessionId: string): SessionCostSummary | null {
    return this.db.sessionCost(sessionId);
  }

  /**
   * Read every TurnRecord stored for a session, ordered by turn_index.
   * Empty when the session has not been ingested.
   */
  turnsOf(sessionId: string): TurnRecord[] {
    return this.db.turnsOf(sessionId);
  }

  // ── shared capture-and-attribute path used by observe() and note() ──

  #captureAndAttribute(event: {
    sessionId: string;
    eventKind: AttributionEventKind;
    source: string | null;
    noteText: string | null;
    model?: string;
    permissionMode?: string;
    claudeCodeVersion?: string;
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
    const modules = this.workingTree();
    const apmLockHash = this.apmLockHash();
    const apmLockfile = this.apmLockfileContent();

    // No-change path: head exists and the live composition matches the
    // head snapshot. Append attribution only; do NOT advance the
    // branch ref. v0.3 has no writer-supplied data that would force a
    // new snapshot for unchanged composition (the v0.2 message-as-canon
    // mechanism is gone — annotations live on attribution rows).
    if (headId !== null) {
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
          source: event.source,
          noteText: event.noteText,
        });
        return headId;
      }
    }

    // Change path: write a new snapshot, advance branch ref, attribute.
    const baseBlob: Omit<Snapshot, 'id'> = {
      formatVersion: '0.4',
      parentIds: headId === null ? [] : [headId],
      branch: branchName,
      kind: headId === null ? 'init' : 'auto',
      codePin: this.gitSha(),
      apmLockHash,
      apmLockfile,
      createdAt: observedAt,
      modules,
    };
    if (event.model !== undefined) baseBlob.model = event.model;
    if (event.permissionMode !== undefined) baseBlob.permissionMode = event.permissionMode;
    if (event.claudeCodeVersion !== undefined) baseBlob.claudeCodeVersion = event.claudeCodeVersion;

    const written = this.writeSnapshot(baseBlob);
    if (head === null || head.type === 'symbolic') {
      this.setBranch(branchName, written.id);
    }
    this.db.insertAttribution({
      sessionId: event.sessionId,
      snapshotId: written.id,
      observedAt,
      eventKind: event.eventKind,
      source: event.source,
      noteText: event.noteText,
    });
    return written.id;
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
    eventKind: Exclude<AttributionEventKind, 'note' | 'migrated'>;
    source?: string | null;
    now?: string;
  }): void {
    this.db.insertAttribution({
      sessionId: event.sessionId,
      snapshotId: event.snapshotId,
      observedAt: event.now ?? new Date().toISOString(),
      eventKind: event.eventKind,
      source: event.source ?? null,
      noteText: null,
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

  /**
   * Verbatim text content of `<projectRoot>/apm.lock.yaml`, or null if
   * absent. Used by capture (v0.4.0) to embed the lockfile in the
   * snapshot blob.
   */
  apmLockfileContent(): string | null {
    return readApmLockfileContent(this.projectRoot);
  }

  // ── reproducer (v0.4.0; spec/format.md §6.1) ───────────────────────────

  /**
   * Materialize a snapshot's harness composition into the working
   * `.claude/` directory. APM-driven: APM is a hard prerequisite for
   * content. Reports local-source modules without materializing them;
   * verifies builtins against the host's known set without writing.
   *
   * Side effects (when not in dry-run):
   *   1. Backs up `.claude/` to `.claude.harness-backup-<ISO timestamp>/`.
   *   2. Writes the snapshot's recorded `apmLockfile` to
   *      `apm.lock.yaml` (existing lockfile moved to
   *      `apm.lock.yaml.harness-backup`).
   *   3. Runs `apm install --frozen` and verifies post-install
   *      configHashes against the snapshot's recorded values.
   *   4. Advances HEAD (detached) to the snapshot id on success.
   *
   * On any APM-phase failure (install error or configHash mismatch),
   * HEAD is NOT advanced and the backup is retained.
   */
  reproduce(snapshotId: string, options?: ReproduceOptions): ReproduceResult {
    const snap = this.snapshot(snapshotId);
    return reproduceSnapshot({
      projectRoot: this.projectRoot,
      harnessDir: this.harnessDir,
      snapshotId,
      snapshot: snap,
      ...(options !== undefined ? { options } : {}),
    });
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
