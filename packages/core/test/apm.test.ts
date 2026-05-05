import { describe, expect, test, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apmLockHash, readApmLock } from '../src/apm.js';

const here = dirname(fileURLToPath(import.meta.url));
const SPEC_DIR = resolve(here, '../../../spec');
const TEAM_PROJECT = resolve(SPEC_DIR, 'examples/team-shared');
const SOLO_PROJECT = resolve(SPEC_DIR, 'examples/solo-with-apm');
const NO_APM_PROJECT = resolve(SPEC_DIR, 'examples/solo-no-apm');

describe('readApmLock — example fixtures', () => {
  test('team-shared: 2 entries, depth 1 + depth 2 transitive', () => {
    const entries = readApmLock(TEAM_PROJECT)!;
    expect(entries.length).toBe(2);
    const direct = entries.find((e) => e.depth === 1)!;
    const trans = entries.find((e) => e.depth === 2)!;
    expect(direct.package).toBe('microsoft/apm-sample-package');
    expect(direct.resolvedCommit).toBe('a3f9c1ef2244c3e85d10b0a6b7d52f0911aabbcc');
    expect(direct.deployedFiles).toContain('.claude/skills/research/SKILL.md');
    expect(trans.package).toBe('microsoft/common-utilities');
    expect(trans.resolvedBy).toBe('microsoft/apm-sample-package');
  });

  test('solo-with-apm: 2 entries', () => {
    const entries = readApmLock(SOLO_PROJECT)!;
    expect(entries.length).toBe(2);
  });

  test('solo-no-apm: returns null (no lockfile)', () => {
    expect(readApmLock(NO_APM_PROJECT)).toBeNull();
  });
});

describe('apmLockHash — example fixtures', () => {
  test('matches the apmLockHash recorded in team-shared snapshots', () => {
    // Pick the team-shared init blob; its apmLockHash must match what
    // apmLockHash() computes from the on-disk lockfile bytes.
    const initBlob = JSON.parse(
      require('node:fs').readFileSync(
        resolve(TEAM_PROJECT, '.harness/snapshots/74/1a33a39d1e4b324a1a746662124cefe069535d.json'),
        'utf-8',
      ),
    );
    expect(apmLockHash(TEAM_PROJECT)).toBe(initBlob.apmLockHash);
  });

  test('returns null when no lockfile present', () => {
    expect(apmLockHash(NO_APM_PROJECT)).toBeNull();
  });
});

describe('readApmLock — tolerance to upstream evolution', () => {
  test('unknown future top-level and per-entry fields are ignored', () => {
    const lock = `
lockfile_version: "99"
new_top_level_field: whatever
some_audit_record:
  performed_at: "2026-04-01"
packages:
  - package: example/foo
    repo_url: https://github.com/example/foo
    resolved_commit: ${'a'.repeat(40)}
    depth: 1
    deployed_files:
      - .claude/skills/foo/SKILL.md
    new_per_entry_field: whatever
    sub_object:
      a: 1
      b: 2
`;
    const tmp = mkdtempSync(join(tmpdir(), 'apm-test-'));
    writeFileSync(join(tmp, 'apm.lock.yaml'), lock, 'utf-8');
    const entries = readApmLock(tmp)!;
    expect(entries.length).toBe(1);
    expect(entries[0]!.package).toBe('example/foo');
    expect(entries[0]!.depth).toBe(1);
  });

  test('accepts both `packages` (current) and `dependencies` (alternative) keys', () => {
    const lock = `
dependencies:
  - package: example/bar
    repo_url: https://github.com/example/bar
    resolved_commit: ${'b'.repeat(40)}
    depth: 1
    deployed_files: ['.claude/skills/bar/SKILL.md']
`;
    const tmp = mkdtempSync(join(tmpdir(), 'apm-test-'));
    writeFileSync(join(tmp, 'apm.lock.yaml'), lock, 'utf-8');
    const entries = readApmLock(tmp)!;
    expect(entries.length).toBe(1);
    expect(entries[0]!.package).toBe('example/bar');
  });

  test('camelCase field aliases (repoUrl, resolvedCommit, deployedFiles) are accepted', () => {
    const lock = `
packages:
  - package: example/baz
    repoUrl: https://github.com/example/baz
    resolvedCommit: ${'c'.repeat(40)}
    depth: 1
    deployedFiles: ['.claude/skills/baz/SKILL.md']
`;
    const tmp = mkdtempSync(join(tmpdir(), 'apm-test-'));
    writeFileSync(join(tmp, 'apm.lock.yaml'), lock, 'utf-8');
    const entries = readApmLock(tmp)!;
    expect(entries.length).toBe(1);
    expect(entries[0]!.repoUrl).toBe('https://github.com/example/baz');
  });

  test('entry missing a required field is skipped (warn, not throw)', () => {
    const lock = `
packages:
  - package: complete/one
    repo_url: https://github.com/c/one
    resolved_commit: ${'d'.repeat(40)}
    depth: 1
    deployed_files: ['x']
  - package: missing/depth
    repo_url: https://github.com/m/d
    resolved_commit: ${'e'.repeat(40)}
    deployed_files: ['y']
`;
    const tmp = mkdtempSync(join(tmpdir(), 'apm-test-'));
    writeFileSync(join(tmp, 'apm.lock.yaml'), lock, 'utf-8');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const entries = readApmLock(tmp)!;
      expect(entries.length).toBe(1);
      expect(entries[0]!.package).toBe('complete/one');
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('throws ParseError on malformed YAML', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'apm-test-'));
    writeFileSync(join(tmp, 'apm.lock.yaml'), '{ : not valid yaml :: ::', 'utf-8');
    expect(() => readApmLock(tmp)).toThrow();
  });

  test('returns null when lockfile is absent', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'apm-test-'));
    expect(readApmLock(tmp)).toBeNull();
  });
});

describe('readApmLock — local-path entry synthesis (v0.4.1)', () => {
  test('local-path entry synthesizes apm-kind identity (repo_url _local/<name>)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'apm-localpath-'));
    const fakeLocal = mkdtempSync(join(tmpdir(), 'fake-local-'));
    const lock = `
dependencies:
- repo_url: _local/source
  package_type: apm_package
  deployed_files:
    - .claude/skills/test-fixture
  source: local
  local_path: ${fakeLocal}
`;
    writeFileSync(join(tmp, 'apm.lock.yaml'), lock, 'utf-8');
    const entries = readApmLock(tmp)!;
    expect(entries.length).toBe(1);
    const e = entries[0]!;
    expect(e.package).toBe('_local/source');
    expect(e.depth).toBe(1);
    expect(e.repoUrl).toBe('_local/source');
    expect(e.deployedFiles).toEqual(['.claude/skills/test-fixture']);
    // resolvedCommit is synthesized — 40 hex either from git rev-parse
    // or content-hash fallback.
    expect(e.resolvedCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  test('local-path entry without repo_url falls back to local_path basename', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'apm-lp-basename-'));
    const fakeLocal = mkdtempSync(join(tmpdir(), 'lib-foo-'));
    const lock = `
dependencies:
- source: local
  local_path: ${fakeLocal}
  deployed_files:
    - .claude/skills/x
`;
    writeFileSync(join(tmp, 'apm.lock.yaml'), lock, 'utf-8');
    const entries = readApmLock(tmp)!;
    expect(entries.length).toBe(1);
    expect(entries[0]!.package).toMatch(/^_local\/lib-foo-/);
  });

  test('local-path entry where local_path is a git repo uses git HEAD', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'apm-lp-git-'));
    const repo = mkdtempSync(join(tmpdir(), 'gitrepo-'));
    const fs = require('node:fs') as typeof import('node:fs');
    fs.writeFileSync(join(repo, 'a.txt'), 'hello\n', 'utf-8');
    const cp = require('node:child_process') as typeof import('node:child_process');
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    };
    cp.execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env });
    cp.execFileSync('git', ['add', '-A'], { cwd: repo, env });
    cp.execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, env });
    const expectedSha = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, env, encoding: 'utf-8' }).trim();

    const lock = `
dependencies:
- repo_url: _local/gitrepo
  source: local
  local_path: ${repo}
  deployed_files:
    - .claude/skills/x
`;
    writeFileSync(join(tmp, 'apm.lock.yaml'), lock, 'utf-8');
    const entries = readApmLock(tmp)!;
    expect(entries[0]!.resolvedCommit).toBe(expectedSha);
  });
});
