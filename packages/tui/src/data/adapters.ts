// Pure conversions from @harness/core types into the TUI's display shapes
// in src/types.ts. The TUI's local types pre-date @harness/core and use a
// slightly older display vocabulary (persona, cmd) that the spec preserves
// as readable aliases (spec/format.md §2.5). Every adapter is a pure
// function — easier to unit-test, no React or fs contact.

import type {
  Module as CoreModule,
  ModuleType as CoreModuleType,
  Snapshot as CoreSnapshot,
  DiffOp as CoreDiffOp,
} from '@harness/core';
import type {
  ModuleRef,
  ModuleType as TuiModuleType,
  Snapshot as TuiSnapshot,
} from '../types.js';

// ── module type ──────────────────────────────────────────────────────────

/**
 * Map a core module type into the TUI's display vocabulary. Keeps the
 * Ink screens' legacy `persona` / `cmd` labels working without a screen
 * rewrite. Per spec/format.md §2.5 these are accepted aliases.
 */
export function moduleTypeFromCore(t: CoreModuleType): TuiModuleType {
  switch (t) {
    case 'chatmode':   return 'persona';
    case 'prompt':     return 'cmd';
    case 'agent':      return 'agent';
    case 'instruction':return 'instruction';
    case 'mcp':        return 'mcp';
    case 'skill':      return 'skill';
    case 'hook':       return 'hook';
    case 'style':      return 'style';
  }
}

// ── module ───────────────────────────────────────────────────────────────

export function moduleFromCore(m: CoreModule): ModuleRef {
  const out: ModuleRef = {
    type: moduleTypeFromCore(m.type),
    name: m.name,
    enabled: m.enabled,
  };
  if (m.version !== undefined) out.version = m.version;
  return out;
}

// ── snapshot ─────────────────────────────────────────────────────────────

const SHORT_ID_LEN = 8;

/**
 * Build the TUI's Snapshot shape from a core Snapshot. Computes ageLabel
 * at read time per pin #6 (don't pollute core with display formatting),
 * and shortens the 40-hex id and codePin for display since the TUI was
 * built around 3–6 char ids.
 */
export function snapshotFromCore(s: CoreSnapshot, now: Date = new Date()): TuiSnapshot {
  const out: TuiSnapshot = {
    id: s.id.slice(0, SHORT_ID_LEN),
    parentIds: s.parentIds.map((p) => p.slice(0, SHORT_ID_LEN)),
    branch: s.branch,
    kind: s.kind,
    message: s.message,
    codePin: s.codePin !== null ? s.codePin.slice(0, 6) : '—',
    ageLabel: ageLabelOf(s.createdAt, now),
    modules: s.modules.map(moduleFromCore),
  };
  if (s.version !== undefined) out.version = s.version;
  if (s.sessionId !== undefined) out.sessionId = s.sessionId;
  return out;
}

// ── diff ─────────────────────────────────────────────────────────────────

export interface TuiDiffRow {
  state: 'same' | 'added' | 'removed' | 'changed';
  left?: { type: TuiModuleType; name: string; version?: string };
  right?: { type: TuiModuleType; name: string; version?: string };
}

/** Convert a core diff op (one-sided) into the TUI's two-sided row. */
export function diffOpFromCore(op: CoreDiffOp): TuiDiffRow {
  const before = op.before
    ? cellOf(op.before)
    : undefined;
  const after = op.after
    ? cellOf(op.after)
    : undefined;
  const state =
    op.kind === 'add' ? 'added'
    : op.kind === 'remove' ? 'removed'
    : 'changed';
  const row: TuiDiffRow = { state };
  if (before !== undefined) row.left = before;
  if (after !== undefined) row.right = after;
  return row;
}

function cellOf(m: CoreModule): { type: TuiModuleType; name: string; version?: string } {
  const out: { type: TuiModuleType; name: string; version?: string } = {
    type: moduleTypeFromCore(m.type),
    name: m.name,
  };
  if (m.version !== undefined) out.version = m.version;
  return out;
}

// ── ageLabel ─────────────────────────────────────────────────────────────

/**
 * Convert an ISO 8601 createdAt + a reference `now` into a short relative
 * label matching `git log --relative-date` heuristics:
 *   <60s   → "now"
 *   <60m   → "Nm"
 *   <24h   → "Nh"
 *   <14d   → "Nd"
 *   <8w    → "Nw"
 *   <12mo  → "Nmo"
 *   else   → "Ny"
 *
 * Future timestamps (clock skew) clamp to "now" rather than emitting "-Nh".
 */
export function ageLabelOf(iso: string, now: Date = new Date()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '?';
  const seconds = Math.floor((now.getTime() - t) / 1000);
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 8) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(days / 365);
  return `${years}y`;
}
