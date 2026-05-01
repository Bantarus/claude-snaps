// The Store is the only file in the TUI that knows about @harness/core.
// Every screen consumes the Store via React context (see ../context.tsx);
// no screen ever calls Repo methods directly.
//
// Design pin (prompt C): no caching. Every method hits the Repo. SQLite
// reads are sub-millisecond and the TUI's frame rate is gated by user
// input, not data. Caching is a v0.2 problem if it ever becomes one.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Repo, Snapshot as CoreSnapshot } from '@harness/core';
import {
  ageLabelOf,
  diffOpFromCore,
  moduleFromCore,
  snapshotFromCore,
  type TuiDiffRow,
} from './adapters.js';
import type {
  ModuleRef,
  ModuleType,
  Session,
  Snapshot,
  TraceEvent,
  TraceKind,
  WorkingTree,
} from '../types.js';

// ── module-page aggregations ─────────────────────────────────────────────

export interface ModuleVersionUsage {
  v: string;
  n: number;
  note: string;
  cur: boolean;
  old: boolean;
}

export interface ModuleConfigShape {
  label: string;
  count: number;
}

export interface ModuleSessionRow {
  age: string;
  message: string;
  harness: string;
  moduleVer: string;
  status: 'ok' | 'warn' | 'fail';
}

export interface ModulePageData {
  type: ModuleType;
  name: string;
  versionsUsage: ModuleVersionUsage[];
  configShapes: ModuleConfigShape[];
  trendDays: number[];
  recentSessions: ModuleSessionRow[];
  totalSessions: number;
}

// ── store ────────────────────────────────────────────────────────────────

export interface SnapshotsOpts {
  branch?: string;
  limit?: number;
}

export class Store {
  /** Built lazily from snapshot ids the Store has surfaced. */
  private readonly shortIdMap = new Map<string, string>();

  constructor(public readonly repo: Repo) {}

  // ── snapshots ──────────────────────────────────────────────────────────

  /** All snapshots (newest first), shaped for the TUI. */
  snapshots(opts?: SnapshotsOpts): Snapshot[] {
    const filter: { branch?: string; limit?: number } = {};
    if (opts?.branch !== undefined) filter.branch = opts.branch;
    if (opts?.limit !== undefined) filter.limit = opts.limit;
    let raw: CoreSnapshot[];
    try {
      raw = this.repo.log(Object.keys(filter).length > 0 ? filter : undefined);
    } catch {
      // EmptyRepositoryError or any other read failure becomes []. Empty
      // state is already handled by the App; we don't surface errors here.
      raw = [];
    }
    const now = new Date();
    return raw.map((s) => {
      this.shortIdMap.set(s.id.slice(0, 8), s.id);
      return snapshotFromCore(s, now);
    });
  }

  /** Single snapshot by id (full or 8-char prefix). Throws if missing. */
  snapshot(id: string): Snapshot {
    const full = this.resolveId(id);
    return snapshotFromCore(this.repo.snapshot(full));
  }

  /** Resolve a TUI-shortened id back to the full 40-hex form. */
  resolveId(id: string): string {
    if (id.length === 40) return id;
    const cached = this.shortIdMap.get(id);
    if (cached !== undefined) return cached;
    // Cold lookup: scan listSnapshotIds. Linear; fine for v0.1.
    for (const full of this.repo.listSnapshotIds()) {
      if (full.startsWith(id)) {
        this.shortIdMap.set(id.slice(0, 8), full);
        return full;
      }
    }
    throw new Error(`unknown snapshot id: ${id}`);
  }

  // ── sessions ───────────────────────────────────────────────────────────

  /**
   * Sessions are derived from `auto` snapshots that carry a sessionId.
   * Core does not currently populate the sessions table at write-time;
   * this materializes the Session view by reading the snapshot blobs
   * themselves. Newest first.
   */
  sessions(): Session[] {
    return this.snapshots()
      .filter((s) => s.sessionId !== undefined)
      .map((s) => ({
        id: s.sessionId!,
        snapshotId: s.id,
        message: s.message,
        startLabel: `${s.ageLabel} ago`,
        durationLabel: '—',
        status: 'ok',
        filesTouched: 0,
        trace: [],
      }));
  }

  /**
   * One session by id, with a `loadTrace` thunk for lazy JSONL parsing
   * (pin #7). The synchronous fields render immediately; the trace pane
   * shows "loading…" until the promise resolves.
   */
  session(id: string): Session & { loadTrace: () => Promise<TraceEvent[]> } {
    const all = this.sessions();
    const found = all.find((s) => s.id === id);
    if (found === undefined) throw new Error(`unknown session id: ${id}`);
    const projectRoot = this.repo.projectRoot;
    return {
      ...found,
      loadTrace: () => loadTrace(projectRoot, id),
    };
  }

  // ── working tree ───────────────────────────────────────────────────────

  /**
   * Capture the live `.claude/` state and diff it against HEAD's modules
   * to produce the editor's WorkingTree shape. Pin #3: no caching —
   * fired every time the Editor screen mounts.
   */
  workingTree(): WorkingTree {
    const live = this.repo.workingTree();
    const headId = this.repo.resolveHead();
    const head: CoreSnapshot | null = headId !== null ? this.repo.snapshot(headId) : null;
    const headByKey = new Map<string, ModuleRef>();
    if (head !== null) {
      for (const m of head.modules) {
        const tui = moduleFromCore(m);
        headByKey.set(`${tui.type}::${tui.name}`, tui);
      }
    }

    const liveModulesShaped = live.map(moduleFromCore);
    const annotated = liveModulesShaped.map((m) => {
      const key = `${m.type}::${m.name}`;
      const prior = headByKey.get(key);
      const state: 'same' | 'changed' | 'draft' =
        prior === undefined ? 'draft'
        : prior.version !== m.version ? 'changed'
        : 'same';
      return { ...m, state };
    });

    const changes: WorkingTree['changes'] = [];
    const liveKeys = new Set(annotated.map((m) => `${m.type}::${m.name}`));
    for (const m of annotated) {
      const key = `${m.type}::${m.name}`;
      const prior = headByKey.get(key);
      if (prior === undefined) {
        changes.push({ kind: 'add', module: stripState(m) });
      } else if (prior.version !== m.version) {
        changes.push({
          kind: 'change',
          module: stripState(m),
          ...(prior.version !== undefined ? { fromVersion: prior.version } : {}),
          ...(m.version !== undefined ? { toVersion: m.version } : {}),
        });
      }
    }
    for (const [key, prior] of headByKey) {
      if (!liveKeys.has(key)) {
        changes.push({ kind: 'remove', module: prior });
      }
    }

    return {
      baseSnapshotId: headId !== null ? headId.slice(0, 8) : '—',
      modules: annotated,
      changes,
    };
  }

  // ── diff ───────────────────────────────────────────────────────────────

  diff(idA: string, idB: string): TuiDiffRow[] {
    const a = this.repo.snapshot(this.resolveId(idA));
    const b = this.repo.snapshot(this.resolveId(idB));
    const ops = this.repo.diff(a.id, b.id);
    // Combine same-modules from A with diff ops to produce the
    // two-column diff view the TUI wants. We recompute "same" rows
    // because core's `diff` only reports changes.
    const aMods = a.modules.map(moduleFromCore);
    const bMods = b.modules.map(moduleFromCore);
    const bByKey = new Map(bMods.map((m) => [`${m.type}::${m.name}`, m]));
    const sameRows: TuiDiffRow[] = [];
    for (const ma of aMods) {
      const key = `${ma.type}::${ma.name}`;
      const mb = bByKey.get(key);
      if (mb !== undefined && mb.version === ma.version) {
        sameRows.push({
          state: 'same',
          left:  { type: ma.type, name: ma.name, ...(ma.version ? { version: ma.version } : {}) },
          right: { type: mb.type, name: mb.name, ...(mb.version ? { version: mb.version } : {}) },
        });
      }
    }
    return [...sameRows, ...ops.map(diffOpFromCore)];
  }

  // ── module page ────────────────────────────────────────────────────────

  /**
   * Aggregations driving the Module screen. Walks every snapshot's
   * modules array in JS — fine for v0.1 (counts are small). If the
   * Module screen ever shows perf issues, push these into SQL queries
   * on snapshot_modules.
   */
  moduleData(type: ModuleType, name: string): ModulePageData {
    const all = this.repo.log();
    const matched: { snap: CoreSnapshot; mod: ReturnType<typeof moduleFromCore> }[] = [];
    for (const s of all) {
      for (const m of s.modules) {
        const tui = moduleFromCore(m);
        if (tui.type === type && tui.name === name) {
          matched.push({ snap: s, mod: tui });
          break;
        }
      }
    }

    // Versions usage — count of distinct snapshots per version.
    const versionCounts = new Map<string, number>();
    for (const { mod } of matched) {
      const v = mod.version ?? '(no version)';
      versionCounts.set(v, (versionCounts.get(v) ?? 0) + 1);
    }
    const allVersions = [...versionCounts.entries()].sort((a, b) => b[1] - a[1]);
    const currentVersion = matched[0]?.mod.version ?? null;
    const versionsUsage: ModuleVersionUsage[] = allVersions.map(([v, n], i) => ({
      v,
      n,
      note:
        v === currentVersion ? 'current' :
        i === allVersions.length - 1 ? 'older sessions' :
        '',
      cur: v === currentVersion,
      old: i === allVersions.length - 1 && allVersions.length > 1,
    }));

    // Config shapes — distinct configHash buckets.
    const shapeCounts = new Map<string, number>();
    for (const { snap } of matched) {
      const m = snap.modules.find(
        (cm) => moduleFromCore(cm).type === type && cm.name === name,
      );
      const shape = m?.configHash ?? '(no config)';
      shapeCounts.set(shape, (shapeCounts.get(shape) ?? 0) + 1);
    }
    const configShapes: ModuleConfigShape[] = [...shapeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => ({
        label: label.startsWith('sha256:') ? label.slice(0, 14) + '…' : label,
        count,
      }));

    // Trend — last 7 days, count of matched snapshots per day. Day 0 = today.
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const trendDays: number[] = Array.from({ length: 7 }, () => 0);
    for (const { snap } of matched) {
      const t = Date.parse(snap.createdAt);
      if (Number.isNaN(t)) continue;
      const daysAgo = Math.floor((now - t) / dayMs);
      if (daysAgo >= 0 && daysAgo < 7) {
        trendDays[6 - daysAgo]! += 1;
      }
    }

    // Recent sessions — auto-snapshots that included this module.
    const recentSessions: ModuleSessionRow[] = matched
      .filter(({ snap }) => snap.kind === 'auto')
      .slice(0, 8)
      .map(({ snap, mod }) => ({
        age: ageLabelOf(snap.createdAt),
        message: snap.message,
        harness: snap.version ?? snap.branch,
        moduleVer: mod.version ?? '—',
        status: 'ok',
      }));

    return {
      type,
      name,
      versionsUsage,
      configShapes,
      trendDays,
      recentSessions,
      totalSessions: matched.filter(({ snap }) => snap.kind === 'auto').length,
    };
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  /** No-op in v0.1 (Store reads fresh on each call). Reserved for future caching. */
  refresh(): void {
    this.shortIdMap.clear();
  }

  /** Close the underlying Repo. Called from App's cleanup. */
  close(): void {
    this.repo.close();
  }
}

// ── private helpers ──────────────────────────────────────────────────────

function stripState(m: ModuleRef & { state: 'same' | 'changed' | 'draft' }): ModuleRef {
  const { state: _drop, ...rest } = m;
  return rest;
}

/**
 * Read a Claude Code session JSONL and project it onto the TUI's
 * TraceEvent shape. Hook attachment entries are filtered out per pin #8 —
 * they're meta-events about our own hook firing, not user content.
 *
 * The transcript path is computed heuristically as
 * `~/.claude/projects/<project-encoded>/<sessionId>.jsonl`, where
 * `<project-encoded>` is the absolute project path with `/` replaced by `-`.
 * Returns empty when the file is absent (common — pre-hook sessions, or
 * dogfood projects where Claude Code hasn't run yet).
 */
async function loadTrace(projectRoot: string, sessionId: string): Promise<TraceEvent[]> {
  const path = transcriptPathFor(projectRoot, sessionId);
  if (path === null || !existsSync(path)) return [];
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return [];
  }
  if (!stat.isFile()) return [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  const events: TraceEvent[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    // Pin #8: drop hook attachments.
    const att = entry['attachment'] as Record<string, unknown> | undefined;
    if (att !== undefined && typeof att['hookEvent'] === 'string') continue;
    const event = traceEventFromJsonlEntry(entry);
    if (event !== null) events.push(event);
  }
  return events;
}

function transcriptPathFor(projectRoot: string, sessionId: string): string | null {
  if (sessionId.length === 0) return null;
  const encoded = projectRoot.split(/[/\\]/).join('-');
  return join(homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
}

function traceEventFromJsonlEntry(entry: Record<string, unknown>): TraceEvent | null {
  const type = entry['type'];
  if (typeof type !== 'string') return null;
  const ts = typeof entry['timestamp'] === 'string'
    ? (entry['timestamp'] as string).slice(11, 19) // "HH:MM:SS"
    : '';
  switch (type) {
    case 'user':
      return { t: ts, kind: 'user', message: extractUserText(entry) };
    case 'assistant':
      return { t: ts, kind: 'persona', message: extractAssistantText(entry) };
    case 'tool_use':
      return { t: ts, kind: 'tool', message: String(entry['name'] ?? 'tool') };
    case 'tool_result':
      return { t: ts, kind: 'ok', message: 'tool result' };
    default:
      return null;
  }
}

function extractUserText(entry: Record<string, unknown>): string {
  const msg = entry['message'] as Record<string, unknown> | undefined;
  if (msg !== undefined) {
    const content = msg['content'];
    if (typeof content === 'string') return truncate(content, 80);
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === 'object' && part !== null && (part as { text?: string }).text) {
          return truncate((part as { text: string }).text, 80);
        }
      }
    }
  }
  return '(user)';
}

function extractAssistantText(entry: Record<string, unknown>): string {
  const msg = entry['message'] as Record<string, unknown> | undefined;
  if (msg !== undefined) {
    const content = msg['content'];
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === 'object' && part !== null && (part as { type?: string }).type === 'text') {
          const text = (part as { text?: string }).text;
          if (text) return truncate(text, 80);
        }
      }
    }
  }
  return '(assistant)';
}

function truncate(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : collapsed.slice(0, max - 1) + '…';
}

// Exported only for tests and the Module/Session screens that may want
// to render a kind palette aligned with the trace adapter.
export const TRACE_KINDS: TraceKind[] = ['user', 'hook', 'persona', 'tool', 'skill', 'ok'];
