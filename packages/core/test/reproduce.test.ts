import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { Repo, snapshotId, type Snapshot } from '../src/index.js';
import { setupLocalApmSource, setupProjectWithApmDep } from './fixtures/apm-fixture.js';

// Reproducer integration tests (spec/format.md §6.1, prompt v0.4.0
// gates 17–20). All tests use real APM against a local-path fixture
// repo — no shim, no network.

function withTempProject(setup: (proj: string) => void): string {
  const proj = mkdtempSync(join(tmpdir(), 'harness-reprod-'));
  setup(proj);
  return proj;
}

function readClaudeFile(proj: string, ...parts: string[]): string {
  return readFileSync(join(proj, '.claude', ...parts), 'utf-8');
}

describe('Repo.reproduce — APM end-to-end (gate 17)', () => {
  test('captures with apmLockfile, mutates .claude/, reproduces, files reappear', () => {
    const fixture = setupLocalApmSource();
    const proj = setupProjectWithApmDep(fixture.repoPath);

    // Phase 1: install + capture baseline.
    execFileSync('apm', ['install'], { cwd: proj, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(existsSync(join(proj, '.claude', 'skills', fixture.skillName, 'SKILL.md'))).toBe(true);
    const baselineContent = readClaudeFile(proj, 'skills', fixture.skillName, 'SKILL.md');

    const repo = Repo.init(proj);
    try {
      const snapId = repo.observe({ sessionId: 'sess-test', eventKind: 'session_start', source: 'startup' });
      const snap = repo.snapshot(snapId);
      // The snapshot MUST have apmLockfile populated since apm.lock.yaml exists.
      expect(snap.apmLockfile).toBeTypeOf('string');
      expect(snap.apmLockfile?.length ?? 0).toBeGreaterThan(0);
      expect(snap.apmLockHash).toMatch(/^sha256:[0-9a-f]{64}$/);

      // Phase 2: mutate .claude/ — break the deployed file.
      writeFileSync(
        join(proj, '.claude', 'skills', fixture.skillName, 'SKILL.md'),
        '# corrupted\n',
        'utf-8',
      );
      expect(readClaudeFile(proj, 'skills', fixture.skillName, 'SKILL.md')).toBe('# corrupted\n');

      // Phase 3: reproduce. The reproducer should write apm.lock.yaml,
      // run apm install --frozen, and the deployed SKILL.md should be
      // restored.
      const result = repo.reproduce(snapId);
      expect(result.dryRun).toBe(false);
      expect(result.headAdvanced).toBe(true);
      // APM phase: skipped if no apm-kind modules; success if any. Local-path
      // APM produces local-kind modules, so skipped is the expected shape
      // for v0.4 unless the reader is later enhanced. Either is acceptable;
      // what matters is that apm install --frozen ran (verified below).
      expect(['skipped', 'success']).toContain(result.apmPhase);

      // The mutated content must be replaced by the originally-deployed bytes.
      expect(readClaudeFile(proj, 'skills', fixture.skillName, 'SKILL.md')).toBe(baselineContent);

      // HEAD must point at the reproduced snapshot id (detached).
      const headContent = readFileSync(join(proj, '.harness', 'HEAD'), 'utf-8');
      expect(headContent.trim()).toBe(snapId);
    } finally {
      repo.close();
      rmSync(proj, { recursive: true, force: true });
      rmSync(fixture.repoPath, { recursive: true, force: true });
    }
  });
});

describe('Repo.reproduce — local-source reporting (gate 18)', () => {
  test('local-source modules are reported, never written, file untouched', () => {
    const proj = withTempProject((p) => {
      mkdirSync(join(p, '.claude', 'skills', 'hand-written'), { recursive: true });
      writeFileSync(
        join(p, '.claude', 'skills', 'hand-written', 'SKILL.md'),
        '---\nname: hand-written\ndescription: local-source\n---\n# Hand\n',
        'utf-8',
      );
    });
    const repo = Repo.init(proj);
    try {
      const snapId = repo.observe({
        sessionId: 'sess-local',
        eventKind: 'session_start',
        source: 'startup',
      });

      // Mutate the local file, then reproduce. With APM=skipped and
      // a local-source-only composition, the reproducer must NOT touch
      // the file — local-source is reported, not materialized.
      const mutated = '# was edited\n';
      writeFileSync(join(proj, '.claude', 'skills', 'hand-written', 'SKILL.md'), mutated, 'utf-8');

      const result = repo.reproduce(snapId);
      expect(result.apmPhase).toBe('skipped');
      expect(result.localSourceReported.length).toBeGreaterThan(0);
      const reported = result.localSourceReported.find((m) => m.name === 'hand-written');
      expect(reported).toBeDefined();
      expect(reported?.path).toContain('hand-written/SKILL.md');

      // The mutated file is NOT restored — local-source is honest.
      expect(readClaudeFile(proj, 'skills', 'hand-written', 'SKILL.md')).toBe(mutated);

      // HEAD still advances even when only local-source was reported.
      expect(result.headAdvanced).toBe(true);
    } finally {
      repo.close();
      rmSync(proj, { recursive: true, force: true });
    }
  });
});

describe('Repo.reproduce — dry-run produces no side effects (gate 19)', () => {
  test('dry-run leaves .claude/, apm.lock.yaml, HEAD unchanged', () => {
    const fixture = setupLocalApmSource();
    const proj = setupProjectWithApmDep(fixture.repoPath);
    execFileSync('apm', ['install'], { cwd: proj, stdio: ['ignore', 'pipe', 'pipe'] });
    const repo = Repo.init(proj);
    try {
      const snapId = repo.observe({
        sessionId: 'sess-dry',
        eventKind: 'session_start',
        source: 'startup',
      });

      const claudeBefore = snapshotDir(join(proj, '.claude'));
      const lockBefore = readFileSync(join(proj, 'apm.lock.yaml'), 'utf-8');
      const headBefore = readFileSync(join(proj, '.harness', 'HEAD'), 'utf-8');

      const result = repo.reproduce(snapId, { dryRun: true });
      expect(result.dryRun).toBe(true);
      expect(result.headAdvanced).toBe(false);

      const claudeAfter = snapshotDir(join(proj, '.claude'));
      const lockAfter = readFileSync(join(proj, 'apm.lock.yaml'), 'utf-8');
      const headAfter = readFileSync(join(proj, '.harness', 'HEAD'), 'utf-8');

      expect(claudeAfter).toEqual(claudeBefore);
      expect(lockAfter).toBe(lockBefore);
      expect(headAfter).toBe(headBefore);

      // No backup directory was created in dry-run.
      const backupsCreated = readdirSync(proj).filter((n) => n.startsWith('.claude.harness-backup-'));
      expect(backupsCreated).toEqual([]);
    } finally {
      repo.close();
      rmSync(proj, { recursive: true, force: true });
      rmSync(fixture.repoPath, { recursive: true, force: true });
    }
  });
});

describe('Repo.reproduce — backup happens before writes (gate 20)', () => {
  test('backup directory mirrors pre-reproduce .claude/ contents', () => {
    const fixture = setupLocalApmSource();
    const proj = setupProjectWithApmDep(fixture.repoPath);
    execFileSync('apm', ['install'], { cwd: proj, stdio: ['ignore', 'pipe', 'pipe'] });

    // Drop a "user file" that doesn't come from APM — it must survive
    // in the backup even though apm install --frozen wouldn't restore it.
    writeFileSync(join(proj, '.claude', 'user-marker.txt'), 'preserved\n', 'utf-8');

    const repo = Repo.init(proj);
    try {
      const snapId = repo.observe({
        sessionId: 'sess-backup',
        eventKind: 'session_start',
        source: 'startup',
      });
      const result = repo.reproduce(snapId);
      expect(existsSync(result.backupPath)).toBe(true);
      const backedUp = readFileSync(join(result.backupPath, 'user-marker.txt'), 'utf-8');
      expect(backedUp).toBe('preserved\n');
    } finally {
      repo.close();
      rmSync(proj, { recursive: true, force: true });
      rmSync(fixture.repoPath, { recursive: true, force: true });
    }
  });
});

describe('Snapshot id varies with apmLockfile (gate 21)', () => {
  test('two snapshots with different apmLockfile content yield different ids', () => {
    const base = (lockfile: string | null): Omit<Snapshot, 'id'> => ({
      formatVersion: '0.4',
      parentIds: [],
      branch: 'main',
      kind: 'init',
      codePin: null,
      apmLockHash: null,
      apmLockfile: lockfile,
      createdAt: '2026-05-04T00:00:00.000Z',
      modules: [],
    });
    const idA = snapshotId(base('content-A\n'));
    const idB = snapshotId(base('content-B\n'));
    const idAcopy = snapshotId(base('content-A\n'));
    const idNull = snapshotId(base(null));

    expect(idA).not.toBe(idB);
    expect(idA).toBe(idAcopy);
    expect(idA).not.toBe(idNull);
    expect(idB).not.toBe(idNull);
  });
});

describe('Repo.reproduce — apm not on PATH aborts before backup', () => {
  test('PATH-stripped invocation throws and does NOT create a backup', () => {
    const fixture = setupLocalApmSource();
    const proj = setupProjectWithApmDep(fixture.repoPath);
    execFileSync('apm', ['install'], { cwd: proj, stdio: ['ignore', 'pipe', 'pipe'] });
    const repo = Repo.init(proj);
    try {
      const snapId = repo.observe({
        sessionId: 'sess-nopath',
        eventKind: 'session_start',
        source: 'startup',
      });
      // The captured snapshot must have at least one apm-source module
      // for the PATH check to fire. Local-path APM produces local-kind
      // modules, so this test exercises the APM-skipped path instead.
      // To exercise PATH check, we'd need an apm-kind module — synthetic
      // construction below.
      void snapId;
      const apmKindSnap: Omit<Snapshot, 'id'> = {
        formatVersion: '0.4',
        parentIds: [],
        branch: 'main',
        kind: 'init',
        codePin: null,
        apmLockHash: 'sha256:' + 'a'.repeat(64),
        apmLockfile: 'lockfile_version: "1"\ndependencies: []\n',
        createdAt: '2026-05-04T00:00:00.000Z',
        modules: [
          {
            type: 'skill',
            name: 'apm-kind',
            enabled: true,
            configHash: 'sha256:' + 'b'.repeat(64),
            source: { kind: 'apm', package: 'fake/pkg', resolvedCommit: 'c'.repeat(40), depth: 1 },
          },
        ],
      };
      const written = repo.writeSnapshot(apmKindSnap);

      // Strip apm from PATH for this call.
      const origPath = process.env['PATH'];
      process.env['PATH'] = '/nonexistent';
      try {
        expect(() => repo.reproduce(written.id)).toThrow(/apm not found on PATH/i);
      } finally {
        process.env['PATH'] = origPath;
      }
      // No backup directory was created — abort happened before backup.
      const backups = readdirSync(proj).filter((n) => n.startsWith('.claude.harness-backup-'));
      expect(backups).toEqual([]);
    } finally {
      repo.close();
      rmSync(proj, { recursive: true, force: true });
      rmSync(fixture.repoPath, { recursive: true, force: true });
    }
  });
});

// ── helpers ────────────────────────────────────────────────────────────────

function snapshotDir(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  walk(dir, dir, out);
  return out;
}

function walk(root: string, abs: string, out: Map<string, string>): void {
  for (const name of readdirSync(abs)) {
    const child = join(abs, name);
    const st = statSync(child);
    const rel = child.slice(root.length + 1);
    if (st.isDirectory()) walk(root, child, out);
    else out.set(rel, readFileSync(child, 'utf-8'));
  }
}
