// Strict whitelist parser for Claude Code transcript JSONL.
//
// Per spec/format.md §10 (Session metrics), this module reads the
// per-session JSONL Claude Code writes to `transcript_path` and emits
// one TurnRecord per `user` or `assistant` line. The hot-path hook
// does NOT run this code; it executes only at `harness ingest-session`
// time, post-hoc and async, with no contribution to hook latency.
//
// Privacy is the load-bearing invariant. Per spec/format.md §10.2 the
// whitelist of stored fields is normative:
//   * sessionId, turn_index (0-based; counted from emitted rows only)
//   * turn_type ('user' | 'assistant')
//   * model
//   * usage (4 token columns)
//   * tool_names_csv (the .name fields only; never tool_use.input)
//   * is_sidechain
//   * attribution_skill
//   * request_id
//   * ingested_at (stamped by caller, not from JSONL)
//
// Forbidden territory — NEVER copied into a TurnRecord:
//   * message.content[*].text   (assistant response text)
//   * message.content[*].input  (tool call arguments)
//   * tool_result.content       (tool output)
//   * user message body         (the prompt)
//   * thinking blocks           (.thinking, .signature)
//   * system_prompt, append_system_prompt
//   * attachment data fields
//   * last_assistant_message    (Stop event payload — same class as prompt)
//
// The implementation discipline (§10.2):
//   1. Whitelist, not blacklist. The parser DOES NOT spread the parsed
//      JSONL line into a row. It pulls each whitelisted field by name.
//      New JSONL fields added by future Claude Code versions are
//      automatically excluded by virtue of not being read.
//   2. Type-tighten at the boundary. parseLine returns TurnRecord | null
//      (null on parse failure or non-message line).
//   3. Tool name canonicalization. Tool names like `mcp__server__tool`
//      are kept verbatim — they are tool registry identifiers, not
//      user content.
//
// The privacy invariant is enforced empirically by W12.5 (the canary
// fuzz gate, step 6 of v0.5.0).

import { readFileSync } from 'node:fs';

import type { TurnRecord } from './types.js';

const ASSISTANT_LINE_TYPES = new Set(['assistant']);
const USER_LINE_TYPES = new Set(['user']);

/**
 * Parse a transcript JSONL and emit TurnRecord rows for every `user`
 * and `assistant` line. Non-message lines (system, queue-operation,
 * attachment, file-history-snapshot, last-prompt, plus any future
 * type) are silently skipped. Trailing partial line is discarded
 * (spec/format.md §10.4).
 *
 * Idempotency: caller supplies `startTurnIndex`. The Nth emitted row
 * carries `turn_index = startTurnIndex + N`. To resume after appended
 * turns: pass `MAX(turn_index) + 1` (or 0 on first ingestion). The
 * parser then walks the whole file but only the suffix beyond the
 * stored prefix actually produces NEW rows; the caller filters them
 * via `INSERT OR IGNORE` on the `(session_id, turn_index)` PK as a
 * second line of defense.
 *
 * `sessionId` and `ingestedAt` are stamped onto each emitted record
 * by the caller (they're shared across the whole batch and are NOT
 * read from the JSONL — sessionId is the host-supplied filename;
 * ingestedAt is the wall-clock at insertion time).
 */
export function parseTranscriptJsonl(
  path: string,
  sessionId: string,
  ingestedAt: string,
): TurnRecordCandidate[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  return parseTranscriptText(raw, sessionId, ingestedAt);
}

/**
 * The pure function form for tests + in-memory ingestion. Same
 * contract as parseTranscriptJsonl but takes the file's bytes
 * directly. The trailing partial line (no `\n` terminator) is
 * silently dropped per §10.4.
 */
export function parseTranscriptText(
  raw: string,
  sessionId: string,
  ingestedAt: string,
): TurnRecordCandidate[] {
  // Slice off the trailing partial line (any bytes after the last
  // `\n`). Return [] when no complete line is present.
  const newlineEnd = raw.lastIndexOf('\n');
  if (newlineEnd < 0) return [];
  const completed = raw.slice(0, newlineEnd);
  const out: TurnRecordCandidate[] = [];
  // Sequential turn_index of emitted rows ONLY — non-message lines
  // do not consume an index. The caller adds startTurnIndex on top
  // when filtering against MAX(turn_index).
  let nthEmitted = 0;
  for (const line of completed.split('\n')) {
    if (line.length === 0) continue;
    const candidate = parseLine(line);
    if (candidate === null) continue;
    out.push({
      ...candidate,
      sessionId,
      turnIndex: nthEmitted,
      ingestedAt,
    });
    nthEmitted++;
  }
  return out;
}

/**
 * The parser for one JSONL line. Returns the whitelisted-field record
 * with `sessionId`/`turnIndex`/`ingestedAt` UNSET (those are filled
 * in by the caller). Returns null on:
 *   * parse failure (malformed JSON, non-object root)
 *   * unsupported `type` (system, queue-operation, attachment,
 *     file-history-snapshot, last-prompt, or anything else)
 *
 * Privacy-load-bearing — every read is by named access on the parsed
 * dict. There is no `...spread` of arbitrary input. Adding a new
 * field requires a corresponding entry in this function and a
 * spec amendment to §10.1 / §10.2.
 */
function parseLine(line: string): Omit<TurnRecord, 'sessionId' | 'turnIndex' | 'ingestedAt'> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const type = obj['type'];
  if (typeof type !== 'string') return null;

  const isSidechain = boolToFlag(obj['isSidechain']);

  if (ASSISTANT_LINE_TYPES.has(type)) {
    return parseAssistantTurn(obj, isSidechain);
  }
  if (USER_LINE_TYPES.has(type)) {
    return parseUserTurn(isSidechain);
  }
  return null;
}

function parseAssistantTurn(
  obj: Record<string, unknown>,
  isSidechain: 0 | 1,
): Omit<TurnRecord, 'sessionId' | 'turnIndex' | 'ingestedAt'> {
  const message = readMessage(obj);

  const model = readString(message, 'model');
  const usage = readObject(message, 'usage');
  const inputTokens = readNumber(usage, 'input_tokens');
  const outputTokens = readNumber(usage, 'output_tokens');
  const cacheCreationInputTokens = readNumber(usage, 'cache_creation_input_tokens');
  const cacheReadInputTokens = readNumber(usage, 'cache_read_input_tokens');

  const toolNames = extractToolNames(message);

  const attributionSkill = readString(obj, 'attributionSkill');
  const requestId = readString(obj, 'requestId');

  return {
    turnType: 'assistant',
    model,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    toolNamesCsv: toolNames.length > 0 ? toolNames.join(',') : null,
    isSidechain,
    attributionSkill,
    requestId,
  };
}

function parseUserTurn(
  isSidechain: 0 | 1,
): Omit<TurnRecord, 'sessionId' | 'turnIndex' | 'ingestedAt'> {
  // User turns: only structural identifiers are recorded. The
  // message.content body — whether the user's prompt text or a
  // tool_result block — is NEVER read. Tokens are not reported on
  // user turns by Claude Code (they appear on the next assistant
  // turn's usage block as input/cache figures), so all four token
  // columns are null.
  return {
    turnType: 'user',
    model: null,
    inputTokens: null,
    outputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    toolNamesCsv: null,
    isSidechain,
    attributionSkill: null,
    requestId: null,
  };
}

/**
 * Extract `name` from every `content[*]` block of `type: "tool_use"`.
 * Order is preserved (matching tool-call order within the turn).
 * `tool_use.input` is INTENTIONALLY NOT READ — that's the tool call's
 * arguments and falls under the §10.2 forbidden whitelist.
 */
function extractToolNames(message: Record<string, unknown> | null): string[] {
  if (message === null) return [];
  const content = message['content'];
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue;
    const b = block as Record<string, unknown>;
    if (b['type'] !== 'tool_use') continue;
    const name = b['name'];
    if (typeof name === 'string' && name.length > 0) names.push(name);
  }
  return names;
}

// ── strict named accessors ─────────────────────────────────────────────

function readMessage(obj: Record<string, unknown>): Record<string, unknown> | null {
  const m = obj['message'];
  if (m === null || typeof m !== 'object' || Array.isArray(m)) return null;
  return m as Record<string, unknown>;
}

function readObject(
  obj: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  if (obj === null) return null;
  const v = obj[key];
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function readString(obj: Record<string, unknown> | null, key: string): string | null {
  if (obj === null) return null;
  const v = obj[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function readNumber(obj: Record<string, unknown> | null, key: string): number | null {
  if (obj === null) return null;
  const v = obj[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function boolToFlag(v: unknown): 0 | 1 {
  return v === true ? 1 : 0;
}

/**
 * A TurnRecord-shaped row produced by the parser. Identical to
 * TurnRecord but published separately to make "this came from the
 * parser, not the database" explicit at the type level.
 */
export type TurnRecordCandidate = TurnRecord;
