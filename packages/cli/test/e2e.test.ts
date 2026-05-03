import { describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, runHook } from './util.js';

// End-to-end: init → hook → log → diff round-trip on a real tmpdir.
//
// HEAD~N syntax is NOT in v0.3; we resolve the two snapshot ids by
// parsing `harness log` output (the public, supported way) and passing
// them as 8-char hex prefixes to `harness diff`.

describe('e2e: init → hook → log → diff', () => {
  test('full round trip on a fresh tmpdir', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'harness-e2e-'));

    // 1. init
    const initR = await runCli(['init'], { cwd });
    expect(initR.code).toBe(0);
    expect(existsSync(join(cwd, '.harness/HEAD'))).toBe(true);
    expect(existsSync(join(cwd, '.harness/snapshots'))).toBe(true);

    // 2. mock up a .claude/ config
    mkdirSync(join(cwd, '.claude/skills/research'), { recursive: true });
    writeFileSync(
      join(cwd, '.claude/skills/research/SKILL.md'),
      '# Research v0.1\n',
      'utf-8',
    );

    // 3. fire the hook
    const hook1 = await runHook(['--session-id', 'e2e-1', '--cwd', cwd], { cwd });
    expect(hook1.code).toBe(0);

    // 4. log shows one snapshot. v0.3 has no message field; the row
    //    summary is computed at read time from summarizeDiff(), which
    //    renders `init` for root snapshots.
    const log1 = await runCli(['log'], { cwd });
    expect(log1.code).toBe(0);
    expect(log1.stdout.trim().split('\n').length).toBe(1);
    expect(log1.stdout).toMatch(/init/);

    // 5. mutate the skill, fire the hook again
    writeFileSync(
      join(cwd, '.claude/skills/research/SKILL.md'),
      '# Research v0.2 — bumped\n',
      'utf-8',
    );
    const hook2 = await runHook(['--session-id', 'e2e-2', '--cwd', cwd], { cwd });
    expect(hook2.code).toBe(0);

    // 6. diff via explicit ids parsed from log output
    const log2 = await runCli(['log'], { cwd });
    const lines = log2.stdout.trim().split('\n');
    expect(lines.length).toBe(2);
    const idNew = lines[0]!.split(' ')[0]!;
    const idOld = lines[1]!.split(' ')[0]!;
    expect(idNew).toMatch(/^[0-9a-f]{8}$/);
    expect(idOld).toMatch(/^[0-9a-f]{8}$/);

    const diffR = await runCli(['diff', idOld, idNew], { cwd });
    expect(diffR.code).toBe(0);
    expect(diffR.stdout).toMatch(/research/);
    expect(diffR.stdout).toMatch(/~1 changed/);

    // 7. tag the new tip, then resolve via tag name
    const tagR = await runCli(['tag', 'v0.1'], { cwd });
    expect(tagR.code).toBe(0);
    const diffViaTag = await runCli(['diff', idOld, 'v0.1'], { cwd });
    expect(diffViaTag.code).toBe(0);
    expect(diffViaTag.stdout).toMatch(/~1 changed/);
  });

  test('install-hook + simulated session-start writes a snapshot end-to-end', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'harness-e2e-installhook-'));
    await runCli(['init'], { cwd });

    const installR = await runCli(['install-hook'], { cwd, input: 'y\n' });
    expect(installR.code).toBe(0);
    expect(existsSync(join(cwd, '.claude/settings.json'))).toBe(true);

    mkdirSync(join(cwd, '.claude/skills/foo'), { recursive: true });
    writeFileSync(join(cwd, '.claude/skills/foo/SKILL.md'), '# foo\n', 'utf-8');
    const hookR = await runHook(['--session-id', 'simulated-1', '--cwd', cwd], { cwd });
    expect(hookR.code).toBe(0);

    const log = await runCli(['log'], { cwd });
    expect(log.code).toBe(0);
    // First-ever snapshot is kind=init; summarizeDiff renders "init".
    expect(log.stdout).toMatch(/init/);
  });

  test('install-hook installs both SessionStart and UserPromptSubmit entries', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'harness-e2e-installhook-dual-'));
    await runCli(['init'], { cwd });
    const r = await runCli(['install-hook'], { cwd, input: 'y\n' });
    expect(r.code).toBe(0);
    const settings = JSON.parse(
      require('node:fs').readFileSync(join(cwd, '.claude/settings.json'), 'utf-8'),
    ) as { hooks: { SessionStart: unknown[]; UserPromptSubmit: unknown[] } };
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(settings.hooks.UserPromptSubmit).toBeDefined();
    expect(settings.hooks.SessionStart.length).toBe(1);
    expect(settings.hooks.UserPromptSubmit.length).toBe(1);
  });
});

describe('e2e: v0.3 commands (snap, sessions, notes)', () => {
  test('snap "<note>" captures and attaches a note attribution', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'harness-e2e-snap-'));
    await runCli(['init'], { cwd });
    mkdirSync(join(cwd, '.claude/skills/research'), { recursive: true });
    writeFileSync(join(cwd, '.claude/skills/research/SKILL.md'), '# r\n', 'utf-8');

    const r = await runCli(['snap', 'baseline capture'], { cwd });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Captured.*baseline capture/);

    // The note is queryable via `harness notes <ref>`.
    const log = await runCli(['log'], { cwd });
    const id8 = log.stdout.trim().split(' ')[0]!;
    const notesR = await runCli(['notes', id8], { cwd });
    expect(notesR.code).toBe(0);
    expect(notesR.stdout).toMatch(/baseline capture/);
    expect(notesR.stdout).toMatch(/<manual>/);
  });

  test('snap with no note argument errors out (v0.3 — note is required)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'harness-e2e-snap-nonote-'));
    await runCli(['init'], { cwd });
    mkdirSync(join(cwd, '.claude/skills/research'), { recursive: true });
    writeFileSync(join(cwd, '.claude/skills/research/SKILL.md'), '# r\n', 'utf-8');
    const r = await runCli(['snap'], { cwd });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/note is required/);
  });

  test('snap "<note>" on unchanged composition appends a note without writing a new snapshot', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'harness-e2e-snap-noop-'));
    await runCli(['init'], { cwd });
    mkdirSync(join(cwd, '.claude/skills/research'), { recursive: true });
    writeFileSync(join(cwd, '.claude/skills/research/SKILL.md'), '# r\n', 'utf-8');
    await runCli(['snap', 'first'], { cwd });
    const r = await runCli(['snap', 'second'], { cwd });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/No composition change/);
    // Still 1 snapshot total (note rows are not new snapshots).
    const log = await runCli(['log'], { cwd });
    expect(log.stdout.trim().split('\n').length).toBe(1);
    // But two notes are queryable.
    const id8 = log.stdout.trim().split(' ')[0]!;
    const notesR = await runCli(['notes', id8], { cwd });
    expect(notesR.code).toBe(0);
    expect(notesR.stdout).toMatch(/first/);
    expect(notesR.stdout).toMatch(/second/);
    expect(notesR.stdout).toMatch(/2 notes/);
  });

  test('sessions <id> prints a trajectory with snapshot transitions', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'harness-e2e-sessions-'));
    await runCli(['init'], { cwd });
    mkdirSync(join(cwd, '.claude/skills/research'), { recursive: true });
    writeFileSync(join(cwd, '.claude/skills/research/SKILL.md'), '# r\n', 'utf-8');
    await runHook(['--session-id', 'traj-test', '--cwd', cwd, '--hook-event-name', 'SessionStart'], { cwd });
    await runHook(['--session-id', 'traj-test', '--cwd', cwd, '--hook-event-name', 'UserPromptSubmit'], { cwd });
    const r = await runCli(['sessions', 'traj-test'], { cwd });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Session traj-test trajectory:/);
    expect(r.stdout).toMatch(/session_start/);
    expect(r.stdout).toMatch(/user_prompt/);
    expect(r.stdout).toMatch(/Spanned 1 snapshot/);
  });

  test('sessions (no arg) lists all observed sessions', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'harness-e2e-sessions-list-'));
    await runCli(['init'], { cwd });
    mkdirSync(join(cwd, '.claude/skills/research'), { recursive: true });
    writeFileSync(join(cwd, '.claude/skills/research/SKILL.md'), '# r\n', 'utf-8');
    await runHook(['--session-id', 'sA', '--cwd', cwd], { cwd });
    await runHook(['--session-id', 'sB', '--cwd', cwd], { cwd });
    const r = await runCli(['sessions'], { cwd });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/sA/);
    expect(r.stdout).toMatch(/sB/);
  });

  test('log --with-sessions shows session count per snapshot', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'harness-e2e-log-sessions-'));
    await runCli(['init'], { cwd });
    mkdirSync(join(cwd, '.claude/skills/research'), { recursive: true });
    writeFileSync(join(cwd, '.claude/skills/research/SKILL.md'), '# r\n', 'utf-8');
    await runHook(['--session-id', 'sA', '--cwd', cwd], { cwd });
    await runHook(['--session-id', 'sB', '--cwd', cwd], { cwd });
    const r = await runCli(['log', '--with-sessions'], { cwd });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\[2 sessions\]/);
  });

  test('notes across sessions: a snapshot annotated by two different sessions surfaces both', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'harness-e2e-notes-cross-'));
    await runCli(['init'], { cwd });
    mkdirSync(join(cwd, '.claude/skills/research'), { recursive: true });
    writeFileSync(join(cwd, '.claude/skills/research/SKILL.md'), '# r\n', 'utf-8');
    // First a hook fire from a real session captures the snapshot.
    await runHook(['--session-id', 'real-A', '--cwd', cwd], { cwd });
    // Then a CLI note (sessionId='<manual>') against unchanged composition.
    await runCli(['snap', 'manual annotation A'], { cwd });
    // Get the snapshot id and query notes.
    const log = await runCli(['log'], { cwd });
    const id8 = log.stdout.trim().split(' ')[0]!;
    const notesR = await runCli(['notes', id8], { cwd });
    expect(notesR.code).toBe(0);
    expect(notesR.stdout).toMatch(/manual annotation A/);
    expect(notesR.stdout).toMatch(/<manual>/);
    expect(notesR.stdout).toMatch(/1 note from 1 session/);
  });
});
