// Three input channels per Claude Code's actual hook contract (verified
// against current docs, 2026-05):
//
//   1. stdin JSON — the canonical Claude Code path. The host passes:
//        { session_id, cwd, hook_event_name, transcript_path, source,
//          model, agent_type? }
//      Snake_case fields. session_id, cwd, and hook_event_name are the
//      operational core; the others enrich newly-written snapshots.
//
//   2. CLI flags — testing path and fallback for hosts that follow our
//      spec/hooks.md description literally:
//        --session-id <id>  --cwd <path>  --hook-event-name <name>
//        --dry-run
//
//   3. Environment — last-resort fallback. CLAUDE_PROJECT_DIR is the
//      one env var Claude Code is documented to set (project root).
//
// Merge rule: stdin wins over CLI wins over env. If after merging we
// still lack session_id or cwd, throw — the hook can't operate.

import { readSync } from 'node:fs';

// Defensive cap on stdin payload size. Claude Code hook payloads are
// ~5–6 small JSON fields (well under 1 KiB); 1 MiB is generously
// above the largest defensible payload while still bounding memory
// against a misbehaving host or hostile pipe input. Overflow is
// treated as malformed and surfaces as an empty RawInputs object —
// the hook's outer exit-0 contract (spec/hooks.md §1.5) is preserved.
const STDIN_MAX_BYTES = 1_048_576;

export type HookEventName = 'SessionStart' | 'UserPromptSubmit';

export interface HookArgs {
  sessionId: string;
  cwd: string;
  // 'SessionStart' (fresh session) or 'UserPromptSubmit' (any prompt,
  // including the first prompt of a resumed session). Defaults to
  // 'SessionStart' when stdin/CLI omits it — preserves backward-compat
  // with older invocations that didn't carry the event name.
  hookEventName: HookEventName;
  source?: string;
  transcriptPath?: string;
  // Session-level context shipped in the hook stdin payload, captured
  // verbatim onto the snapshot blob (spec/format.md §2.1). All optional.
  model?: string;
  permissionMode?: string;
  dryRun: boolean;
}

export class HookArgsError extends Error {}

interface RawInputs {
  sessionId?: string;
  cwd?: string;
  hookEventName?: HookEventName;
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
    'sessionId', 'cwd', 'hookEventName', 'source', 'transcriptPath',
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
    hookEventName: merged.hookEventName ?? 'SessionStart',
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
    // Bounded read: previously `readFileSync(0, 'utf-8')` read stdin
    // to EOF with no size limit. A misbehaving host (or hostile pipe)
    // piping a multi-GB payload would OOM the hook process — the
    // RangeError thrown by the allocation itself bypasses our outer
    // try/catch and breaks the spec/hooks.md §1.5 always-exit-0
    // contract. Cap at STDIN_MAX_BYTES; overflow → return empty.
    const buf = Buffer.allocUnsafe(STDIN_MAX_BYTES + 1);
    let total = 0;
    while (total <= STDIN_MAX_BYTES) {
      const n = readSync(0, buf, total, buf.length - total, null);
      if (n <= 0) break;
      total += n;
    }
    if (total > STDIN_MAX_BYTES) return {};
    raw = buf.subarray(0, total).toString('utf-8');
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
  if (typeof obj['hook_event_name'] === 'string') {
    const hen = obj['hook_event_name'];
    if (hen === 'SessionStart' || hen === 'UserPromptSubmit') {
      out.hookEventName = hen;
    }
    // Other event names (PreCompact, SessionEnd, ConfigChange) are
    // observed-and-ignored in v0.2 — fall through to the default
    // ('SessionStart') so the hook still records something useful if
    // a host fires an event we don't yet specifically handle.
  }
  if (typeof obj['source'] === 'string') out.source = obj['source'];
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
      case '--hook-event-name': {
        const v = argv[++i];
        if (v === 'SessionStart' || v === 'UserPromptSubmit') out.hookEventName = v;
        else throw new HookArgsError(`--hook-event-name must be SessionStart|UserPromptSubmit (got: ${v})`);
        break;
      }
      case '--reason': {
        // Accept-and-ignore for back-compat with v0.1 invocations.
        argv[++i];
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
