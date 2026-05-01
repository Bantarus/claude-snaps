import { describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshHarnessRepo, runHarness, runHook, writeMinimalClaude } from './util.js';

describe('harness-hook — happy path', () => {
  test('writes one snapshot, exits 0', async () => {
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    const r = await runHook(['--session-id', 's1', '--cwd', cwd], { cwd });
    expect(r.code).toBe(0);
    const log = await runHarness(['log'], { cwd });
    expect(log.code).toBe(0);
    expect(log.stdout.trim().split('\n').length).toBe(1);
  });

  test('advances main branch ref to the new snapshot', async () => {
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    await runHook(['--session-id', 's1', '--cwd', cwd], { cwd });
    expect(existsSync(join(cwd, '.harness/refs/heads/main'))).toBe(true);
    const tip = readFileSync(join(cwd, '.harness/refs/heads/main'), 'utf-8').trim();
    expect(tip).toMatch(/^[0-9a-f]{40}$/);
  });

  test('two consecutive sessions create two snapshots in a chain', async () => {
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    await runHook(['--session-id', 's1', '--cwd', cwd], { cwd });
    writeFileSync(join(cwd, '.claude/skills/research/SKILL.md'), '# v0.2\n');
    await runHook(['--session-id', 's2', '--cwd', cwd], { cwd });
    const log = await runHarness(['log'], { cwd });
    expect(log.stdout.trim().split('\n').length).toBe(2);
  });
});

describe('harness-hook — idempotency (spec/hooks.md §4.2)', () => {
  test('second fire for the same session id is a no-op', async () => {
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    await runHook(['--session-id', 'duplicate', '--cwd', cwd], { cwd });
    await runHook(['--session-id', 'duplicate', '--cwd', cwd], { cwd });
    const log = await runHarness(['log'], { cwd });
    expect(log.stdout.trim().split('\n').length).toBe(1);
  });

  test('--dry-run idempotent prints existing-snapshot id to stdout', async () => {
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    await runHook(['--session-id', 'dup', '--cwd', cwd], { cwd });
    const r = await runHook(['--session-id', 'dup', '--cwd', cwd, '--dry-run'], { cwd });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/idempotent/);
  });
});

describe('harness-hook — defense-in-depth: always exits 0', () => {
  test('missing session id (no stdin, no CLI flag): exit 0, error on stderr', async () => {
    const cwd = await freshHarnessRepo();
    const r = await runHook(['--cwd', cwd], { cwd });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/harness-hook: error:/);
    expect(r.stderr).toMatch(/no session id resolved/);
  });

  test('--cwd points at a non-harness dir: exit 0, error on stderr', async () => {
    const fake = mkdtempSync(join(tmpdir(), 'no-harness-'));
    const r = await runHook(['--session-id', 's1', '--cwd', fake], { cwd: fake });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/harness-hook: error:/);
  });

  test('--cwd points at non-existent path: exit 0, error on stderr', async () => {
    const r = await runHook(['--session-id', 's1', '--cwd', '/nonexistent/path-xyz'], { cwd: '/' });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/harness-hook: error:/);
  });

  test('unknown extra args are accepted and ignored (spec/hooks.md §1)', async () => {
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    const r = await runHook(
      ['--session-id', 's1', '--cwd', cwd, '--future-flag', 'whatever', '--reason', 'auto'],
      { cwd },
    );
    expect(r.code).toBe(0);
    expect(r.stderr).not.toMatch(/error/);
  });
});

describe('harness-hook — Claude Code stdin JSON contract (primary channel)', () => {
  test('stdin JSON with {session_id, cwd, source: "startup"} writes a snapshot', async () => {
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    const stdin = JSON.stringify({
      session_id: 'cc-stdin-1',
      cwd,
      hook_event_name: 'SessionStart',
      transcript_path: '/tmp/transcript.jsonl',
      source: 'startup',
    });
    const r = await runHook([], { cwd, stdin });
    expect(r.code).toBe(0);
    expect(r.stderr).not.toMatch(/error/);
    const log = await runHarness(['log'], { cwd });
    expect(log.stdout).toMatch(/cc-stdin/);
  });

  test('stdin JSON wins over CLI flags when both supplied', async () => {
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    // Use distinguishable session ids whose first 8 chars differ, since
    // log output truncates to 8 chars per the format pin.
    const stdin = JSON.stringify({ session_id: 'STDINwon-x', cwd });
    const r = await runHook(
      ['--session-id', 'CLIwon-yy', '--cwd', '/wrong/path'],
      { cwd, stdin },
    );
    expect(r.code).toBe(0);
    const log = await runHarness(['log'], { cwd });
    expect(log.stdout).toMatch(/STDINwon/);
    expect(log.stdout).not.toMatch(/CLIwon/);
  });

  test('CLAUDE_PROJECT_DIR env supplies cwd when stdin and CLI omit it', async () => {
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    // 8-char-distinguishable session id (log truncates to 8 chars).
    const r = await runHook(
      ['--session-id', 'envcwd12'],
      { cwd, env: { CLAUDE_PROJECT_DIR: cwd } },
    );
    expect(r.code).toBe(0);
    const log = await runHarness(['log'], { cwd });
    expect(log.stdout).toMatch(/envcwd12/);
  });

  test('idempotency works across mixed channels (stdin first, then CLI for the same session)', async () => {
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    await runHook([], {
      cwd,
      stdin: JSON.stringify({ session_id: 'mixed-channels', cwd, source: 'startup' }),
    });
    await runHook(
      ['--session-id', 'mixed-channels', '--cwd', cwd],
      { cwd },
    );
    const log = await runHarness(['log'], { cwd });
    // Two fires for the same session id → still only one snapshot.
    expect(log.stdout.trim().split('\n').length).toBe(1);
  });

  test('malformed stdin JSON is silently ignored if CLI provides everything', async () => {
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    const r = await runHook(
      ['--session-id', 'fallback', '--cwd', cwd],
      { cwd, stdin: '{ this is not valid json' },
    );
    expect(r.code).toBe(0);
    const log = await runHarness(['log'], { cwd });
    expect(log.stdout).toMatch(/fallback/);
  });

  test('source: "resume" still snapshots (matcher: "*" semantics)', async () => {
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    const r = await runHook([], {
      cwd,
      stdin: JSON.stringify({ session_id: 'resumed', cwd, source: 'resume' }),
    });
    expect(r.code).toBe(0);
    const log = await runHarness(['log'], { cwd });
    expect(log.stdout).toMatch(/resumed/);
  });

  test('model and permission_mode from stdin land on the snapshot blob', async () => {
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    const stdin = JSON.stringify({
      session_id: 'with-ctx',
      cwd,
      source: 'startup',
      model: 'claude-opus-4-7',
      permission_mode: 'plan',
    });
    const r = await runHook([], { cwd, stdin });
    expect(r.code).toBe(0);
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const snapsRoot = join(cwd, '.harness/snapshots');
    let blob: { model?: string; permissionMode?: string } | null = null;
    for (const aa of fs.readdirSync(snapsRoot)) {
      const sub = path.join(snapsRoot, aa);
      if (!fs.statSync(sub).isDirectory()) continue;
      for (const fn of fs.readdirSync(sub)) {
        if (fn.endsWith('.json')) {
          blob = JSON.parse(fs.readFileSync(path.join(sub, fn), 'utf-8'));
        }
      }
    }
    expect(blob).not.toBeNull();
    expect(blob!.model).toBe('claude-opus-4-7');
    expect(blob!.permissionMode).toBe('plan');
  });

  test('absent model and permission_mode leave the blob without those keys', async () => {
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    const stdin = JSON.stringify({ session_id: 'no-ctx', cwd, source: 'startup' });
    const r = await runHook([], { cwd, stdin });
    expect(r.code).toBe(0);
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const snapsRoot = join(cwd, '.harness/snapshots');
    let raw = '';
    for (const aa of fs.readdirSync(snapsRoot)) {
      const sub = path.join(snapsRoot, aa);
      if (!fs.statSync(sub).isDirectory()) continue;
      for (const fn of fs.readdirSync(sub)) {
        if (fn.endsWith('.json')) raw = fs.readFileSync(path.join(sub, fn), 'utf-8');
      }
    }
    const blob = JSON.parse(raw) as Record<string, unknown>;
    expect('model' in blob).toBe(false);
    expect('permissionMode' in blob).toBe(false);
  });
});

describe('harness-hook — APM enrichment when lockfile present', () => {
  test('module deployed_files match → source.kind becomes apm', async () => {
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    writeFileSync(
      join(cwd, 'apm.lock.yaml'),
      `packages:
  - package: example/research-pkg
    repo_url: https://github.com/example/research-pkg
    resolved_commit: ${'a'.repeat(40)}
    depth: 1
    deployed_files:
      - .claude/skills/research/SKILL.md
`,
      'utf-8',
    );
    await runHook(['--session-id', 'with-apm', '--cwd', cwd], { cwd });
    // Read the snapshot blob from disk and inspect modules.
    const snapsDir = join(cwd, '.harness/snapshots');
    const fs = require('node:fs');
    const path = require('node:path');
    const blobs: string[] = [];
    for (const aa of fs.readdirSync(snapsDir)) {
      const subDir = path.join(snapsDir, aa);
      if (!fs.statSync(subDir).isDirectory()) continue;
      for (const fn of fs.readdirSync(subDir)) {
        if (fn.endsWith('.json')) blobs.push(path.join(subDir, fn));
      }
    }
    expect(blobs.length).toBe(1);
    const blob = JSON.parse(fs.readFileSync(blobs[0]!, 'utf-8'));
    const research = blob.modules.find((m: { name: string; type: string }) => m.name === 'research' && m.type === 'skill');
    expect(research).toBeDefined();
    expect(research.source.kind).toBe('apm');
    expect(research.source.package).toBe('example/research-pkg');
    expect(blob.apmLockHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
