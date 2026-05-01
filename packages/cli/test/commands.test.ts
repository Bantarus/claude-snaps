import { describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, runHook } from './util.js';

function freshProject(): string {
  return mkdtempSync(join(tmpdir(), 'harness-cli-'));
}

async function initRepo(cwd: string): Promise<void> {
  const r = await runCli(['init'], { cwd });
  if (r.code !== 0) throw new Error(`init failed: ${r.stderr}`);
}

async function writeMinimalClaude(cwd: string): Promise<void> {
  mkdirSync(join(cwd, '.claude/skills/research'), { recursive: true });
  writeFileSync(join(cwd, '.claude/skills/research/SKILL.md'), '# research v0.1\n');
}

async function snapshotOnce(cwd: string, sessionId: string): Promise<void> {
  const r = await runHook(['--session-id', sessionId, '--cwd', cwd], { cwd });
  if (r.code !== 0) throw new Error(`hook failed: ${r.stderr}`);
}

describe('harness init', () => {
  test('creates the .harness/ skeleton', async () => {
    const cwd = freshProject();
    const r = await runCli(['init'], { cwd });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Initialized empty harness repository');
    expect(existsSync(join(cwd, '.harness/HEAD'))).toBe(true);
    expect(existsSync(join(cwd, '.harness/config'))).toBe(true);
  });

  test('refuses to re-init', async () => {
    const cwd = freshProject();
    await initRepo(cwd);
    const r = await runCli(['init'], { cwd });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/already exists/);
  });

  test('--branch sets default branch', async () => {
    const cwd = freshProject();
    const r = await runCli(['init', '--branch=trunk'], { cwd });
    expect(r.code).toBe(0);
    const head = require('node:fs').readFileSync(join(cwd, '.harness/HEAD'), 'utf-8');
    expect(head.trim()).toBe('ref: refs/heads/trunk');
  });
});

describe('harness log / diff', () => {
  test('log on empty repo throws (1) with helpful message', async () => {
    const cwd = freshProject();
    await initRepo(cwd);
    const r = await runCli(['log'], { cwd });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no commits yet/);
  });

  test('log + diff after two snapshots shows the change', async () => {
    const cwd = freshProject();
    await initRepo(cwd);
    await writeMinimalClaude(cwd);
    await snapshotOnce(cwd, 'session-A');
    writeFileSync(join(cwd, '.claude/skills/research/SKILL.md'), '# research v0.2\n');
    await snapshotOnce(cwd, 'session-B');

    const log = await runCli(['log'], { cwd });
    expect(log.code).toBe(0);
    const lines = log.stdout.trim().split('\n');
    expect(lines.length).toBe(2);
    const idB = lines[0]!.split(' ')[0]!;
    const idA = lines[1]!.split(' ')[0]!;

    const diff = await runCli(['diff', idA, idB], { cwd });
    expect(diff.code).toBe(0);
    expect(diff.stdout).toMatch(/research/);
    expect(diff.stdout).toMatch(/~1 changed/);
  });

  test('diff with HEAD ref works after at least one snapshot', async () => {
    const cwd = freshProject();
    await initRepo(cwd);
    await writeMinimalClaude(cwd);
    await snapshotOnce(cwd, 'session-X');
    writeFileSync(join(cwd, '.claude/skills/research/SKILL.md'), '# research bumped\n');
    await snapshotOnce(cwd, 'session-Y');

    const log = await runCli(['log'], { cwd });
    const idA = log.stdout.trim().split('\n')[1]!.split(' ')[0]!;
    const r = await runCli(['diff', idA, 'HEAD'], { cwd });
    expect(r.code).toBe(0);
  });
});

describe('harness tag / branch / checkout', () => {
  test('tag at HEAD, then resolve via tag name', async () => {
    const cwd = freshProject();
    await initRepo(cwd);
    await writeMinimalClaude(cwd);
    await snapshotOnce(cwd, 'session-1');

    const tag = await runCli(['tag', 'v0.1'], { cwd });
    expect(tag.code).toBe(0);
    expect(tag.stdout).toMatch(/Tagged \w{8} as v0\.1/);
    expect(existsSync(join(cwd, '.harness/refs/tags/v0.1'))).toBe(true);
  });

  test('tag refuses to overwrite without --force', async () => {
    const cwd = freshProject();
    await initRepo(cwd);
    await writeMinimalClaude(cwd);
    await snapshotOnce(cwd, 's1');
    await runCli(['tag', 'v0.1'], { cwd });
    const r = await runCli(['tag', 'v0.1'], { cwd });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/already exists/);
    const force = await runCli(['tag', 'v0.1', '--force'], { cwd });
    expect(force.code).toBe(0);
  });

  test('branch + checkout updates HEAD symbolic ref', async () => {
    const cwd = freshProject();
    await initRepo(cwd);
    await writeMinimalClaude(cwd);
    await snapshotOnce(cwd, 's1');
    const br = await runCli(['branch', 'experimental'], { cwd });
    expect(br.code).toBe(0);
    const co = await runCli(['checkout', 'experimental'], { cwd });
    expect(co.code).toBe(0);
    const head = require('node:fs').readFileSync(join(cwd, '.harness/HEAD'), 'utf-8');
    expect(head.trim()).toBe('ref: refs/heads/experimental');
  });

  test('checkout to a 40-hex id detaches HEAD', async () => {
    const cwd = freshProject();
    await initRepo(cwd);
    await writeMinimalClaude(cwd);
    await snapshotOnce(cwd, 's1');
    const log = await runCli(['log'], { cwd });
    const id = log.stdout.trim().split('\n')[0]!.split(' ')[0]!;
    // Note: log only shows the 8-char prefix; we need the full id.
    const fullIds = require('node:fs').readdirSync(
      join(cwd, '.harness/snapshots'),
    ).flatMap((aa: string) => {
      const subDir = join(cwd, '.harness/snapshots', aa);
      const stat = require('node:fs').statSync(subDir);
      if (!stat.isDirectory()) return [];
      return require('node:fs').readdirSync(subDir).map((f: string) => aa + f.replace('.json', ''));
    });
    expect(fullIds.length).toBeGreaterThan(0);
    expect(fullIds[0]!.startsWith(id)).toBe(true);

    const co = await runCli(['checkout', fullIds[0]!], { cwd });
    expect(co.code).toBe(0);
    const head = require('node:fs').readFileSync(join(cwd, '.harness/HEAD'), 'utf-8');
    expect(head.trim()).toBe(fullIds[0]);
  });
});

describe('harness reindex', () => {
  test('reindex on a fresh repo with snapshots reports +N', async () => {
    const cwd = freshProject();
    await initRepo(cwd);
    await writeMinimalClaude(cwd);
    await snapshotOnce(cwd, 's1');
    // Drop and rebuild the index by removing it.
    require('node:fs').rmSync(join(cwd, '.harness/lineage.sqlite'));
    const r = await runCli(['reindex'], { cwd });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\+1 snapshots/);
  });

  test('reindex on an up-to-date repo reports +0', async () => {
    const cwd = freshProject();
    await initRepo(cwd);
    await writeMinimalClaude(cwd);
    await snapshotOnce(cwd, 's1');
    const r = await runCli(['reindex'], { cwd });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\+0 snapshots/);
  });
});

describe('error handling', () => {
  test('unknown command exits 1 with usage', async () => {
    const cwd = freshProject();
    const r = await runCli(['frobnicate'], { cwd });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unknown command/);
  });

  test('--help prints help and exits 0', async () => {
    const cwd = freshProject();
    const r = await runCli(['--help'], { cwd });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Usage: harness/);
  });
});
