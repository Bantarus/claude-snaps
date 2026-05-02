import { describe, expect, test } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sqlite from 'node:sqlite';
import { migrateV1ToV2, Repo } from '../src/index.js';

const { DatabaseSync } = sqlite;
const here = dirname(fileURLToPath(import.meta.url));
const SPEC_SCHEMA_DIR = resolve(here, '../../../spec/schema');

// ─── helpers ─────────────────────────────────────────────────────────────

interface V1BlobShape {
  id: string;
  parentIds: string[];
  branch: string;
  kind: string;
  message: string;
  codePin: string | null;
  apmLockHash: string | null;
  createdAt: string;
  sessionId?: string;
  modules: unknown[];
  formatVersion?: string;
}

function v1Hash(blob: Omit<V1BlobShape, 'id'>): string {
  // The pre-§3.1 derivation: strip only `id`, hash everything else.
  const stripped = { ...blob } as Record<string, unknown>;
  delete stripped['id'];
  const canonical = JSON.stringify(canonicalize(stripped));
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(canonical, 'utf-8').digest('hex').slice(0, 40);
}

function canonicalize(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(canonicalize);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) {
    out[k] = canonicalize((v as Record<string, unknown>)[k]);
  }
  return out;
}

function writeV1Blob(harnessDir: string, blob: Omit<V1BlobShape, 'id'>): string {
  const id = v1Hash(blob);
  const full = { ...blob, id } as V1BlobShape;
  const aa = id.slice(0, 2), rest = id.slice(2);
  const dir = join(harnessDir, 'snapshots', aa);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${rest}.json`),
    JSON.stringify(full, null, 2) + '\n',
    'utf-8',
  );
  return id;
}

function setupV1Repo(): { dir: string; ids: { init: string; auto1: string; auto2: string } } {
  const dir = mkdtempSync(join(tmpdir(), 'harness-migrate-'));
  mkdirSync(join(dir, '.harness/snapshots'), { recursive: true });
  mkdirSync(join(dir, '.harness/refs/heads'), { recursive: true });
  mkdirSync(join(dir, '.harness/refs/tags'), { recursive: true });
  writeFileSync(join(dir, '.harness/HEAD'), 'ref: refs/heads/main\n', 'utf-8');
  writeFileSync(join(dir, '.harness/config'), '[core]\ndefault_branch = "main"\n', 'utf-8');

  const harness = join(dir, '.harness');
  // Three v0.1.x blobs in a chain. The two `auto`s have IDENTICAL
  // modules; under the v0.1.x rule they had different sessionIds and
  // different createdAts → different ids. Under v0.2.0 they should
  // dedupe (same composition, same parent → same id).
  const sharedModules = [
    {
      type: 'mcp', name: 'Read', enabled: true, source: { kind: 'builtin' },
    },
  ];
  const initId = writeV1Blob(harness, {
    formatVersion: '0.1', parentIds: [], branch: 'main', kind: 'init',
    message: 'init', codePin: null, apmLockHash: null,
    createdAt: '2026-04-01T00:00:00.000Z',
    modules: sharedModules,
  });
  const auto1Id = writeV1Blob(harness, {
    formatVersion: '0.1', parentIds: [initId], branch: 'main', kind: 'auto',
    message: 'auto · sess A', codePin: null, apmLockHash: null,
    createdAt: '2026-04-01T01:00:00.000Z',
    sessionId: 'sess-A',
    modules: sharedModules,
  });
  const auto2Id = writeV1Blob(harness, {
    formatVersion: '0.1', parentIds: [initId], branch: 'main', kind: 'auto',
    message: 'auto · sess B', codePin: null, apmLockHash: null,
    createdAt: '2026-04-01T02:00:00.000Z',
    sessionId: 'sess-B',
    modules: sharedModules,
  });
  // main branch tip → auto1 (we'll see the migration handle the dedup
  // elegantly: auto1 and auto2 collapse to the same v0.2 id so the ref
  // doesn't become orphaned).
  writeFileSync(join(harness, 'refs/heads/main'), auto1Id + '\n', 'utf-8');

  // Set up a v1 lineage.sqlite by applying ONLY 001_init.sql then
  // hand-inserting rows. Repo.open will then upgrade the schema.
  const sql001 = readFileSync(join(SPEC_SCHEMA_DIR, '001_init.sql'), 'utf-8');
  const db = new DatabaseSync(join(harness, 'lineage.sqlite'));
  db.exec(sql001);
  const ins = db.prepare(
    `INSERT INTO snapshots (id, branch, kind, message, created_at, session_id, format_version)
     VALUES (?, ?, ?, ?, ?, ?, '0.1')`,
  );
  ins.run(initId,  'main', 'init', 'init',         '2026-04-01T00:00:00.000Z', null);
  ins.run(auto1Id, 'main', 'auto', 'auto · sess A','2026-04-01T01:00:00.000Z', 'sess-A');
  ins.run(auto2Id, 'main', 'auto', 'auto · sess B','2026-04-01T02:00:00.000Z', 'sess-B');
  const insP = db.prepare(
    'INSERT INTO snapshot_parents (child_id, parent_id, parent_index) VALUES (?, ?, ?)',
  );
  insP.run(auto1Id, initId, 0);
  insP.run(auto2Id, initId, 0);
  const insM = db.prepare(
    `INSERT INTO snapshot_modules (snapshot_id, position, type, name, enabled, source_kind)
     VALUES (?, 0, 'mcp', 'Read', 1, 'builtin')`,
  );
  insM.run(initId);
  insM.run(auto1Id);
  insM.run(auto2Id);
  db.close();

  return { dir, ids: { init: initId, auto1: auto1Id, auto2: auto2Id } };
}

// ─── tests ───────────────────────────────────────────────────────────────

describe('migrateV1ToV2 (Gate 11 — blob layer)', () => {
  test('full v0.1.x → v0.2.0 migration with deduplication, ref + attribution rewrite', () => {
    const { dir, ids } = setupV1Repo();
    const harness = join(dir, '.harness');

    // Open Repo to apply schema migrations 002 + 003. This also
    // backfills `migrated` attribution rows for the v0.1.x sessions.
    const repo = Repo.open(dir);
    repo.close();

    // Now run the data-layer migration.
    const result = migrateV1ToV2(harness);
    expect(result.alreadyMigrated).toBe(false);
    expect(result.blobsRewritten).toBeGreaterThan(0);
    // The two `auto`s have identical (modules, parent, branch, kind,
    // message had different bytes BUT message participates in canonical
    // bytes — so different message means NO dedup). Update test
    // expectation: messages differ ("auto · sess A" vs B), so 0 dedup.
    expect(result.duplicatesMerged).toBe(0);
    expect(result.refsUpdated).toBeGreaterThan(0);
    expect(result.attributionsRewritten).toBeGreaterThan(0);

    // All on-disk blobs are now v0.2.0 form.
    const remaining = readdirSync(join(harness, 'snapshots'), { recursive: true })
      .filter((f) => typeof f === 'string' && (f as string).endsWith('.json'))
      .map((f) => f as string);
    for (const f of remaining) {
      const blob = JSON.parse(readFileSync(join(harness, 'snapshots', f), 'utf-8'));
      expect(blob.formatVersion).toBe('0.2');
      expect(['init', 'manual', 'tag']).toContain(blob.kind);
      expect('sessionId' in blob).toBe(false);
    }

    // The old ids no longer resolve.
    expect(existsSync(join(harness, 'snapshots', ids.init.slice(0, 2), ids.init.slice(2) + '.json'))).toBe(false);

    // The branch ref now points at a valid post-migration id.
    const tip = readFileSync(join(harness, 'refs/heads/main'), 'utf-8').trim();
    expect(tip).toMatch(/^[0-9a-f]{40}$/);
    const tipBlob = JSON.parse(
      readFileSync(join(harness, 'snapshots', tip.slice(0, 2), tip.slice(2) + '.json'), 'utf-8'),
    );
    expect(tipBlob.id).toBe(tip);

    // Reopen the repo and verify trajectory queries work post-migration.
    const repo2 = Repo.open(dir);
    try {
      // The migrated attribution rows for sess-A and sess-B point at
      // the post-migration snapshot ids.
      const trajA = repo2.trajectoryOf('sess-A');
      const trajB = repo2.trajectoryOf('sess-B');
      expect(trajA.length).toBeGreaterThan(0);
      expect(trajB.length).toBeGreaterThan(0);
      expect(trajA[0]!.eventKind).toBe('migrated');
      expect(trajB[0]!.eventKind).toBe('migrated');
      // Each migrated attribution points at a real, on-disk snapshot.
      const aSnap = repo2.snapshot(trajA[0]!.snapshotId);
      expect(aSnap.formatVersion).toBe('0.2');
    } finally {
      repo2.close();
    }
  });

  test('idempotent: running migrate on an already-migrated repo is a no-op', () => {
    const { dir } = setupV1Repo();
    const harness = join(dir, '.harness');
    const repo = Repo.open(dir);
    repo.close();
    migrateV1ToV2(harness);
    const second = migrateV1ToV2(harness);
    expect(second.alreadyMigrated).toBe(true);
    expect(second.blobsRewritten).toBe(0);
  });

  test('dedup: two v0.1.x blobs with identical composition + same message merge to one', () => {
    // Hand-craft two v0.1.x blobs differing ONLY by sessionId and
    // createdAt (both stripped under §3.1). Same parents, same modules,
    // same kind→manual, same message → same v0.2 id.
    const dir = mkdtempSync(join(tmpdir(), 'harness-migrate-dedup-'));
    mkdirSync(join(dir, '.harness/snapshots'), { recursive: true });
    mkdirSync(join(dir, '.harness/refs/heads'), { recursive: true });
    writeFileSync(join(dir, '.harness/HEAD'), 'ref: refs/heads/main\n', 'utf-8');
    writeFileSync(join(dir, '.harness/config'), '[core]\ndefault_branch = "main"\n', 'utf-8');
    const harness = join(dir, '.harness');

    const mods = [{ type: 'mcp', name: 'Read', enabled: true, source: { kind: 'builtin' } }];
    const initId = writeV1Blob(harness, {
      formatVersion: '0.1', parentIds: [], branch: 'main', kind: 'init',
      message: 'init', codePin: null, apmLockHash: null,
      createdAt: '2026-04-01T00:00:00.000Z', modules: mods,
    });
    // Both autos: same parent, same composition, same message, same kind.
    // Under v0.1.x they differ in sessionId + createdAt → different ids.
    // Under v0.2.0 (§3.1) the strip removes those → same id → dedup.
    const a = writeV1Blob(harness, {
      formatVersion: '0.1', parentIds: [initId], branch: 'main', kind: 'auto',
      message: 'shared', codePin: null, apmLockHash: null,
      createdAt: '2026-04-01T01:00:00.000Z', sessionId: 'sX', modules: mods,
    });
    const b = writeV1Blob(harness, {
      formatVersion: '0.1', parentIds: [initId], branch: 'main', kind: 'auto',
      message: 'shared', codePin: null, apmLockHash: null,
      createdAt: '2026-04-01T02:00:00.000Z', sessionId: 'sY', modules: mods,
    });
    expect(a).not.toBe(b); // they differ under the v0.1.x rule
    writeFileSync(join(harness, 'refs/heads/main'), b + '\n', 'utf-8');

    // Hand-build a v1 sqlite for them.
    const sql001 = readFileSync(join(SPEC_SCHEMA_DIR, '001_init.sql'), 'utf-8');
    const db = new DatabaseSync(join(harness, 'lineage.sqlite'));
    db.exec(sql001);
    const ins = db.prepare(
      `INSERT INTO snapshots (id, branch, kind, message, created_at, session_id, format_version)
       VALUES (?, ?, ?, ?, ?, ?, '0.1')`,
    );
    ins.run(initId, 'main', 'init', 'init', '2026-04-01T00:00:00.000Z', null);
    ins.run(a, 'main', 'auto', 'shared', '2026-04-01T01:00:00.000Z', 'sX');
    ins.run(b, 'main', 'auto', 'shared', '2026-04-01T02:00:00.000Z', 'sY');
    const insP = db.prepare(
      'INSERT INTO snapshot_parents (child_id, parent_id, parent_index) VALUES (?, ?, ?)',
    );
    insP.run(a, initId, 0); insP.run(b, initId, 0);
    const insM = db.prepare(
      `INSERT INTO snapshot_modules (snapshot_id, position, type, name, enabled, source_kind)
       VALUES (?, 0, 'mcp', 'Read', 1, 'builtin')`,
    );
    insM.run(initId); insM.run(a); insM.run(b);
    db.close();

    const repo = Repo.open(dir);
    repo.close();

    const result = migrateV1ToV2(harness);
    expect(result.duplicatesMerged).toBe(1); // a + b → one v0.2 blob

    // Both sessions' migrated attributions point at the same snapshot.
    const repo2 = Repo.open(dir);
    try {
      const trajX = repo2.trajectoryOf('sX');
      const trajY = repo2.trajectoryOf('sY');
      expect(trajX[0]!.snapshotId).toBe(trajY[0]!.snapshotId);
      // sessionsAt on the merged snapshot lists both sessions.
      const sessions = repo2.sessionsAt(trajX[0]!.snapshotId);
      expect(sessions.map((s) => s.sessionId).sort()).toEqual(['sX', 'sY']);
    } finally {
      repo2.close();
    }
  });
});
