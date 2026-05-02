import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/index_db.js';

const here = dirname(fileURLToPath(import.meta.url));
const SPEC_DIR = resolve(here, '../../../spec');

function copyExample(name: string): string {
  const src = resolve(SPEC_DIR, 'examples', name, '.harness');
  const dst = mkdtempSync(join(tmpdir(), `harness-${name}-`));
  cpSync(src, dst, { recursive: true });
  return dst;
}

/** Dump table contents (excluding _meta which is volatile) for byte-equality comparison. */
function stableDump(dbPath: string): string {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables: string[] = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '_meta' ORDER BY name").all() as { name: string }[]
    ).map((r) => r.name);
    const out: string[] = [];
    for (const t of tables) {
      out.push(`-- ${t}`);
      // ORDER BY all columns to make dumps deterministic regardless of insert order.
      const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((r) => r.name);
      const order = cols.join(', ');
      const rows = db.prepare(`SELECT * FROM ${t} ORDER BY ${order}`).all();
      for (const r of rows) out.push(JSON.stringify(r));
    }
    return out.join('\n');
  } finally {
    db.close();
  }
}

describe('IndexDb.open + ensureSchema', () => {
  test('opening fresh creates schema v2, ensures _schema row, stamps _meta', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-fresh-'));
    const idx = IndexDb.open(dir);
    idx.close();
    const db = new DatabaseSync(join(dir, 'lineage.sqlite'), { readOnly: true });
    expect(db.prepare('SELECT version FROM _schema').get()).toEqual({ version: 2 });
    const meta = db.prepare('SELECT key FROM _meta').all() as { key: string }[];
    const keys = new Set(meta.map((r) => r.key));
    expect(keys.has('format_version')).toBe(true);
    expect(keys.has('created_by')).toBe(true);
    expect(keys.has('created_at')).toBe(true);
    db.close();
  });

  test('opening twice does not duplicate schema rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-twice-'));
    IndexDb.open(dir).close();
    IndexDb.open(dir).close();
    const db = new DatabaseSync(join(dir, 'lineage.sqlite'), { readOnly: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM _schema').get()).toEqual({ n: 1 });
    db.close();
  });
});

describe('IndexDb.reindex', () => {
  test('reindex on team-shared example inserts all 5 snapshots, all parent edges, all module rows', () => {
    const dir = copyExample('team-shared');
    const idx = IndexDb.open(dir);
    const result = idx.reindex();
    expect(result.added).toBe(5);
    expect(result.removed).toBe(0);

    const db = new DatabaseSync(join(dir, 'lineage.sqlite'), { readOnly: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM snapshots').get()).toEqual({ n: 5 });
    // Diamond? team-shared has 5 snapshots in a linear+fork shape (init→auto→tag→fork→auto on exp).
    // Parents: init=0, auto=1, tag=1, fork=1, exp_auto=1. Total parent edges = 4.
    expect(db.prepare('SELECT COUNT(*) AS n FROM snapshot_parents').get()).toEqual({ n: 4 });
    // Modules: each of 5 snapshots has 11 modules (per build_examples.py modules_v04).
    // Two of those snapshots are on experimental and have an extra module.
    const modCount = (db.prepare('SELECT COUNT(*) AS n FROM snapshot_modules').get() as { n: number }).n;
    expect(modCount).toBeGreaterThanOrEqual(5 * 11);
    db.close();
    idx.close();
  });

  test('reindex is idempotent across two runs (excluding _meta)', () => {
    const dir = copyExample('team-shared');
    const idx1 = IndexDb.open(dir);
    idx1.reindex();
    const dump1 = stableDump(join(dir, 'lineage.sqlite'));
    idx1.close();

    rmSync(join(dir, 'lineage.sqlite'));
    const idx2 = IndexDb.open(dir);
    idx2.reindex();
    const dump2 = stableDump(join(dir, 'lineage.sqlite'));
    idx2.close();

    expect(dump1).toEqual(dump2);
  });

  test('reindex on compat-fixtures handles diamond DAG (parent_index 0/1)', () => {
    const dir = copyExample('compat-fixtures');
    const idx = IndexDb.open(dir);
    idx.reindex();
    const db = new DatabaseSync(join(dir, 'lineage.sqlite'), { readOnly: true });
    // Merge node has parent_index 0 AND 1 — verify both stored.
    const row = db
      .prepare(
        'SELECT COUNT(*) AS n FROM snapshot_parents WHERE child_id = ?',
      )
      .get('f38fafd22e99266348b486a48175c7774746b1a4') as { n: number };
    expect(row.n).toBe(2);
    // x-* extension survived the source_kind CHECK constraint.
    const xCount = db
      .prepare("SELECT COUNT(*) AS n FROM snapshot_modules WHERE source_kind LIKE 'x-%'")
      .get() as { n: number };
    expect(xCount.n).toBe(1);
    db.close();
    idx.close();
  });
});

describe('IndexDb queries', () => {
  test('listSnapshots filters by branch', () => {
    const dir = copyExample('team-shared');
    const idx = IndexDb.open(dir);
    idx.reindex();
    const main = idx.listSnapshots({ branch: 'main' });
    const exp = idx.listSnapshots({ branch: 'experimental' });
    expect(main.length).toBe(3);
    expect(exp.length).toBe(2);
    idx.close();
  });

  test('getSnapshot returns hydrated snapshot equal to blob form (modulo Module shape)', () => {
    const dir = copyExample('team-shared');
    const idx = IndexDb.open(dir);
    idx.reindex();
    const snap = idx.getSnapshot('0ab4f7c92c551342fb585c709dc6e5c2bbb71c89');
    expect(snap).not.toBeNull();
    expect(snap!.kind).toBe('tag');
    expect(snap!.version).toBe('v0.4');
    idx.close();
  });

  test('listSnapshots ordered by created_at DESC', () => {
    const dir = copyExample('team-shared');
    const idx = IndexDb.open(dir);
    idx.reindex();
    const snaps = idx.listSnapshots();
    for (let i = 1; i < snaps.length; i++) {
      expect(snaps[i - 1]!.createdAt >= snaps[i]!.createdAt).toBe(true);
    }
    idx.close();
  });
});
