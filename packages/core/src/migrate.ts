// v0.1.x → v0.2.0 data-layer migration.
//
// Schema migrations (001 → 002 → 003) are applied automatically by
// IndexDb.ensureSchema. This module handles the BLOB-layer migration
// the schema can't: re-canonicalize every v0.1.x snapshot under the
// §3.1-stripped derivation, deduplicate compositions that became
// byte-identical after the strip, and rewrite all cross-references
// (parent ids in blobs, refs files, attribution rows, hot-path cache).
//
// Idempotent: running on an already-migrated repo is a no-op
// (returns alreadyMigrated: true). Detects v0.1.x blobs by
// formatVersion === '0.1' (or '0.1.x') OR presence of top-level
// `sessionId`.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import {
  deleteSnapshotBlob,
  listSnapshots,
  readSnapshotRaw,
  writeSnapshot,
} from './blob.js';
import { snapshotId } from './canonical.js';
import { IntegrityError } from './errors.js';
import type { Snapshot, SnapshotKind } from './types.js';

export interface MigrationResult {
  alreadyMigrated: boolean;
  blobsScanned: number;
  blobsRewritten: number;
  duplicatesMerged: number;
  attributionsRewritten: number;
  refsUpdated: number;
}

/**
 * Migrate `<harnessDir>` from v0.1.x blob shape to v0.2.0. The schema
 * must already be at v3 (apply via IndexDb.ensureSchema before calling).
 */
export function migrateV1ToV2(harnessDir: string): MigrationResult {
  // Inspect blobs raw — readSnapshot would throw on hash mismatch for
  // v0.1.x blobs under the new derivation rule.
  const allIds = listSnapshots(harnessDir);
  const v1Blobs: Snapshot[] = [];
  for (const id of allIds) {
    const blob = readSnapshotRaw(harnessDir, id);
    if (isV1Blob(blob)) v1Blobs.push(blob);
  }

  if (v1Blobs.length === 0) {
    return {
      alreadyMigrated: true,
      blobsScanned: allIds.length,
      blobsRewritten: 0,
      duplicatesMerged: 0,
      attributionsRewritten: 0,
      refsUpdated: 0,
    };
  }

  // Topological sort: parents must be remapped before children, since
  // a child's new id depends on its (already-remapped) parent ids.
  const byId = new Map(v1Blobs.map((b) => [b.id, b] as const));
  const order = topoSort(v1Blobs);

  // mapping: old_id → new_id (after re-canonicalize). Multiple old_ids
  // may map to the same new_id (the dedup case).
  const mapping = new Map<string, string>();
  // newBlobs: the v0.2.0 form keyed by new_id (one per unique composition).
  const newBlobs = new Map<string, Snapshot>();
  let duplicatesMerged = 0;

  for (const oldId of order) {
    const old = byId.get(oldId)!;
    const v2 = transformV1ToV2(old, mapping);
    const newId = snapshotId(v2);
    mapping.set(oldId, newId);
    if (!newBlobs.has(newId)) {
      newBlobs.set(newId, { ...v2, id: newId });
    } else {
      duplicatesMerged++;
    }
  }

  // Apply mapping to refs (heads + tags + HEAD if detached).
  let refsUpdated = 0;
  refsUpdated += rewriteRefDir(harnessDir, 'heads', mapping);
  refsUpdated += rewriteRefDir(harnessDir, 'tags', mapping);
  refsUpdated += rewriteHeadIfDetached(harnessDir, mapping);

  // Apply mapping to the index DB BEFORE rewriting blobs on disk.
  // FK-cascading rules require careful ordering — we open with FK off
  // during the bulk rewrite, then re-enable + verify at end.
  const dbPath = join(harnessDir, 'lineage.sqlite');
  let attributionsRewritten = 0;
  if (existsSync(dbPath)) {
    attributionsRewritten = rewriteIndexDb(dbPath, mapping, newBlobs);
  }

  // Rewrite blobs on disk: delete olds, write news at their new paths.
  // (Deletes first so we don't confuse listSnapshots mid-walk if old
  // and new paths happen to share the same <aa> dir. Order is safe
  // because mapping → newBlobs is a closed transformation in memory.)
  let blobsRewritten = 0;
  const v1Ids = new Set(v1Blobs.map((b) => b.id));
  for (const oldId of v1Ids) {
    deleteSnapshotBlob(harnessDir, oldId);
  }
  for (const blob of newBlobs.values()) {
    writeSnapshot(harnessDir, blob);
    blobsRewritten++;
  }

  return {
    alreadyMigrated: false,
    blobsScanned: allIds.length,
    blobsRewritten,
    duplicatesMerged,
    attributionsRewritten,
    refsUpdated,
  };
}

// ── private ────────────────────────────────────────────────────────────────

function isV1Blob(b: Snapshot): boolean {
  const fv = b.formatVersion;
  if (typeof fv === 'string' && (fv === '0.1' || fv.startsWith('0.1.'))) return true;
  if (typeof (b as { sessionId?: unknown }).sessionId === 'string') return true;
  // Legacy kind values are also a v0.1.x signal.
  const k = b.kind as unknown as string;
  if (k === 'auto' || k === 'edit' || k === 'fork') return true;
  return false;
}

function transformV1ToV2(
  blob: Snapshot,
  parentMapping: Map<string, string>,
): Omit<Snapshot, 'id'> {
  const kindMap: Record<string, SnapshotKind> = {
    init: 'init',
    tag: 'tag',
    auto: 'manual',
    edit: 'manual',
    fork: 'manual',
    manual: 'manual',
  };
  const newKind = kindMap[blob.kind as unknown as string] ?? 'manual';
  // Parent ids: remap any v0.1.x parents we've already migrated to
  // their new ids. Untranslated ids fall through unchanged (would
  // indicate a dangling reference — the FK check at the end will catch
  // it).
  const newParents = blob.parentIds.map((p) => parentMapping.get(p) ?? p);
  const out: Omit<Snapshot, 'id'> = {
    formatVersion: '0.2',
    parentIds: newParents,
    branch: blob.branch,
    kind: newKind,
    // v0.1.x blobs always had a string message (the field was required
    // and minLength: 1). v0.2.0 makes it nullable. Preserve whatever
    // the v0.1.x blob carried — it's the user's annotation.
    message: blob.message ?? null,
    codePin: blob.codePin,
    apmLockHash: blob.apmLockHash,
    createdAt: blob.createdAt,
    modules: blob.modules,
  };
  if (blob.version !== undefined && blob.version !== null) out.version = blob.version;
  if (blob.author !== undefined) out.author = blob.author;
  if (blob.model !== undefined) out.model = blob.model;
  if (blob.permissionMode !== undefined) out.permissionMode = blob.permissionMode;
  return out;
}

function topoSort(blobs: Snapshot[]): string[] {
  const blobById = new Map(blobs.map((b) => [b.id, b] as const));
  const visited = new Set<string>();
  const order: string[] = [];
  function visit(id: string): void {
    if (visited.has(id)) return;
    visited.add(id);
    const b = blobById.get(id);
    if (b !== undefined) {
      for (const p of b.parentIds) visit(p);
    }
    order.push(id);
  }
  for (const b of blobs) visit(b.id);
  return order;
}

function rewriteRefDir(
  harnessDir: string,
  kind: 'heads' | 'tags',
  mapping: Map<string, string>,
): number {
  const dir = join(harnessDir, 'refs', kind);
  if (!existsSync(dir)) return 0;
  let updated = 0;
  for (const name of readdirSync(dir, { recursive: true }) as string[]) {
    const path = join(dir, name);
    let content: string;
    try { content = readFileSync(path, 'utf-8'); } catch { continue; }
    const trimmed = content.trim();
    const target = mapping.get(trimmed);
    if (target !== undefined && target !== trimmed) {
      writeFileSync(path, target + '\n', 'utf-8');
      updated++;
    }
  }
  return updated;
}

function rewriteHeadIfDetached(harnessDir: string, mapping: Map<string, string>): number {
  const headPath = join(harnessDir, 'HEAD');
  if (!existsSync(headPath)) return 0;
  const raw = readFileSync(headPath, 'utf-8').trim();
  if (raw.startsWith('ref:')) return 0; // symbolic — no id to remap
  const target = mapping.get(raw);
  if (target !== undefined && target !== raw) {
    writeFileSync(headPath, target + '\n', 'utf-8');
    return 1;
  }
  return 0;
}

function rewriteIndexDb(
  dbPath: string,
  mapping: Map<string, string>,
  newBlobs: Map<string, Snapshot>,
): number {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');

    // 1. Insert all NEW snapshot rows up front — attributions and
    //    cache rows reference snapshot_id by FK, so the new rows must
    //    exist before we rewrite cross-tables.
    const insertSnap = db.prepare(
      `INSERT OR IGNORE INTO snapshots
         (id, branch, kind, message, version, code_pin, apm_lock_hash,
          author, created_at, format_version, model, permission_mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertParent = db.prepare(
      `INSERT OR IGNORE INTO snapshot_parents
         (child_id, parent_id, parent_index)
       VALUES (?, ?, ?)`,
    );
    const insertModule = db.prepare(
      `INSERT OR IGNORE INTO snapshot_modules
         (snapshot_id, position, type, name, version, enabled, config_hash,
          source_kind, source_package, source_resolved_commit, source_depth,
          source_resolved_by, source_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const blob of newBlobs.values()) {
      insertSnap.run(
        blob.id, blob.branch, blob.kind, blob.message, blob.version ?? null,
        blob.codePin, blob.apmLockHash,
        blob.author ?? null, blob.createdAt, blob.formatVersion ?? '0.2',
        blob.model ?? null, blob.permissionMode ?? null,
      );
      blob.parentIds.forEach((pid, i) => insertParent.run(blob.id, pid, i));
      blob.modules.forEach((m, i) => {
        const src = m.source;
        insertModule.run(
          blob.id, i, m.type, m.name, m.version ?? null,
          m.enabled ? 1 : 0, m.configHash ?? null,
          src.kind,
          src.kind === 'apm' ? src.package : null,
          src.kind === 'apm' ? src.resolvedCommit : null,
          src.kind === 'apm' ? src.depth : null,
          src.kind === 'apm' ? (('resolvedBy' in src && typeof src.resolvedBy === 'string') ? src.resolvedBy : null) : null,
          src.kind === 'local' ? src.path : null,
        );
      });
    }

    // 2. Rewrite attributions.snapshot_id via mapping. Old blobs may
    //    have been merged (multiple old_ids → one new_id), so multiple
    //    attribution rows could collide on the new row's PK; INSERT
    //    OR IGNORE on a copy approach handles this.
    const oldAttrs = db
      .prepare(
        'SELECT session_id, snapshot_id, observed_at, event_kind, source FROM attributions',
      )
      .all() as Array<{ session_id: string; snapshot_id: string; observed_at: string; event_kind: string; source: string | null }>;
    db.exec('DELETE FROM attributions');
    const reinsertAttr = db.prepare(
      `INSERT OR IGNORE INTO attributions
         (session_id, snapshot_id, observed_at, event_kind, source)
       VALUES (?, ?, ?, ?, ?)`,
    );
    let attrCount = 0;
    for (const a of oldAttrs) {
      const newSnap = mapping.get(a.snapshot_id) ?? a.snapshot_id;
      reinsertAttr.run(a.session_id, newSnap, a.observed_at, a.event_kind, a.source);
      attrCount++;
    }

    // 3. Drop the OLD snapshot rows + their dependents. With
    //    foreign_keys=OFF (we set this above), the FK cascade does NOT
    //    fire automatically, so we delete manually from each child
    //    table before deleting from snapshots. This is safe because
    //    new rows inserted in step 1 are at the NEW ids, so old-id
    //    deletions can't touch them.
    const dropParentsByChild = db.prepare('DELETE FROM snapshot_parents WHERE child_id = ?');
    const dropParentsByParent = db.prepare('DELETE FROM snapshot_parents WHERE parent_id = ?');
    const dropModules = db.prepare('DELETE FROM snapshot_modules WHERE snapshot_id = ?');
    const dropCache = db.prepare('DELETE FROM session_observation_cache WHERE snapshot_id = ?');
    const dropSnap = db.prepare('DELETE FROM snapshots WHERE id = ?');
    for (const oldId of mapping.keys()) {
      // Skip olds that survived the mapping unchanged (would also be
      // in newBlobs under the same id — identity rewrite).
      if (newBlobs.has(oldId)) continue;
      dropParentsByChild.run(oldId);
      dropParentsByParent.run(oldId);
      dropModules.run(oldId);
      dropCache.run(oldId);
      dropSnap.run(oldId);
    }

    // 4. Stamp _meta with new format version.
    db.prepare(
      'INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)',
    ).run('format_version', '0.2');
    db.prepare(
      'INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)',
    ).run('migrated_at', new Date().toISOString());

    // 5. Verify FK integrity before commit.
    const fkErrors = db.prepare('PRAGMA foreign_key_check').all() as Array<unknown>;
    if (fkErrors.length > 0) {
      db.exec('ROLLBACK');
      throw new IntegrityError(
        `migration produced ${fkErrors.length} FK violation(s); aborted`,
      );
    }
    db.exec('COMMIT');
    db.exec('PRAGMA foreign_keys = ON');
    return attrCount;
  } finally {
    db.close();
  }
}
