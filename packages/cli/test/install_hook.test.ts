import { describe, expect, test } from 'vitest';
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
