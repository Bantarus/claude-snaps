import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
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
  hooks?: {
    SessionStart?: HookMatcher[];
    UserPromptSubmit?: HookMatcher[];
  };
  [key: string]: unknown;
}

const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit'] as const;
type HookEvent = (typeof HOOK_EVENTS)[number];

export async function cmdInstallHook(parsed: ParsedArgs): Promise<number> {
  const cwd = process.cwd();
  const force = parsed.flags['force'] === true;

  // 1. .harness/ must exist — install-hook is a harness-repo operation.
  if (!existsSync(join(cwd, '.harness'))) {
    throw new IoError(`not in a harness repo (no .harness/ at ${cwd}). Run 'harness init' first.`);
  }

  // 2. Compute .claude/ path. We DO NOT create it here — that has to
  //    wait until after the user confirms (step 9) so a `n` answer
  //    leaves zero side effects. Downstream steps (read settings,
  //    git hygiene, symlink check) all handle a missing .claude/.
  const claudeDir = join(cwd, '.claude');
  const claudeDirCreatedHere = !existsSync(claudeDir);

  const settingsPath = join(claudeDir, 'settings.json');

  // 2.5. Refuse on symlinks. install-hook writes (via .bak backup +
  //      atomic temp+rename) to settings.json; if .claude/ or
  //      settings.json is a symlink — accidental or hostile — we
  //      would follow it and target the link's destination, which
  //      could be any file the user can write. lstatSync inspects
  //      the link itself rather than its target. --force is the
  //      escape hatch for users who knowingly maintain a symlinked
  //      .claude/.
  if (!force) {
    try {
      if (lstatSync(claudeDir).isSymbolicLink()) {
        throw new IoError(
          `.claude/ is a symbolic link. Refusing to write through it; pass --force to override.`,
        );
      }
    } catch (cause) {
      if (cause instanceof IoError) throw cause;
      // lstat of an absent .claude/ shouldn't happen (we just created
      // it or verified it above), but if it does, fall through.
    }
    if (existsSync(settingsPath)) {
      try {
        if (lstatSync(settingsPath).isSymbolicLink()) {
          throw new IoError(
            `.claude/settings.json is a symbolic link. Refusing to write through it; pass --force to override.`,
          );
        }
      } catch (cause) {
        if (cause instanceof IoError) throw cause;
        // Same fall-through as above.
      }
    }
  }

  // 3. Git hygiene: refuse if settings.json has unstaged changes (only
  //    when in a git repo and --force is not set). Untracked ('??') and
  //    ignored ('!!') files are out of scope: they have no committed
  //    baseline to be lost. The intent is to protect tracked content
  //    from silent overwrite, not to refuse on any pre-existing file.
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
    // git porcelain v1 format: 'XY <path>' where XY are exactly 2 status
    // chars. We rely on this; v2 has a different shape — do not switch.
    const lines = porcelain.split('\n').filter((l) => l.length > 0);
    const dirty = lines.some((l) => {
      const status = l.slice(0, 2);
      return status !== '??' && status !== '!!';
    });
    if (dirty) {
      throw new IoError(
        `.claude/settings.json has unstaged git changes. Commit, stash, or pass --force.`,
      );
    }
  }

  // 4. Read current settings. Missing → empty; invalid → refuse.
  const before: SettingsShape = readSettingsOrRefuse(settingsPath);

  // 5. Compute new settings: deep-clone, append our hook entry to BOTH
  //    SessionStart and UserPromptSubmit (v0.2.0 dual-event capture).
  const after: SettingsShape = JSON.parse(JSON.stringify(before)) as SettingsShape;
  after.hooks = after.hooks ?? {};

  let alreadyHas = false;
  for (const event of HOOK_EVENTS) {
    const list = (after.hooks[event] ?? []) as HookMatcher[];
    if (list.some((m) =>
      (m.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes('harness-hook')),
    )) {
      alreadyHas = true;
    }
  }

  // 6. Refuse re-install unless --force.
  if (alreadyHas && !force) {
    throw new IoError(
      `harness-hook is already installed in .claude/settings.json. Pass --force to reinstall.`,
    );
  }

  for (const event of HOOK_EVENTS) {
    after.hooks[event] = (after.hooks[event] ?? []) as HookMatcher[];
    if (alreadyHas && force) {
      // Strip existing harness-hook entries so --force truly reinstalls
      // without leaving zombies.
      after.hooks[event] = after.hooks[event]!
        .map((m) => ({
          ...m,
          hooks: (m.hooks ?? []).filter(
            (h) => !(typeof h.command === 'string' && h.command.includes('harness-hook')),
          ),
        }))
        .filter((m) => (m.hooks ?? []).length > 0);
    }
    after.hooks[event]!.push({
      matcher: '*',
      hooks: [{ type: 'command', command: HOOK_COMMAND }],
    });
  }

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

  // 10. Now that the user has confirmed, ensure .claude/ exists
  //     (deferred from step 2 so a `n` answer leaves no side effects)
  //     and atomically write the new settings.
  if (claudeDirCreatedHere) {
    mkdirSync(claudeDir, { recursive: true });
    process.stderr.write(`Created .claude/ — this is normally Claude Code's config dir.\n`);
  }
  atomicWrite(settingsPath, afterStr + '\n');
  process.stdout.write(
    `Hook installed. Next session start AND every user prompt in this ` +
    `directory will be captured by harness-hook.\n`,
  );
  return 0;
}

// Suppress unused-import lint for HookEvent type (referenced via HOOK_EVENTS).
const _hookEventType: HookEvent = 'SessionStart';
void _hookEventType;

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
