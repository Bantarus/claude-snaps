import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { IoError, ParseError } from '@harness/core';
import { c, jsonDiff } from '../format.js';
import { confirm } from '../prompt.js';
import type { ParsedArgs } from '../main.js';

// install-hook is the only CLI command that mutates user state outside
// `.harness/`. Strict policy (pinned in B2):
//   - always backup .claude/settings.json to settings.json.harness-backup
//     before writing, regardless of --force.
//   - always show the user a unified diff of the planned change.
//   - always prompt y/N. No --yes flag.
//   - refuse if .claude/settings.json has unstaged git changes — but only
//     when the project IS a git repo (existsSync('.git')); skip the
//     check silently otherwise. --force overrides.
//   - never overwrite invalid JSON; refuse and ask the user to clean it up.
//   - never overwrite an existing harness-hook entry; --force replaces.
//
// The hook entry shape matches Claude Code's expected format; the matcher
// is "*" (fire on every session start).

// Claude Code passes hook input as JSON on stdin: { session_id, cwd,
// hook_event_name, transcript_path, source, ... }. The hook reads stdin
// itself — no CLI flags needed at install time. (CLI flags remain
// available for testing the hook outside Claude Code.)
const HOOK_COMMAND = 'harness-hook';

interface HookEntry {
  type: 'command';
  command: string;
}
interface HookMatcher {
  matcher: string;
  hooks: HookEntry[];
}
interface SettingsShape {
  hooks?: { SessionStart?: HookMatcher[] };
  [key: string]: unknown;
}

export async function cmdInstallHook(parsed: ParsedArgs): Promise<number> {
  const cwd = process.cwd();
  const force = parsed.flags['force'] === true;

  // 1. .harness/ must exist — install-hook is a harness-repo operation.
  if (!existsSync(join(cwd, '.harness'))) {
    throw new IoError(`not in a harness repo (no .harness/ at ${cwd}). Run 'harness init' first.`);
  }

  // 2. Ensure .claude/ exists; create on demand with a heads-up.
  const claudeDir = join(cwd, '.claude');
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
    process.stderr.write(`Created .claude/ — this is normally Claude Code's config dir.\n`);
  }

  const settingsPath = join(claudeDir, 'settings.json');

  // 3. Git hygiene: refuse if settings.json has unstaged changes (only
  //    when in a git repo and --force is not set).
  if (!force && existsSync(join(cwd, '.git')) && existsSync(settingsPath)) {
    let porcelain = '';
    try {
      porcelain = execFileSync(
        'git', ['status', '--porcelain', '--', '.claude/settings.json'],
        { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
    } catch {
      // git unavailable; treat as non-git repo (already in fail-open mode).
    }
    if (porcelain.trim() !== '') {
      throw new IoError(
        `.claude/settings.json has unstaged git changes. Commit, stash, or pass --force.`,
      );
    }
  }

  // 4. Read current settings. Missing → empty; invalid → refuse.
  const before: SettingsShape = readSettingsOrRefuse(settingsPath);

  // 5. Compute new settings: deep-clone, append our hook entry.
  const after: SettingsShape = JSON.parse(JSON.stringify(before)) as SettingsShape;
  after.hooks = after.hooks ?? {};
  after.hooks.SessionStart = after.hooks.SessionStart ?? [];

  // 6. Refuse re-install unless --force.
  const alreadyHas = (after.hooks.SessionStart ?? []).some((m) =>
    (m.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes('harness-hook')),
  );
  if (alreadyHas && !force) {
    throw new IoError(
      `harness-hook is already installed in .claude/settings.json. Pass --force to reinstall.`,
    );
  }
  if (alreadyHas && force) {
    // Strip existing harness-hook entries so --force truly reinstalls
    // without leaving zombies.
    after.hooks.SessionStart = after.hooks.SessionStart!
      .map((m) => ({
        ...m,
        hooks: (m.hooks ?? []).filter(
          (h) => !(typeof h.command === 'string' && h.command.includes('harness-hook')),
        ),
      }))
      .filter((m) => (m.hooks ?? []).length > 0);
  }

  after.hooks.SessionStart.push({
    matcher: '*',
    hooks: [{ type: 'command', command: HOOK_COMMAND }],
  });

  // 7. Backup BEFORE writing — even on --force.
  if (existsSync(settingsPath)) {
    atomicWrite(`${settingsPath}.harness-backup`, readFileSync(settingsPath, 'utf-8'));
  }

  // 8. Show the planned change.
  const beforeStr = JSON.stringify(before, null, 2);
  const afterStr = JSON.stringify(after, null, 2);
  process.stdout.write(`\n${c.bold('Planned change to .claude/settings.json:')}\n\n`);
  process.stdout.write(jsonDiff(beforeStr, afterStr) + '\n\n');

  // 9. Confirm.
  const ok = await confirm('Apply this change? [y/N] ');
  if (!ok) {
    process.stdout.write(`Aborted. No changes made.\n`);
    return 0;
  }

  // 10. Atomic write of the new settings.
  atomicWrite(settingsPath, afterStr + '\n');
  process.stdout.write(
    `Hook installed. Next Claude Code session in this directory will be auto-snapshotted.\n`,
  );
  return 0;
}

// ── private ────────────────────────────────────────────────────────────────

function readSettingsOrRefuse(path: string): SettingsShape {
  if (!existsSync(path)) return {};
  let raw: string;
  try { raw = readFileSync(path, 'utf-8'); }
  catch (cause) { throw new IoError(`failed to read ${path}`, cause); }
  if (raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ParseError(`${path} is not a JSON object`);
    }
    return parsed as SettingsShape;
  } catch (cause) {
    throw new ParseError(
      `${path} is not valid JSON; refusing to overwrite. Fix it by hand and re-run.`,
      cause,
    );
  }
}

function atomicWrite(path: string, contents: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, contents, 'utf-8');
  const fd = openSync(tmp, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}
