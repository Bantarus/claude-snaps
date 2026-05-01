import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSnapshots, readSnapshot } from './blob.js';
import { IntegrityError, IoError, ParseError } from './errors.js';
import type { Snapshot, SnapshotKind } from './types.js';

// Per spec/format.md §5.2 the schema file is canonical — implementations
// MUST execute it verbatim. We read it from spec/schema/001_init.sql at
// runtime; we do NOT inline it as a TS string. Inlining would create
// two sources of truth that drift.

const SCHEMA_FILENAME = '001_init.sql';
const CURRENT_SCHEMA_VERSION = 1;
const HARNESS_FORMAT_VERSION = '0.1';
const WRITER_NAME = '@harness/core@0.1.0';

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
           (id, branch, kind, message, version, code_pin, apm_lock_hash,
            session_id, author, created_at, format_version,
            model, permission_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snap.id, snap.branch, snap.kind, snap.message, snap.version ?? null,
        snap.codePin, snap.apmLockHash, snap.sessionId ?? null,
        snap.author ?? null, snap.createdAt,
        snap.formatVersion ?? HARNESS_FORMAT_VERSION,
        snap.model ?? null, snap.permissionMode ?? null,
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

  /** Find the snapshot whose `session_id` matches, or null. Used by the hook for idempotency. */
  findSnapshotBySessionId(sessionId: string): Snapshot | null {
    const row = this.db
      .prepare('SELECT * FROM snapshots WHERE session_id = ? LIMIT 1')
      .get(sessionId) as unknown as SnapshotRow | undefined;
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
      message: row.message,
      codePin: row.code_pin,
      apmLockHash: row.apm_lock_hash,
      createdAt: row.created_at,
      formatVersion: row.format_version,
      modules: mods.map(modFromRow),
    };
    if (row.version !== null) out.version = row.version;
    if (row.session_id !== null) out.sessionId = row.session_id;
    if (row.author !== null) out.author = row.author;
    if (row.model !== null) out.model = row.model;
    if (row.permission_mode !== null) out.permissionMode = row.permission_mode;
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

  if (!present) {
    const sql = readSchemaSql();
    db.exec(sql);
    const stamp = db.prepare(
      'INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)',
    );
    stamp.run('format_version', HARNESS_FORMAT_VERSION);
    stamp.run('created_by', WRITER_NAME);
    stamp.run('created_at', new Date().toISOString());
    return;
  }

  const row = db.prepare('SELECT version FROM _schema').get() as
    | { version: number }
    | undefined;
  if (row?.version !== CURRENT_SCHEMA_VERSION) {
    throw new IntegrityError(
      `schema version mismatch: expected ${CURRENT_SCHEMA_VERSION}, got ${row?.version ?? 'none'}`,
    );
  }
}

function readSchemaSql(): string {
  const path = locateSchemaFile();
  try {
    return readFileSync(path, 'utf-8');
  } catch (cause) {
    throw new IoError(`failed to read schema SQL from ${path}`, cause);
  }
}

/**
 * Walk up from this module's directory looking for `spec/schema/001_init.sql`.
 * Works in monorepo dev (where `spec/` lives at the repo root) and in any
 * environment where the spec directory has been copied alongside the package.
 */
function locateSchemaFile(): string {
  const start = dirname(fileURLToPath(import.meta.url));
  let cur = start;
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(cur, 'spec', 'schema', SCHEMA_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new IoError(
    `could not locate spec/schema/${SCHEMA_FILENAME} starting from ${start}; in a published package, ship the file alongside dist/`,
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
  message: string;
  version: string | null;
  code_pin: string | null;
  apm_lock_hash: string | null;
  session_id: string | null;
  author: string | null;
  created_at: string;
  format_version: string;
  model: string | null;
  permission_mode: string | null;
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
