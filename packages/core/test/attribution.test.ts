import { describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sqlite from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Repo } from '../src/index.js';
import { InvalidStateError } from '../src/errors.js';

const { DatabaseSync } = sqlite;
const here = dirname(fileURLToPath(import.meta.url));
const SPEC_SCHEMA_DIR = resolve(here, '../../../spec/schema');

// ─── helpers ─────────────────────────────────────────────────────────────

function setupProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-attr-'));
  mkdirSync(join(dir, '.claude/skills/research'), { recursive: true });
  writeFileSync(join(dir, '.claude/skills/research/SKILL.md'), '# Research\n', 'utf-8');
  writeFileSync(join(dir, 'CLAUDE.md'), '# Project rules\n', 'utf-8');
  return dir;
}

function addSkill(dir: string, name: string): void {
  mkdirSync(join(dir, `.claude/skills/${name}`), { recursive: true });
  writeFileSync(join(dir, `.claude/skills/${name}/SKILL.md`), `# ${name}\n`, 'utf-8');
}

// ─── observe(): change-path and no-change-path ───────────────────────────

describe('Repo.observe — composition-change detection (Gate 13)', () => {
  test('first observe on empty repo writes init snapshot + session_start attribution', () => {
    const proj = setupProject();
    const repo = Repo.init(proj);
    try {
      const id = repo.observe({
        sessionId: 'sess-1',
        eventKind: 'session_start',
        source: 'startup',
        now: '2026-05-02T12:00:00.000Z',
      });
      expect(id).toMatch(/^[0-9a-f]{40}$/);

      const snap = repo.snapshot(id);
      expect(snap.kind).toBe('init');
      expect(snap.parentIds).toEqual([]);
      expect(snap.modules.length).toBeGreaterThan(0);

      const trajectory = repo.trajectoryOf('sess-1');
      expect(trajectory).toHaveLength(1);
      expect(trajectory[0]).toEqual({
        sessionId: 'sess-1',
        snapshotId: id,
        observedAt: '2026-05-02T12:00:00.000Z',
        eventKind: 'session_start',
        source: 'startup',
        noteText: null,
      });

      // Branch ref advanced.
      expect(repo.branchTip('main')).toBe(id);
    } finally {
      repo.close();
    }
  });

  test('second observe with no composition change reuses snapshot, appends attribution', () => {
    const proj = setupProject();
    const repo = Repo.init(proj);
    try {
      const id1 = repo.observe({
        sessionId: 'sess-1', eventKind: 'session_start', source: 'startup',
        now: '2026-05-02T12:00:00.000Z',
      });
      const id2 = repo.observe({
        sessionId: 'sess-1', eventKind: 'user_prompt',
        now: '2026-05-02T12:01:00.000Z',
      });
      expect(id2).toBe(id1); // same composition → same id
      expect(repo.listSnapshotIds()).toHaveLength(1); // no new blob written

      const trajectory = repo.trajectoryOf('sess-1');
      expect(trajectory).toHaveLength(2);
      expect(trajectory.map((t) => t.eventKind)).toEqual(['session_start', 'user_prompt']);
      // Branch ref didn't move.
      expect(repo.branchTip('main')).toBe(id1);
    } finally {
      repo.close();
    }
  });

  test('observe after composition change writes new snapshot, advances branch', () => {
    const proj = setupProject();
    const repo = Repo.init(proj);
    try {
      const id1 = repo.observe({
        sessionId: 'sess-1', eventKind: 'session_start', source: 'startup',
        now: '2026-05-02T12:00:00.000Z',
      });
      // Change composition: add a skill.
      addSkill(proj, 'summarize');
      const id2 = repo.observe({
        sessionId: 'sess-1', eventKind: 'user_prompt',
        now: '2026-05-02T12:05:00.000Z',
      });
      expect(id2).not.toBe(id1);
      expect(repo.listSnapshotIds()).toHaveLength(2);
      expect(repo.branchTip('main')).toBe(id2);

      const snap2 = repo.snapshot(id2);
      expect(snap2.kind).toBe('auto');
      expect(snap2.parentIds).toEqual([id1]);

      const trajectory = repo.trajectoryOf('sess-1');
      expect(trajectory.map((t) => t.snapshotId)).toEqual([id1, id2]);
    } finally {
      repo.close();
    }
  });

  test('trajectory across 3 snapshots × 5 events returns ordered events (success criterion)', () => {
    const proj = setupProject();
    const repo = Repo.init(proj);
    try {
      // 3 distinct compositions
      const idA = repo.observe({
        sessionId: 'sess-traj', eventKind: 'session_start', source: 'startup',
        now: '2026-05-02T12:00:00.000Z',
      });
      const idA2 = repo.observe({
        sessionId: 'sess-traj', eventKind: 'user_prompt',
        now: '2026-05-02T12:01:00.000Z',
      });
      addSkill(proj, 'summarize');
      const idB = repo.observe({
        sessionId: 'sess-traj', eventKind: 'user_prompt',
        now: '2026-05-02T12:02:00.000Z',
      });
      addSkill(proj, 'plan');
      const idC = repo.observe({
        sessionId: 'sess-traj', eventKind: 'user_prompt',
        now: '2026-05-02T12:03:00.000Z',
      });
      const idC2 = repo.observe({
        sessionId: 'sess-traj', eventKind: 'user_prompt',
        now: '2026-05-02T12:04:00.000Z',
      });

      // 3 unique snapshots (idA == idA2; idC == idC2)
      expect(idA).toBe(idA2);
      expect(idC).toBe(idC2);
      expect(new Set([idA, idB, idC]).size).toBe(3);

      const traj = repo.trajectoryOf('sess-traj');
      expect(traj).toHaveLength(5);
      expect(traj.map((t) => t.snapshotId)).toEqual([idA, idA, idB, idC, idC]);
      expect(traj.map((t) => t.observedAt)).toEqual([
        '2026-05-02T12:00:00.000Z',
        '2026-05-02T12:01:00.000Z',
        '2026-05-02T12:02:00.000Z',
        '2026-05-02T12:03:00.000Z',
        '2026-05-02T12:04:00.000Z',
      ]);
    } finally {
      repo.close();
    }
  });

  test('idempotent: same (sessionId, observedAt, eventKind) collapses to 1 row', () => {
    const proj = setupProject();
    const repo = Repo.init(proj);
    try {
      const t = '2026-05-02T12:00:00.000Z';
      repo.observe({ sessionId: 'sess-1', eventKind: 'session_start', source: 'startup', now: t });
      repo.observe({ sessionId: 'sess-1', eventKind: 'session_start', source: 'startup', now: t });
      const traj = repo.trajectoryOf('sess-1');
      expect(traj).toHaveLength(1);
    } finally {
      repo.close();
    }
  });

  test('detached HEAD: observe() throws InvalidStateError', () => {
    const proj = setupProject();
    const repo = Repo.init(proj);
    try {
      repo.observe({ sessionId: 'sess-1', eventKind: 'session_start', source: 'startup' });
      // Detach HEAD by writing the snapshot id directly.
      const id = repo.resolveHead()!;
      writeFileSync(join(proj, '.harness/HEAD'), id + '\n', 'utf-8');
      expect(() => repo.observe({
        sessionId: 'sess-2', eventKind: 'session_start', source: 'startup',
      })).toThrowError(InvalidStateError);
    } finally {
      repo.close();
    }
  });
});

describe('Repo.sessionsAt', () => {
  test('returns one row per session that observed the snapshot, with first/last timestamps', () => {
    const proj = setupProject();
    const repo = Repo.init(proj);
    try {
      const id = repo.observe({
        sessionId: 'sess-A', eventKind: 'session_start', source: 'startup',
        now: '2026-05-02T12:00:00.000Z',
      });
      repo.observe({
        sessionId: 'sess-A', eventKind: 'user_prompt',
        now: '2026-05-02T12:05:00.000Z',
      });
      repo.observe({
        sessionId: 'sess-B', eventKind: 'session_start', source: 'startup',
        now: '2026-05-02T13:00:00.000Z',
      });

      const sessions = repo.sessionsAt(id);
      expect(sessions).toHaveLength(2);
      const a = sessions.find((s) => s.sessionId === 'sess-A')!;
      expect(a.firstObservedAt).toBe('2026-05-02T12:00:00.000Z');
      expect(a.lastObservedAt).toBe('2026-05-02T12:05:00.000Z');
      const b = sessions.find((s) => s.sessionId === 'sess-B')!;
      expect(b.firstObservedAt).toBe('2026-05-02T13:00:00.000Z');
      expect(b.lastObservedAt).toBe('2026-05-02T13:00:00.000Z');
    } finally {
      repo.close();
    }
  });

  test('returns empty array for unknown snapshot', () => {
    const proj = setupProject();
    const repo = Repo.init(proj);
    try {
      expect(repo.sessionsAt('a'.repeat(40))).toEqual([]);
    } finally {
      repo.close();
    }
  });
});

// ─── Gate 11: schema migration v1 → v2 ───────────────────────────────────

describe('schema migration 001 + 002 (Gate 11 — schema)', () => {
  test('v1 → v2: session_id column dropped, attribution rows backfilled, kind values mapped', () => {
    // Build a minimal v0.1.x DB by applying ONLY 001_init.sql, then
    // insert legacy-shaped rows. Apply 002 and verify the reshape.
    const sql001 = readFileSync(join(SPEC_SCHEMA_DIR, '001_init.sql'), 'utf-8');
    const sql002 = readFileSync(join(SPEC_SCHEMA_DIR, '002_v0_2_decoupling.sql'), 'utf-8');

    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(sql001);

    // Insert v0.1.x-shaped rows: kind=auto, session_id populated.
    db.exec(`INSERT INTO snapshots
       (id, branch, kind, message, created_at, session_id, format_version)
       VALUES
       ('1111111111111111111111111111111111111111','main','auto','m1','2026-04-01T00:00:00.000Z','sess-A','0.1'),
       ('2222222222222222222222222222222222222222','main','edit','m2','2026-04-02T00:00:00.000Z','sess-B','0.1'),
       ('3333333333333333333333333333333333333333','main','fork','m3','2026-04-03T00:00:00.000Z',NULL,'0.1'),
       ('4444444444444444444444444444444444444444','main','init','m4','2026-04-04T00:00:00.000Z',NULL,'0.1'),
       ('5555555555555555555555555555555555555555','main','tag', 'm5','2026-04-05T00:00:00.000Z',NULL,'0.1')`);

    // Apply 002.
    db.exec(sql002);

    // Schema version bumped.
    const v = db.prepare('SELECT version FROM _schema').get() as { version: number };
    expect(v.version).toBe(2);

    // session_id column gone.
    const cols = db
      .prepare("SELECT name FROM pragma_table_info('snapshots')")
      .all() as { name: string }[];
    expect(cols.map((c) => c.name)).not.toContain('session_id');

    // Kind values mapped: auto/edit/fork → manual; init/tag unchanged.
    const kinds = db
      .prepare('SELECT id, kind FROM snapshots ORDER BY id')
      .all() as { id: string; kind: string }[];
    expect(kinds).toEqual([
      { id: '1' .repeat(40), kind: 'manual' },
      { id: '2' .repeat(40), kind: 'manual' },
      { id: '3' .repeat(40), kind: 'manual' },
      { id: '4' .repeat(40), kind: 'init' },
      { id: '5' .repeat(40), kind: 'tag' },
    ]);

    // Attribution rows backfilled for snapshots that had session_id.
    const attrs = db
      .prepare(
        "SELECT session_id, snapshot_id, event_kind FROM attributions ORDER BY snapshot_id",
      )
      .all() as { session_id: string; snapshot_id: string; event_kind: string }[];
    expect(attrs).toEqual([
      { session_id: 'sess-A', snapshot_id: '1' .repeat(40), event_kind: 'migrated' },
      { session_id: 'sess-B', snapshot_id: '2' .repeat(40), event_kind: 'migrated' },
    ]);

    // format_version set to 0.2 across all rows.
    const fvs = db
      .prepare('SELECT DISTINCT format_version FROM snapshots')
      .all() as { format_version: string }[];
    expect(fvs).toEqual([{ format_version: '0.2' }]);

    db.close();
  });

  test('Repo.open on existing v1 DB applies 002 transparently', () => {
    // Simulate the in-the-wild scenario: a project has a v1 lineage.sqlite
    // already on disk. Repo.open should apply 002 silently.
    const proj = setupProject();
    mkdirSync(join(proj, '.harness/snapshots'), { recursive: true });
    mkdirSync(join(proj, '.harness/refs/heads'), { recursive: true });
    writeFileSync(join(proj, '.harness/HEAD'), 'ref: refs/heads/main\n', 'utf-8');
    writeFileSync(join(proj, '.harness/config'), '[core]\ndefault_branch = "main"\n', 'utf-8');
    const sql001 = readFileSync(join(SPEC_SCHEMA_DIR, '001_init.sql'), 'utf-8');
    const dbPath = join(proj, '.harness/lineage.sqlite');
    const seed = new DatabaseSync(dbPath);
    seed.exec(sql001);
    seed.close();

    // Now opening through Repo should migrate to v2.
    const repo = Repo.open(proj);
    try {
      // observe() requires the v2 schema (attributions table) to function.
      const id = repo.observe({
        sessionId: 'sess-post-mig',
        eventKind: 'session_start',
        source: 'startup',
      });
      expect(id).toMatch(/^[0-9a-f]{40}$/);
      const traj = repo.trajectoryOf('sess-post-mig');
      expect(traj).toHaveLength(1);
    } finally {
      repo.close();
    }

    // Schema migrated past v2 to current (Repo.open chains 001 → 002 → 003 → 004).
    const verify = new DatabaseSync(dbPath, { readOnly: true });
    expect(verify.prepare('SELECT version FROM _schema').get()).toEqual({ version: 4 });
    verify.close();
  });
});

// Suppress unused-import lint
void existsSync;
