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

      // v0.4.1: the deployed skill MUST be classified as apm-kind via
      // the local-path enricher (apm-integration.md §2.3). Pre-v0.4.1
      // it landed as local-kind because local-path lockfile entries
      // lack resolved_commit and were skipped by the reader.
      const skillModule = snap.modules.find(
        (m) => m.type === 'skill' && m.name === fixture.skillName,
      );
      expect(skillModule).toBeDefined();
      expect(skillModule!.source.kind).toBe('apm');
      if (skillModule!.source.kind === 'apm') {
        expect(skillModule!.source.package).toMatch(/^_local\//);
        expect(skillModule!.source.depth).toBe(1);
      }

      // Phase 2: mutate .claude/ — break the deployed file.
      writeFileSync(
        join(proj, '.claude', 'skills', fixture.skillName, 'SKILL.md'),
        '# corrupted\n',
        'utf-8',
      );
      expect(readClaudeFile(proj, 'skills', fixture.skillName, 'SKILL.md')).toBe('# corrupted\n');

      // Phase 3: reproduce. The reproducer writes apm.lock.yaml, runs
      // `apm install --force`, re-walks .claude/, and verifies each
      // apm-kind module's configHash matches the snapshot's recorded
      // value.
      const result = repo.reproduce(snapId);
      expect(result.dryRun).toBe(false);
      expect(result.headAdvanced).toBe(true);
      // v0.4.1: apm-kind modules now exist in the snapshot, so the APM
      // phase MUST run successfully (skipped is no longer acceptable).
      expect(result.apmPhase).toBe('success');
      expect(result.apmModulesExpected).toBeGreaterThan(0);
      expect(result.apmModulesVerified).toBe(result.apmModulesExpected);
      expect(result.apmFailures).toEqual([]);
      // The skill is APM-managed; it must NOT appear under local-source.
      expect(
        result.localSourceReported.some((m) => m.name === fixture.skillName),
      ).toBe(false);

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

describe('Repo.reproduce — subtractive within scope (gate 22, v0.4.1)', () => {
  test('reproducing an ancestor removes APM-managed paths added since', () => {
    // Build a real lineage: init (no APM) → auto (after apm install) →
    // reproduce(init) MUST leave .claude/ byte-equivalent (modulo
    // local-source) to a fresh capture of init.
    const fixture = setupLocalApmSource();
    const proj = setupProjectWithApmDep(fixture.repoPath);

    // Pre-APM baseline: capture init.
    const repo = Repo.init(proj);
    try {
      const initId = repo.observe({
        sessionId: 'sess-init',
        eventKind: 'session_start',
        source: 'startup',
      });
      const initSnap = repo.snapshot(initId);
      expect(initSnap.apmLockfile).toBeNull();
      // No apm-test deployed yet — the skill directory must not exist.
      expect(existsSync(join(proj, '.claude', 'skills', fixture.skillName))).toBe(false);

      // APM install: deploy fixture and re-observe.
      execFileSync('apm', ['install'], { cwd: proj, stdio: ['ignore', 'pipe', 'pipe'] });
      expect(existsSync(join(proj, '.claude', 'skills', fixture.skillName, 'SKILL.md'))).toBe(true);
      const afterApmId = repo.observe({
        sessionId: 'sess-after-apm',
        eventKind: 'session_start',
        source: 'startup',
      });
      expect(afterApmId).not.toBe(initId);

      // Reproduce the init snapshot. Subtractive contract: the
      // apm-test skill directory must be removed because it isn't in
      // init's APM scope (init has no apmLockfile). The project's
      // apm.lock.yaml must also be removed (target recorded no APM).
      const result = repo.reproduce(initId);
      expect(result.headAdvanced).toBe(true);
      expect(result.apmPhase).toBe('skipped'); // init has null apmLockfile
      expect(result.pathsRemoved).toContain(`.claude/skills/${fixture.skillName}`);
      expect(result.projectLockfileRemoved).toBe(true);

      // Byte-identity (modulo local-source paths, which the
      // contract excludes from removal): apm-test directory is gone,
      // apm.lock.yaml is gone, only init's local-source files remain.
      expect(existsSync(join(proj, '.claude', 'skills', fixture.skillName))).toBe(false);
      expect(existsSync(join(proj, 'apm.lock.yaml'))).toBe(false);
      // The backup of the lockfile is retained.
      expect(existsSync(join(proj, 'apm.lock.yaml.harness-backup'))).toBe(true);

      // Identity-layer equivalence with init: recompute the
      // snapshot id from the live state and confirm it matches
      // initId. We bypass observe() (which refuses detached HEAD
      // after reproduce) and call snapshotId() directly with
      // init's parents+branch+kind. The assertion is on the
      // canonical-bytes equivalence — same modules, same
      // apmLockHash, same apmLockfile produce the same id.
      const liveModules = repo.workingTree();
      const liveLockHash = repo.apmLockHash();
      const liveLockfile = repo.apmLockfileContent();
      const recomputedId = snapshotId({
        formatVersion: initSnap.formatVersion ?? '0.4',
        parentIds: initSnap.parentIds,
        branch: initSnap.branch,
        kind: initSnap.kind,
        codePin: initSnap.codePin,
        apmLockHash: liveLockHash,
        apmLockfile: liveLockfile,
        createdAt: initSnap.createdAt,
        modules: liveModules,
      });
      expect(recomputedId).toBe(initId);
    } finally {
      repo.close();
      rmSync(proj, { recursive: true, force: true });
      rmSync(fixture.repoPath, { recursive: true, force: true });
    }
  });

  test('reproducing forward (no APM → APM) installs without removing local-source', () => {
    // The other direction: starting from a no-APM state, reproduce a
    // snapshot that has APM. Must install correctly and NOT touch
    // local-source files that exist on both sides.
    const fixture = setupLocalApmSource();
    const proj = setupProjectWithApmDep(fixture.repoPath);

    // Add a hand-written local skill that's NOT in the APM scope.
    // Both before and after the lineage transition, this file should
    // survive untouched (per §6.1: "Local-source paths are not touched").
    const localPath = join(proj, '.claude', 'skills', 'hand-written');
    require('node:fs').mkdirSync(localPath, { recursive: true });
    writeFileSync(
      join(localPath, 'SKILL.md'),
      '---\nname: hand-written\ndescription: local-only\n---\n# Hand\n',
      'utf-8',
    );
    const localContent = readFileSync(join(localPath, 'SKILL.md'), 'utf-8');

    const repo = Repo.init(proj);
    try {
      const initId = repo.observe({ sessionId: 'sess-1', eventKind: 'session_start', source: 'startup' });

      execFileSync('apm', ['install'], { cwd: proj, stdio: ['ignore', 'pipe', 'pipe'] });
      const apmId = repo.observe({ sessionId: 'sess-2', eventKind: 'session_start', source: 'startup' });

      // Reproduce the APM snapshot — should ADD apm-test and NOT
      // remove the hand-written skill. Sanity-check both directions.
      // First reproduce init to clear apm-test, then reproduce apmId.
      repo.reproduce(initId);
      expect(existsSync(join(proj, '.claude', 'skills', fixture.skillName))).toBe(false);
      expect(existsSync(join(localPath, 'SKILL.md'))).toBe(true); // local untouched

      const result = repo.reproduce(apmId);
      expect(result.apmPhase).toBe('success');
      expect(result.pathsRemoved).toEqual([]); // forward direction, nothing to subtract
      expect(existsSync(join(proj, '.claude', 'skills', fixture.skillName, 'SKILL.md'))).toBe(true);
      // Local hand-written skill survives both reproduces.
      expect(readFileSync(join(localPath, 'SKILL.md'), 'utf-8')).toBe(localContent);
    } finally {
      repo.close();
      rmSync(proj, { recursive: true, force: true });
      rmSync(fixture.repoPath, { recursive: true, force: true });
    }
  });

  test('subtractive cleanup never deletes paths outside .claude/', () => {
    // Defensive: a hypothetical lockfile that listed paths outside
    // .claude/ (e.g. an attacker-crafted apm.lock.yaml with
    // `deployed_files: [/etc/passwd]`) MUST NOT cause the reproducer
    // to delete arbitrary files.
    const fixture = setupLocalApmSource();
    const proj = setupProjectWithApmDep(fixture.repoPath);
    execFileSync('apm', ['install'], { cwd: proj, stdio: ['ignore', 'pipe', 'pipe'] });

    // Inject a marker file outside .claude/ at project root.
    const marker = join(proj, 'IMPORTANT-USER-FILE.txt');
    writeFileSync(marker, 'preserved\n', 'utf-8');

    // Tamper with apm.lock.yaml to add deployed_files entries outside
    // .claude/. (We don't go through APM for this — write the YAML
    // by hand to simulate the malicious case.) The first entry is
    // the real deployed skill path (so the cleanup actually attempts
    // to remove something); the second and third are out-of-scope
    // paths that the defensive filter MUST refuse to touch.
    writeFileSync(join(proj, 'apm.lock.yaml'), `
lockfile_version: '1'
dependencies:
  - repo_url: _local/test
    source: local
    local_path: ${fixture.repoPath}
    deployed_files:
      - .claude/skills/${fixture.skillName}
      - IMPORTANT-USER-FILE.txt
      - ../../etc/passwd
`, 'utf-8');

    const repo = Repo.init(proj);
    try {
      // Capture an init that includes the malicious lockfile state.
      const initId = repo.observe({ sessionId: 'sess-tamper', eventKind: 'session_start', source: 'startup' });

      // Build a synthetic target snapshot with NO apmLockfile so the
      // subtractive pass tries to remove all paths in the current
      // (tampered) lockfile. The defensive check should keep
      // IMPORTANT-USER-FILE.txt and /etc/passwd untouched.
      const targetSnap: Omit<Snapshot, 'id'> = {
        formatVersion: '0.4',
        parentIds: [],
        branch: 'main',
        kind: 'init',
        codePin: null,
        apmLockHash: null,
        apmLockfile: null,
        createdAt: '2026-05-05T00:00:00.000Z',
        modules: [],
      };
      const written = repo.writeSnapshot(targetSnap);
      const result = repo.reproduce(written.id);

      // The marker file MUST still exist.
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, 'utf-8')).toBe('preserved\n');
      // /etc/passwd MUST exist (we'd be sad otherwise).
      expect(existsSync('/etc/passwd')).toBe(true);
      // The in-scope path was removed.
      expect(result.pathsRemoved).toContain(`.claude/skills/${fixture.skillName}`);
      // The marker is NOT in the removal list.
      expect(result.pathsRemoved).not.toContain('IMPORTANT-USER-FILE.txt');
      // No traversal escapes.
      expect(result.pathsRemoved.every((p) => p.startsWith('.claude'))).toBe(true);
      void initId;
    } finally {
      repo.close();
      rmSync(proj, { recursive: true, force: true });
      rmSync(fixture.repoPath, { recursive: true, force: true });
    }
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
