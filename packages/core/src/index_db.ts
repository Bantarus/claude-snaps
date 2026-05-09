import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSnapshots, readSnapshot } from './blob.js';
import { IntegrityError, IoError, ParseError } from './errors.js';
import type {
  Attribution,
  AttributionEventKind,
  SessionCostSummary,
  Snapshot,
  SnapshotKind,
  TurnRecord,
} from './types.js';

// Per spec/format.md §5.2 the schema file is canonical — implementations
// MUST execute it verbatim. We read it from spec/schema/001_init.sql at
// runtime; we do NOT inline it as a TS string. Inlining would create
// two sources of truth that drift.

// On open we apply 001 → 002 → 003 → 004 → 005 → 006 → 007 in order so
// the runtime schema is always v7: schema v6 plus the v0.5.0
// claude_code_version column on snapshots and the turn_metrics table
// populated post-hoc by `harness ingest-session` (spec/format.md §10).
// Each migration is idempotent through the version-gate in ensureSchema().
const SCHEMA_FILES: Array<{ from: number; file: string; to: number }> = [
  { from: 0, file: '001_init.sql',                       to: 1 },
  { from: 1, file: '002_v0_2_decoupling.sql',            to: 2 },
  { from: 2, file: '003_session_observation_cache.sql',  to: 3 },
  { from: 3, file: '004_v0_3_notes.sql',                 to: 4 },
  { from: 4, file: '005_drop_tag_kind.sql',              to: 5 },
  { from: 5, file: '006_apm_lockfile.sql',               to: 6 },
  { from: 6, file: '007_session_metrics.sql',            to: 7 },
];
const CURRENT_SCHEMA_VERSION = 7;
const HARNESS_FORMAT_VERSION = '0.4';
const WRITER_NAME = '@harness/core@0.4.0';

// node:sqlite emits an ExperimentalWarning on first DatabaseSync() call in
// Node 22-24. Suppress only that specific warning so we don't pollute
// stderr; we accept the API-stability risk via the `engines.node` pin.
suppressNodeSqliteExperimentalWarning();

export interface ListSnapshotsFilter {
  branch?: string;
  kind?: SnapshotKind;
  limit?: number;
}

export interface ReindexResult {
  added: number;
  updated: number;
  removed: number;
}

export class IndexDb {
  private constructor(
    private readonly db: DatabaseSync,
    private readonly harnessDir: string,
  ) {}

  /**
   * Open or create `<harnessDir>/lineage.sqlite`. Applies the canonical
   * schema from spec/schema/001_init.sql if the database is fresh, or
   * verifies the existing schema version matches what this implementation
   * supports.
   *
   * @throws {IoError} on filesystem failure or schema-file unreachable.
   * @throws {IntegrityError} on schema-version mismatch.
   */
  static open(harnessDir: string): IndexDb {
    const dbPath = join(harnessDir, 'lineage.sqlite');
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(dbPath);
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('PRAGMA journal_mode = WAL');
    } catch (cause) {
      throw new IoError(`failed to open lineage.sqlite at ${dbPath}`, cause);
    }
    try {
      ensureSchema(db);
    } catch (e) {
      db.close();
      throw e;
    }
    return new IndexDb(db, harnessDir);
  }

  /**
   * Insert a snapshot row plus its parent edges and module rows.
   * Idempotent: if the snapshot id already exists, the call is a no-op.
   *
   * Public form — wraps the work in a transaction. For bulk inserts
   * inside an outer transaction (see `reindex`), use the private helper
   * `_insertSnapshotInTx` to avoid nested BEGIN (which node:sqlite
   * rejects with "cannot start a transaction within a transaction").
   */
  insertSnapshot(snap: Snapshot): void {
    const exists = this.db
      .prepare('SELECT 1 FROM snapshots WHERE id = ?')
      .get(snap.id);
    if (exists) return;
    tx(this.db, () => this._insertSnapshotInTx(snap));
  }

  private _insertSnapshotInTx(snap: Snapshot): void {
    this.db
      .prepare(
        `INSERT INTO snapshots
           (id, branch, kind, code_pin, apm_lock_hash, apm_lockfile,
            author, created_at, format_version,
            model, permission_mode, claude_code_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snap.id, snap.branch, snap.kind,
        snap.codePin, snap.apmLockHash, snap.apmLockfile ?? null,
        snap.author ?? null, snap.createdAt,
        snap.formatVersion ?? HARNESS_FORMAT_VERSION,
        snap.model ?? null, snap.permissionMode ?? null,
        snap.claudeCodeVersion ?? null,
      );
    const parentStmt = this.db.prepare(
      'INSERT INTO snapshot_parents (child_id, parent_id, parent_index) VALUES (?, ?, ?)',
    );
    snap.parentIds.forEach((pid, i) => parentStmt.run(snap.id, pid, i));

    const modStmt = this.db.prepare(
      `INSERT INTO snapshot_modules
         (snapshot_id, position, type, name, version, enabled, config_hash,
          source_kind, source_package, source_resolved_commit, source_depth,
          source_resolved_by, source_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    snap.modules.forEach((m, i) => {
      const src = m.source;
      modStmt.run(
        snap.id, i, m.type, m.name, m.version ?? null,
        m.enabled ? 1 : 0, m.configHash ?? null,
        src.kind,
        src.kind === 'apm' ? src.package : null,
        src.kind === 'apm' ? src.resolvedCommit : null,
        src.kind === 'apm' ? src.depth : null,
        src.kind === 'apm' ? (src.resolvedBy ?? null) : null,
        src.kind === 'local' ? src.path : null,
      );
    });
  }

  /**
   * Look up a snapshot by id from the index (NOT the blob). Returns null
   * if absent. Useful for fast metadata queries that don't need the full
   * blob; for hash-verified loading use `readSnapshot` from blob.ts.
   */
  getSnapshot(id: string): Snapshot | null {
    const row = this.db
      .prepare('SELECT * FROM snapshots WHERE id = ?')
      .get(id) as unknown as SnapshotRow | undefined;
    if (!row) return null;
    return this.hydrate(row);
  }

  /**
   * List snapshots from the index, with optional filters. Order is by
   * `created_at` descending (most recent first). `limit` defaults to no limit.
   */
  listSnapshots(filter?: ListSnapshotsFilter): Snapshot[] {
    let sql = 'SELECT * FROM snapshots';
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter?.branch !== undefined) {
      where.push('branch = ?');
      args.push(filter.branch);
    }
    if (filter?.kind !== undefined) {
      where.push('kind = ?');
      args.push(filter.kind);
    }
    if (where.length > 0) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY created_at DESC';
    if (filter?.limit !== undefined) {
      sql += ' LIMIT ?';
      args.push(filter.limit);
    }
    const rows = this.db.prepare(sql).all(...args) as unknown as SnapshotRow[];
    return rows.map((r) => this.hydrate(r));
  }

  // ── attribution events (v0.3; spec/format.md §2.7, §5.4) ──────────────

  /**
   * Append an attribution event row. Idempotent: a primary-key
   * collision on (session_id, observed_at, event_kind) is treated as a
   * successful no-op (the event was already recorded, retry is harmless).
   *
   * Validates the note_text invariant (non-null iff event_kind='note')
   * in TS before SQL — the SQL CHECK is the backstop, not the
   * front-line message.
   *
   * Throws if `snapshotId` doesn't reference an existing snapshot row —
   * the FK enforces this at SQLite level.
   */
  insertAttribution(attr: Attribution): void {
    const isNote = attr.eventKind === 'note';
    const hasText = attr.noteText !== null;
    if (isNote !== hasText) {
      throw new IntegrityError(
        `attribution note_text invariant violated: eventKind=${attr.eventKind} noteText=${
          attr.noteText === null ? 'null' : 'string'
        } (must be non-null iff eventKind='note')`,
      );
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO attributions
           (session_id, snapshot_id, observed_at, event_kind, source, note_text)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attr.sessionId, attr.snapshotId, attr.observedAt,
        attr.eventKind, attr.source, attr.noteText,
      );
  }

  /**
   * Trajectory of a session: ordered list of attribution events,
   * including any `note` events inline at their observation timestamps.
   * Returns empty array if the session has no recorded events.
   */
  trajectoryOf(sessionId: string): Attribution[] {
    const rows = this.db
      .prepare(
        `SELECT session_id, snapshot_id, observed_at, event_kind, source, note_text
           FROM attributions
          WHERE session_id = ?
          ORDER BY observed_at, event_kind`,
      )
      .all(sessionId) as unknown as AttributionRow[];
    return rows.map(rowToAttribution);
  }

  /**
   * Every `note` attribution attached to a snapshot, ordered by
   * observed_at. Returns empty array if the snapshot has never been
   * annotated.
   */
  notesOf(snapshotId: string): Attribution[] {
    const rows = this.db
      .prepare(
        `SELECT session_id, snapshot_id, observed_at, event_kind, source, note_text
           FROM attributions
          WHERE event_kind = 'note' AND snapshot_id = ?
          ORDER BY observed_at`,
      )
      .all(snapshotId) as unknown as AttributionRow[];
    return rows.map(rowToAttribution);
  }

  /**
   * Distinct session ids with at least one `turn_metrics` row.
   * Ordered by earliest ingested_at ASC. Used by `harness session-cost
   * --all` — distinct from `distinctSessionIds()` which is keyed on
   * attribution rows. A session can have turn_metrics without
   * attribution (backfill) or attribution without turn_metrics (the
   * normal pre-ingest state).
   */
  distinctIngestedSessionIds(): string[] {
    const rows = this.db
      .prepare(
        `SELECT session_id, MIN(ingested_at) AS first_ing
           FROM turn_metrics
          GROUP BY session_id
          ORDER BY first_ing ASC`,
      )
      .all() as { session_id: string; first_ing: string }[];
    return rows.map((r) => r.session_id);
  }

  /**
   * Distinct session ids that have any attribution row, ordered by
   * earliest observation timestamp ascending. Used by `harness
   * ingest-session --all` to enumerate sessions that may have a
   * transcript JSONL on disk.
   */
  distinctSessionIds(): Array<{ sessionId: string; firstObservedAt: string }> {
    const rows = this.db
      .prepare(
        `SELECT session_id, MIN(observed_at) AS first_seen
           FROM attributions
          GROUP BY session_id
          ORDER BY first_seen ASC`,
      )
      .all() as { session_id: string; first_seen: string }[];
    return rows.map((r) => ({ sessionId: r.session_id, firstObservedAt: r.first_seen }));
  }

  /**
   * Inverse of trajectoryOf: which sessions observed this snapshot,
   * with their first and last observation timestamps.
   */
  sessionsAt(snapshotId: string): Array<{ sessionId: string; firstObservedAt: string; lastObservedAt: string }> {
    const rows = this.db
      .prepare(
        `SELECT session_id, MIN(observed_at) AS first_seen, MAX(observed_at) AS last_seen
           FROM attributions
          WHERE snapshot_id = ?
          GROUP BY session_id
          ORDER BY first_seen`,
      )
      .all(snapshotId) as unknown as { session_id: string; first_seen: string; last_seen: string }[];
    return rows.map((r) => ({
      sessionId: r.session_id,
      firstObservedAt: r.first_seen,
      lastObservedAt: r.last_seen,
    }));
  }

  // ── turn_metrics (v0.5.0; spec/format.md §10) ────────────────────────

  /**
   * Insert one TurnRecord row. Idempotent on the (session_id, turn_index)
   * primary key — `INSERT OR IGNORE` so a repeat call with the same
   * (session, index) is a no-op. Returns true when a new row was
   * actually inserted, false when the PK collision short-circuited.
   *
   * Prefer `insertTurnMetricsBatch` for batch ingest — wraps a single
   * transaction around N inserts.
   */
  insertTurnMetric(turn: TurnRecord): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO turn_metrics
           (session_id, turn_index, turn_type, model,
            input_tokens, output_tokens,
            cache_creation_input_tokens, cache_read_input_tokens,
            tool_names_csv, is_sidechain,
            attribution_skill, ingested_at, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        turn.sessionId, turn.turnIndex, turn.turnType, turn.model,
        turn.inputTokens, turn.outputTokens,
        turn.cacheCreationInputTokens, turn.cacheReadInputTokens,
        turn.toolNamesCsv, turn.isSidechain,
        turn.attributionSkill, turn.ingestedAt, turn.requestId,
      );
    return result.changes > 0;
  }

  /**
   * Insert many TurnRecord rows under one transaction. Returns the
   * count of rows that were actually new (INSERT OR IGNORE may
   * silently skip PK collisions). Atomic: a throw mid-batch leaves
   * `turn_metrics` unchanged.
   */
  insertTurnMetricsBatch(turns: ReadonlyArray<TurnRecord>): number {
    if (turns.length === 0) return 0;
    let added = 0;
    tx(this.db, () => {
      for (const t of turns) {
        if (this.insertTurnMetric(t)) added++;
      }
    });
    return added;
  }

  /**
   * Highest stored turn_index for a session, or null if none stored.
   * Caller passes `MAX(turn_index) + 1` (or 0) as the parser's
   * startTurnIndex for idempotent incremental ingest.
   */
  maxTurnIndex(sessionId: string): number | null {
    const row = this.db
      .prepare('SELECT MAX(turn_index) AS m FROM turn_metrics WHERE session_id = ?')
      .get(sessionId) as { m: number | null } | undefined;
    if (row === undefined || row.m === null) return null;
    return row.m;
  }

  /**
   * Read every stored TurnRecord for a session, ordered by turn_index.
   * Empty when the session has not been ingested.
   */
  turnsOf(sessionId: string): TurnRecord[] {
    const rows = this.db
      .prepare(
        `SELECT session_id, turn_index, turn_type, model,
                input_tokens, output_tokens,
                cache_creation_input_tokens, cache_read_input_tokens,
                tool_names_csv, is_sidechain,
                attribution_skill, ingested_at, request_id
           FROM turn_metrics
          WHERE session_id = ?
          ORDER BY turn_index`,
      )
      .all(sessionId) as unknown as TurnMetricsRow[];
    return rows.map(rowToTurnRecord);
  }

  /**
   * Aggregate per-session cost summary. Returns null when no
   * turn_metrics row exists for the session.
   *
   * Token totals sum across assistant turns only (user turns have
   * null tokens; SQL SUM of NULL is 0). `tools` is a parsed roll-up
   * of the comma-separated `tool_names_csv` values — the row form is
   * lossless under (name, count) aggregation.
   *
   * `claudeCodeVersion` is read from the snapshot referenced by the
   * session's earliest attribution row (first-observation-wins per
   * spec/format.md §2.1). Null when the session has no attribution
   * row, or when the snapshot pre-dates v0.5 and has the field NULL.
   */
  sessionCost(sessionId: string): SessionCostSummary | null {
    const agg = this.db
      .prepare(
        `SELECT COUNT(*)                                               AS total_turns,
                SUM(CASE WHEN turn_type='user'      THEN 1 ELSE 0 END) AS user_turns,
                SUM(CASE WHEN turn_type='assistant' THEN 1 ELSE 0 END) AS assistant_turns,
                COALESCE(SUM(input_tokens),                0)          AS input_tokens,
                COALESCE(SUM(output_tokens),               0)          AS output_tokens,
                COALESCE(SUM(cache_creation_input_tokens), 0)          AS cache_creation_input_tokens,
                COALESCE(SUM(cache_read_input_tokens),     0)          AS cache_read_input_tokens
           FROM turn_metrics
          WHERE session_id = ?`,
      )
      .get(sessionId) as
      | {
          total_turns: number;
          user_turns: number;
          assistant_turns: number;
          input_tokens: number;
          output_tokens: number;
          cache_creation_input_tokens: number;
          cache_read_input_tokens: number;
        }
      | undefined;
    if (agg === undefined || agg.total_turns === 0) return null;

    const modelRows = this.db
      .prepare(
        `SELECT DISTINCT model FROM turn_metrics
          WHERE session_id = ? AND model IS NOT NULL
          ORDER BY model`,
      )
      .all(sessionId) as { model: string }[];

    const csvRows = this.db
      .prepare(
        `SELECT tool_names_csv FROM turn_metrics
          WHERE session_id = ? AND tool_names_csv IS NOT NULL`,
      )
      .all(sessionId) as { tool_names_csv: string }[];

    const tools: Record<string, number> = {};
    for (const r of csvRows) {
      for (const name of r.tool_names_csv.split(',')) {
        if (name.length === 0) continue;
        tools[name] = (tools[name] ?? 0) + 1;
      }
    }

    // Pull claudeCodeVersion from the earliest snapshot the session
    // observed. `attributions` is keyed by (session_id, observed_at,
    // event_kind); ORDER BY observed_at, event_kind takes the first
    // — which is the same ordering trajectoryOf() returns.
    const versionRow = this.db
      .prepare(
        `SELECT s.claude_code_version AS v
           FROM attributions a
           JOIN snapshots s ON s.id = a.snapshot_id
          WHERE a.session_id = ?
          ORDER BY a.observed_at, a.event_kind
          LIMIT 1`,
      )
      .get(sessionId) as { v: string | null } | undefined;
    const claudeCodeVersion = versionRow?.v ?? null;

    return {
      sessionId,
      totalTurns: agg.total_turns,
      userTurns: agg.user_turns,
      assistantTurns: agg.assistant_turns,
      models: modelRows.map((r) => r.model),
      inputTokens: agg.input_tokens,
      outputTokens: agg.output_tokens,
      cacheCreationInputTokens: agg.cache_creation_input_tokens,
      cacheReadInputTokens: agg.cache_read_input_tokens,
      tools,
      claudeCodeVersion,
    };
  }

  // ── session_observation_cache (hot-path; not normative) ─────────────

  /**
   * Read the last cached observation result for a session. Returns null
   * when there's no cache entry (first fire of the session, or cache
   * was cleared). Implementation-internal — the cache is never the
   * authoritative source; treat null as "must re-observe."
   */
  readObservationCache(sessionId: string): { fastHash: string; snapshotId: string } | null {
    const row = this.db
      .prepare(
        'SELECT fast_hash, snapshot_id FROM session_observation_cache WHERE session_id = ?',
      )
      .get(sessionId) as { fast_hash: string; snapshot_id: string } | undefined;
    if (!row) return null;
    return { fastHash: row.fast_hash, snapshotId: row.snapshot_id };
  }

  /**
   * Write/replace the per-session cache entry. Must be called AFTER
   * the attribution row is committed (the cache write is best-effort
   * cleanup; if it fails or the process crashes between attribution
   * and cache write, the next fire safely full-captures). Do NOT wrap
   * this in the same transaction as the attribution insert.
   */
  writeObservationCache(sessionId: string, fastHash: string, snapshotId: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO session_observation_cache
           (session_id, fast_hash, snapshot_id, written_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(sessionId, fastHash, snapshotId, new Date().toISOString());
  }

  /**
   * Walk `<harnessDir>/snapshots/`, sync the index with what's on disk.
   * Idempotent: running twice on an unchanged tree produces the same
   * index. The reference operation in spec/format.md §5.2.
   *
   * @throws {IntegrityError} if a blob fails hash verification.
   * @throws {ParseError} on malformed blob JSON.
   */
  reindex(): ReindexResult {
    const onDisk = new Set(listSnapshots(this.harnessDir));
    const indexed = new Set(
      (this.db.prepare('SELECT id FROM snapshots').all() as unknown as { id: string }[]).map(
        (r) => r.id,
      ),
    );

    let added = 0;
    const updated = 0; // reserved; v0.1 doesn't mutate rows in place
    let removed = 0;

    // Wrap the whole sync in one transaction with deferred FK checks:
    // the parent-before-child constraint can't be honored during bulk
    // insert (parents and children may load in any order from disk).
    // Deferring lets all rows land first and the constraint check fires
    // once at COMMIT — a single integrity verdict for the whole batch.
    tx(this.db, () => {
      this.db.exec('PRAGMA defer_foreign_keys = ON');
      for (const id of onDisk) {
        if (indexed.has(id)) continue;
        const blob = readSnapshot(this.harnessDir, id);
        // Use the in-tx helper directly — `insertSnapshot()` would try to
        // open a nested transaction which node:sqlite rejects.
        this._insertSnapshotInTx(blob);
        added++;
      }
      for (const id of indexed) {
        if (!onDisk.has(id)) {
          this.db.prepare('DELETE FROM snapshots WHERE id = ?').run(id);
          removed++;
        }
      }
    });

    this.stampMeta('reindexed_at', new Date().toISOString());
    return { added, updated, removed };
  }

  /** Close the underlying SQLite handle. Call on shutdown / unmount. */
  close(): void {
    this.db.close();
  }

  // ── private ──────────────────────────────────────────────────────────

  private hydrate(row: SnapshotRow): Snapshot {
    const parents = this.db
      .prepare(
        'SELECT parent_id FROM snapshot_parents WHERE child_id = ? ORDER BY parent_index',
      )
      .all(row.id) as unknown as { parent_id: string }[];
    const mods = this.db
      .prepare(
        'SELECT * FROM snapshot_modules WHERE snapshot_id = ? ORDER BY position',
      )
      .all(row.id) as unknown as ModuleRow[];

    const out: Snapshot = {
      id: row.id,
      parentIds: parents.map((p) => p.parent_id),
      branch: row.branch,
      kind: row.kind,
      codePin: row.code_pin,
      apmLockHash: row.apm_lock_hash,
      createdAt: row.created_at,
      formatVersion: row.format_version,
      modules: mods.map(modFromRow),
    };
    if (row.author !== null) out.author = row.author;
    if (row.model !== null) out.model = row.model;
    if (row.permission_mode !== null) out.permissionMode = row.permission_mode;
    if (row.claude_code_version !== null) out.claudeCodeVersion = row.claude_code_version;
    if (row.apm_lockfile !== null) out.apmLockfile = row.apm_lockfile;
    return out;
  }

  private stampMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)')
      .run(key, value);
  }
}

// ── private free functions ───────────────────────────────────────────────

/** Manual transaction wrapper — node:sqlite has no .transaction() higher-order helper. */
function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* swallow rollback failure; surface original */ }
    throw err;
  }
}

function ensureSchema(db: DatabaseSync): void {
  // Detect existing schema by looking for the _schema table.
  const present = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='_schema'",
    )
    .get();

  let have = 0;
  if (present) {
    const row = db.prepare('SELECT version FROM _schema').get() as
      | { version: number }
      | undefined;
    have = row?.version ?? 0;
  }

  // Apply each migration whose `from` matches our current version. The
  // table-of-migrations approach makes adding the next one a one-line
  // entry; no special-cases per version.
  for (const m of SCHEMA_FILES) {
    if (have === m.from) {
      db.exec(readSchemaSql(m.file));
      have = m.to;
    }
  }

  if (!present) {
    // Fresh DB also gets _meta stamped.
    const stamp = db.prepare(
      'INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)',
    );
    stamp.run('format_version', HARNESS_FORMAT_VERSION);
    stamp.run('created_by', WRITER_NAME);
    stamp.run('created_at', new Date().toISOString());
  }

  if (have !== CURRENT_SCHEMA_VERSION) {
    throw new IntegrityError(
      `schema version mismatch after migration: expected ${CURRENT_SCHEMA_VERSION}, got ${have}`,
    );
  }
}

function readSchemaSql(name: string): string {
  const path = locateSchemaFile(name);
  try {
    return readFileSync(path, 'utf-8');
  } catch (cause) {
    throw new IoError(`failed to read schema SQL from ${path}`, cause);
  }
}

/**
 * Walk up from this module's directory looking for `spec/schema/<name>`.
 * Works in monorepo dev (where `spec/` lives at the repo root) and in any
 * environment where the spec directory has been copied alongside the package.
 */
function locateSchemaFile(name: string): string {
  const start = dirname(fileURLToPath(import.meta.url));
  let cur = start;
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(cur, 'spec', 'schema', name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new IoError(
    `could not locate spec/schema/${name} starting from ${start}; in a published package, ship the file alongside dist/`,
  );
}

function suppressNodeSqliteExperimentalWarning(): void {
  // Suppress only the SQLite-experimental warning. Other ExperimentalWarnings
  // still propagate. process.emitWarning is the documented hook.
  const orig = process.emitWarning.bind(process);
  process.emitWarning = ((
    warning: string | Error,
    typeOrOpts?: string | { type?: string; code?: string; ctor?: Function; detail?: string },
    code?: string,
  ): void => {
    const msg = typeof warning === 'string' ? warning : warning.message;
    const type = typeof typeOrOpts === 'string'
      ? typeOrOpts
      : typeOrOpts?.type;
    if (type === 'ExperimentalWarning' && /SQLite is an experimental feature/i.test(msg)) {
      return;
    }
    return orig(warning as string, typeOrOpts as string, code);
  }) as typeof process.emitWarning;
}

interface SnapshotRow {
  id: string;
  branch: string;
  kind: SnapshotKind;
  code_pin: string | null;
  apm_lock_hash: string | null;
  apm_lockfile: string | null;
  author: string | null;
  created_at: string;
  format_version: string;
  model: string | null;
  permission_mode: string | null;
  claude_code_version: string | null;
}

interface AttributionRow {
  session_id: string;
  snapshot_id: string;
  observed_at: string;
  event_kind: string;
  source: string | null;
  note_text: string | null;
}

function rowToAttribution(r: AttributionRow): Attribution {
  return {
    sessionId: r.session_id,
    snapshotId: r.snapshot_id,
    observedAt: r.observed_at,
    eventKind: r.event_kind as AttributionEventKind,
    source: r.source,
    noteText: r.note_text,
  };
}

interface TurnMetricsRow {
  session_id: string;
  turn_index: number;
  turn_type: 'user' | 'assistant';
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  tool_names_csv: string | null;
  is_sidechain: 0 | 1;
  attribution_skill: string | null;
  ingested_at: string;
  request_id: string | null;
}

function rowToTurnRecord(r: TurnMetricsRow): TurnRecord {
  return {
    sessionId: r.session_id,
    turnIndex: r.turn_index,
    turnType: r.turn_type,
    model: r.model,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheCreationInputTokens: r.cache_creation_input_tokens,
    cacheReadInputTokens: r.cache_read_input_tokens,
    toolNamesCsv: r.tool_names_csv,
    isSidechain: r.is_sidechain,
    attributionSkill: r.attribution_skill,
    ingestedAt: r.ingested_at,
    requestId: r.request_id,
  };
}

interface ModuleRow {
  snapshot_id: string;
  position: number;
  type: string;
  name: string;
  version: string | null;
  enabled: number;
  config_hash: string | null;
  source_kind: string;
  source_package: string | null;
  source_resolved_commit: string | null;
  source_depth: number | null;
  source_resolved_by: string | null;
  source_path: string | null;
}

function modFromRow(row: ModuleRow): import('./types.js').Module {
  const m: import('./types.js').Module = {
    type: row.type as import('./types.js').ModuleType,
    name: row.name,
    enabled: row.enabled === 1,
    source: rebuildSource(row),
  };
  if (row.version !== null) m.version = row.version;
  if (row.config_hash !== null) m.configHash = row.config_hash;
  return m;
}

function rebuildSource(row: ModuleRow): import('./types.js').ModuleSource {
  if (row.source_kind === 'builtin') return { kind: 'builtin' };
  if (row.source_kind === 'local') {
    if (row.source_path === null) {
      throw new ParseError(`source_kind=local but source_path is null on row ${row.snapshot_id}/${row.position}`);
    }
    return { kind: 'local', path: row.source_path };
  }
  if (row.source_kind === 'apm') {
    if (
      row.source_package === null ||
      row.source_resolved_commit === null ||
      row.source_depth === null
    ) {
      throw new ParseError(`source_kind=apm but required fields missing on row ${row.snapshot_id}/${row.position}`);
    }
    const out: import('./types.js').ModuleSource = {
      kind: 'apm',
      package: row.source_package,
      resolvedCommit: row.source_resolved_commit,
      depth: row.source_depth,
    };
    if (row.source_resolved_by !== null) {
      (out as { resolvedBy?: string }).resolvedBy = row.source_resolved_by;
    }
    return out;
  }
  if (row.source_kind.startsWith('x-')) {
    return { kind: row.source_kind as `x-${string}` };
  }
  throw new ParseError(`unknown source_kind on row ${row.snapshot_id}/${row.position}: ${row.source_kind}`);
}
