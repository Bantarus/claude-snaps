import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './util.js';

function freshProject(): string {
  return mkdtempSync(join(tmpdir(), 'harness-installhook-'));
}

async function initRepo(cwd: string): Promise<void> {
  const r = await runCli(['init'], { cwd });
  if (r.code !== 0) throw new Error(`init failed: ${r.stderr}`);
}

// Initialize a git repo with one commit so the install-hook git-hygiene
// gate (existsSync('.git')) is exercised. Without this setup the gate
// short-circuits silently — see the v0.3 soak finding #3 investigation.
function gitInitWithCommit(cwd: string): void {
  const opts = { cwd, stdio: 'ignore' as const };
  execFileSync('git', ['init', '-q', '-b', 'main'], opts);
  execFileSync('git', ['config', 'user.email', 't@harness.test'], opts);
  execFileSync('git', ['config', 'user.name', 'Harness Test'], opts);
  writeFileSync(join(cwd, 'README.md'), '# test\n');
  execFileSync('git', ['add', 'README.md'], opts);
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'], opts);
}

describe('harness install-hook', () => {
  test('refuses outside a harness repo', async () => {
    const cwd = freshProject();
    const r = await runCli(['install-hook'], { cwd, input: 'y\n' });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not in a harness repo/);
  });

  test('on confirmation, writes hook entry into .claude/settings.json and creates backup', async () => {
    const cwd = freshProject();
    await initRepo(cwd);
    const r = await runCli(['install-hook'], { cwd, input: 'y\n' });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Hook installed/);

    const settings = JSON.parse(readFileSync(join(cwd, '.claude/settings.json'), 'utf-8')) as Record<string, unknown>;
    const hooks = settings['hooks'] as { SessionStart?: Array<{ hooks: Array<{ command: string }> }> };
    expect(hooks?.SessionStart?.length).toBeGreaterThan(0);
    const cmds = hooks!.SessionStart!.flatMap((m) => m.hooks).map((h) => h.command);
    expect(cmds.some((c) => c.includes('harness-hook'))).toBe(true);
    // settings.json was missing before — backup is only created when there
    // was something to back up.
  });

  test('on N (or empty), aborts without writing settings.json', async () => {
    const cwd = freshProject();
    await initRepo(cwd);
    const r = await runCli(['install-hook'], { cwd, input: 'n\n' });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Aborted/);
    expect(existsSync(join(cwd, '.claude/settings.json'))).toBe(false);
  });

  test('preserves existing non-harness hooks; appends ours', async () => {
    const cwd = freshProject();
    await initRepo(cwd);
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(
      join(cwd, '.claude/settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { matcher: '*', hooks: [{ type: 'command', command: 'echo other-hook' }] },
          ],
        },
        otherKey: 'preserved',
      }, null, 2),
      'utf-8',
    );

    const r = await runCli(['install-hook'], { cwd, input: 'y\n' });
    expect(r.code).toBe(0);

    const settings = JSON.parse(readFileSync(join(cwd, '.claude/settings.json'), 'utf-8')) as Record<string, unknown>;
    const hooks = settings['hooks'] as { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    const cmds = hooks.SessionStart.flatMap((m) => m.hooks).map((h) => h.command);
    expect(cmds.some((c) => c.includes('echo other-hook'))).toBe(true);
    expect(cmds.some((c) => c.includes('harness-hook'))).toBe(true);
    expect(settings['otherKey']).toBe('preserved');
    // Backup was made because settings.json existed before.
    expect(existsSync(join(cwd, '.claude/settings.json.harness-backup'))).toBe(true);
  });

  test('refuses re-install without --force', async () => {
    const cwd = freshProject();
    await initRepo(cwd);
    await runCli(['install-hook'], { cwd, input: 'y\n' });
    const r = await runCli(['install-hook'], { cwd, input: 'y\n' });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/already installed/);
  });

  test('--force replaces existing harness-hook entries', async () => {
    const cwd = freshProject();
    await initRepo(cwd);
    await runCli(['install-hook'], { cwd, input: 'y\n' });
    const r = await runCli(['install-hook', '--force'], { cwd, input: 'y\n' });
    expect(r.code).toBe(0);
    const settings = JSON.parse(readFileSync(join(cwd, '.claude/settings.json'), 'utf-8')) as Record<string, unknown>;
    const hooks = settings['hooks'] as { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    const cmds = hooks.SessionStart.flatMap((m) => m.hooks).map((h) => h.command);
    // Exactly one harness-hook entry — force-reinstall must not duplicate.
    expect(cmds.filter((c) => c.includes('harness-hook')).length).toBe(1);
  });

  // ── git-hygiene gate (v0.3 soak finding #3) ──────────────────────────────
  // Before v0.3.x these paths were untested: install_hook tests ran without
  // `git init`, so the gate at install_hook.ts step 3 short-circuited via
  // existsSync('.git'). The three tests below exercise both branches of
  // the gate and the --force bypass.

  test('git: succeeds with untracked .claude/settings.json (soak repro)', async () => {
    const cwd = freshProject();
    gitInitWithCommit(cwd);
    await initRepo(cwd);
    // Soak's reset.sh writes settings.json before install-hook; at gate
    // time it's untracked ('?? .claude/settings.json' in porcelain).
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(
      join(cwd, '.claude/settings.json'),
      '{"model":"claude-haiku-4-5-20251001"}\n',
      'utf-8',
    );
    const r = await runCli(['install-hook'], { cwd, input: 'y\n' });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Hook installed/);
    const settings = JSON.parse(
      readFileSync(join(cwd, '.claude/settings.json'), 'utf-8'),
    ) as Record<string, unknown>;
    // Pre-existing keys preserved; harness-hook merged in.
    expect(settings['model']).toBe('claude-haiku-4-5-20251001');
    const hooks = settings['hooks'] as { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    expect(hooks.SessionStart.flatMap((m) => m.hooks).map((h) => h.command))
      .toContain('harness-hook');
  });

  test('git: refuses with tracked .claude/settings.json that has unstaged edits', async () => {
    const cwd = freshProject();
    gitInitWithCommit(cwd);
    await initRepo(cwd);
    // Commit the file first, then introduce unstaged edits — that's the
    // failure mode the gate exists to catch.
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, '.claude/settings.json'), '{"a":1}\n', 'utf-8');
    execFileSync('git', ['add', '.claude/settings.json'], { cwd, stdio: 'ignore' });
    execFileSync(
      'git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'add settings'],
      { cwd, stdio: 'ignore' },
    );
    writeFileSync(join(cwd, '.claude/settings.json'), '{"a":2}\n', 'utf-8');
    const r = await runCli(['install-hook'], { cwd, input: 'y\n' });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unstaged git changes/);
    // File untouched: the user's hand-edit is still there.
    expect(readFileSync(join(cwd, '.claude/settings.json'), 'utf-8')).toBe('{"a":2}\n');
  });

  test('git: --force bypasses the gate on tracked-modified file', async () => {
    const cwd = freshProject();
    gitInitWithCommit(cwd);
    await initRepo(cwd);
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, '.claude/settings.json'), '{"a":1}\n', 'utf-8');
    execFileSync('git', ['add', '.claude/settings.json'], { cwd, stdio: 'ignore' });
    execFileSync(
      'git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'add settings'],
      { cwd, stdio: 'ignore' },
    );
    writeFileSync(join(cwd, '.claude/settings.json'), '{"a":2}\n', 'utf-8');
    const r = await runCli(['install-hook', '--force'], { cwd, input: 'y\n' });
    expect(r.code).toBe(0);
    // Backup captures the pre-overwrite content the user might have wanted.
    expect(readFileSync(join(cwd, '.claude/settings.json.harness-backup'), 'utf-8'))
      .toBe('{"a":2}\n');
  });

  test('refuses to overwrite invalid JSON', async () => {
    const cwd = freshProject();
    await initRepo(cwd);
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, '.claude/settings.json'), '{not valid json', 'utf-8');
    const r = await runCli(['install-hook'], { cwd, input: 'y\n' });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not valid JSON/);
  });
});
