import { HarnessError } from '@harness/core';
import { cmdInit } from './commands/init.js';
import { cmdLog } from './commands/log.js';
import { cmdDiff } from './commands/diff.js';
import { cmdTag } from './commands/tag.js';
import { cmdBranch } from './commands/branch.js';
import { cmdCheckout } from './commands/checkout.js';
import { cmdReindex } from './commands/reindex.js';
import { cmdInstallHook } from './commands/install_hook.js';
import { cmdSnap } from './commands/snap.js';
import { cmdSessions } from './commands/sessions.js';
import { cmdNotes } from './commands/notes.js';

export interface ParsedArgs {
  command: string | null;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Hand-rolled argv parser. Shape: `harness <command> [args...] [--flags]`.
 * Long flags only (--force, --limit=N, --branch=name); -h is the only
 * short flag. Both `--flag=value` and `--flag value` accepted.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  let command: string | null = null;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h' || a === '--help') {
      flags['help'] = true;
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
      continue;
    }
    if (a.startsWith('-')) {
      // Single short flags with values are added on demand. Default
      // behavior throws so typos surface rather than being silently
      // dropped. (v0.3 has no short-flag-with-value commands; -m on
      // `harness snap` was retired in favor of the required positional
      // note argument.)
      throw new Error(`unknown short flag: ${a}`);
    }
    if (command === null) command = a;
    else positional.push(a);
  }
  return { command, positional, flags };
}

const HELP = `Usage: harness <command> [args...] [--flags]

Commands:
  init [--branch=<name>]                  Initialize a new .harness/ in cwd.
  log [--branch=<name>] [--limit=N]
      [--with-sessions]                   List snapshots, newest first; per-row
                                            diff summary computed at read time.
  diff <a> <b>                            Diff two snapshots' modules.
  snap "<note>"                           Capture current state and attach a note.
                                            Note is required; there is no anonymous
                                            CLI capture.
  sessions [<session-id>]                 List sessions, or render a trajectory
                                            (notes inline, marked with @).
  notes <snapshot-ref>                    List every note ever attached to a
                                            snapshot, across sessions.
  tag <name> [<id>] [--force]             Tag a snapshot (defaults to HEAD).
  branch <name> [<id>] [--force]          Create a branch at <id> or HEAD.
  checkout <ref>                          Move HEAD to <ref>.
  reindex                                 Rebuild lineage.sqlite from snapshots/.
  install-hook [--force]                  Wire harness-hook into .claude/settings.json
                                            (SessionStart + UserPromptSubmit).

Refs accept: 40-hex id, 6+-hex prefix, HEAD, branch name, tag name.

Exit codes: 0 success, 1 user error, 2 internal bug.
See spec/ in the repo for the full .harness/ format spec.
`;

export async function dispatch(parsed: ParsedArgs): Promise<number> {
  switch (parsed.command) {
    case 'init':         return cmdInit(parsed);
    case 'log':          return cmdLog(parsed);
    case 'diff':         return cmdDiff(parsed);
    case 'snap':         return cmdSnap(parsed);
    case 'sessions':     return cmdSessions(parsed);
    case 'notes':        return cmdNotes(parsed);
    case 'tag':          return cmdTag(parsed);
    case 'branch':       return cmdBranch(parsed);
    case 'checkout':     return cmdCheckout(parsed);
    case 'reindex':      return cmdReindex(parsed);
    case 'install-hook': return cmdInstallHook(parsed);
    case null:
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`harness: unknown command '${parsed.command}'\n\n${HELP}`);
      return 1;
  }
}

export async function run(argv: string[]): Promise<void> {
  let code = 2;
  try {
    const parsed = parseArgs(argv);
    if (parsed.flags['help']) {
      process.stdout.write(HELP);
      code = 0;
    } else {
      code = await dispatch(parsed);
    }
  } catch (err) {
    if (err instanceof HarnessError) {
      process.stderr.write(`harness: ${err.name}: ${err.message}\n`);
      code = 1;
    } else if (err instanceof Error && /^unknown short flag|empty ref/.test(err.message)) {
      process.stderr.write(`harness: ${err.message}\n`);
      code = 1;
    } else {
      process.stderr.write(`harness: internal error\n${(err as Error).stack ?? err}\n`);
      code = 2;
    }
  }
  process.exit(code);
}
