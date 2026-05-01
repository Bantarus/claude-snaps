// Three input channels per Claude Code's actual hook contract (verified
// against current docs, 2026-05):
//
//   1. stdin JSON — the canonical Claude Code path. The host passes:
//        { session_id, cwd, hook_event_name, transcript_path, source,
//          model, agent_type? }
//      Snake_case fields. session_id and cwd are mandatory; the others
//      are observed-and-ignored in v0.1.
//
//   2. CLI flags — testing path and fallback for hosts that follow our
//      spec/hooks.md description literally:
//        --session-id <id>  --cwd <path>  --reason <auto|manual|fork>
//        --dry-run
//
//   3. Environment — last-resort fallback. CLAUDE_PROJECT_DIR is the
//      one env var Claude Code is documented to set (project root).
//
// Merge rule: stdin wins over CLI wins over env. If after merging we
// still lack session_id or cwd, throw — the hook can't operate.

import { readFileSync } from 'node:fs';

export interface HookArgs {
  sessionId: string;
  cwd: string;
  reason: 'auto' | 'manual' | 'fork';
  source?: string;
  transcriptPath?: string;
  // Session-level context shipped in the SessionStart stdin payload, captured
  // verbatim onto the snapshot blob (spec/format.md §2.1). Both are optional —
  // older hosts and the CLI testing path won't supply them.
  model?: string;
  permissionMode?: string;
  dryRun: boolean;
}

export class HookArgsError extends Error {}

interface RawInputs {
  sessionId?: string;
  cwd?: string;
  reason?: 'auto' | 'manual' | 'fork';
  source?: string;
  transcriptPath?: string;
  model?: string;
  permissionMode?: string;
  dryRun?: boolean;
}

/**
 * Resolve the merged hook input from all three channels.
 *
 * Reads stdin synchronously — Claude Code closes stdin after writing
 * the JSON payload, so a blocking read is safe.
 *
 * @throws {HookArgsError} if neither sessionId nor cwd can be resolved.
 */
export function parseHookArgs(argv: string[]): HookArgs {
  const stdin = readStdinJsonOrEmpty();
  const cli = parseCli(argv);
  const env = readEnv();

  // Merge — stdin > cli > env, field-by-field.
  const merged: RawInputs = {};
  for (const key of [
    'sessionId', 'cwd', 'reason', 'source', 'transcriptPath',
    'model', 'permissionMode', 'dryRun',
  ] as const) {
    if (stdin[key] !== undefined) (merged as Record<string, unknown>)[key] = stdin[key];
    else if (cli[key] !== undefined) (merged as Record<string, unknown>)[key] = cli[key];
    else if (env[key] !== undefined) (merged as Record<string, unknown>)[key] = env[key];
  }

  if (merged.sessionId === undefined) {
    throw new HookArgsError(
      'no session id resolved (checked stdin JSON .session_id, --session-id flag, no env fallback)',
    );
  }
  if (merged.cwd === undefined) {
    throw new HookArgsError(
      'no cwd resolved (checked stdin JSON .cwd, --cwd flag, $CLAUDE_PROJECT_DIR env)',
    );
  }
  const out: HookArgs = {
    sessionId: merged.sessionId,
    cwd: merged.cwd,
    reason: merged.reason ?? 'auto',
    dryRun: merged.dryRun ?? false,
  };
  if (merged.source !== undefined) out.source = merged.source;
  if (merged.transcriptPath !== undefined) out.transcriptPath = merged.transcriptPath;
  if (merged.model !== undefined) out.model = merged.model;
  if (merged.permissionMode !== undefined) out.permissionMode = merged.permissionMode;
  return out;
}

// ── private ────────────────────────────────────────────────────────────────

function readStdinJsonOrEmpty(): RawInputs {
  // If stdin is a TTY, no JSON is forthcoming — return empty.
  if (process.stdin.isTTY) return {};
  let raw: string;
  try {
    raw = readFileSync(0, 'utf-8'); // fd 0 = stdin
  } catch {
    return {};
  }
  if (raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON — could be empty piped input or garbage. Don't throw;
    // CLI args may still provide what we need.
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  const obj = parsed as Record<string, unknown>;
  const out: RawInputs = {};
  if (typeof obj['session_id'] === 'string') out.sessionId = obj['session_id'];
  if (typeof obj['cwd'] === 'string') out.cwd = obj['cwd'];
  if (typeof obj['source'] === 'string') {
    out.source = obj['source'];
    // Map Claude Code's source → our reason. startup/resume/clear/compact → 'auto';
    // anything else stays 'auto' (we treat all as auto-snapshots).
    out.reason = 'auto';
  }
  if (typeof obj['transcript_path'] === 'string') out.transcriptPath = obj['transcript_path'];
  if (typeof obj['model'] === 'string') out.model = obj['model'];
  if (typeof obj['permission_mode'] === 'string') out.permissionMode = obj['permission_mode'];
  return out;
}

function parseCli(argv: string[]): RawInputs {
  const out: RawInputs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case '--session-id': {
        const v = argv[++i];
        if (v !== undefined) out.sessionId = v;
        break;
      }
      case '--cwd': {
        const v = argv[++i];
        if (v !== undefined) out.cwd = v;
        break;
      }
      case '--reason': {
        const v = argv[++i];
        if (v === 'auto' || v === 'manual' || v === 'fork') out.reason = v;
        else throw new HookArgsError(`--reason must be auto|manual|fork (got: ${v})`);
        break;
      }
      case '--dry-run':
        out.dryRun = true;
        break;
      default:
        // Unknown flags accepted-and-ignored. Skip a value if it follows.
        if (a.startsWith('--') && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) {
          i++;
        }
    }
  }
  return out;
}

function readEnv(): RawInputs {
  const out: RawInputs = {};
  if (typeof process.env['CLAUDE_PROJECT_DIR'] === 'string') {
    out.cwd = process.env['CLAUDE_PROJECT_DIR'];
  }
  // No env var for session_id — Claude Code documents none.
  return out;
}
