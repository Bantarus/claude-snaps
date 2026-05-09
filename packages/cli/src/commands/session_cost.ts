import { Repo, type SessionCostSummary } from '@harness/core';

import { c } from '../format.js';
import type { ParsedArgs } from '../main.js';

/**
 * `harness session-cost [<session-id>] [--all]
 *                       [--by-tool] [--by-model]
 *                       [--branch <name>] [--limit <N>] [--csv]`
 *
 * Query `turn_metrics`. Without a session-id, reports a project-wide
 * roll-up across every session that has been ingested.
 *
 * Per-tool token attribution is NOT supported (spec/format.md §10.3,
 * hard pin #6). The JSONL `usage` block is per-assistant-turn — a
 * single turn invokes one or more tools; the data model preserves
 * the relationship via `tool_names_csv` but cannot attribute tokens
 * to individual tool calls. `--by-tool` reports call counts only.
 */
export async function cmdSessionCost(parsed: ParsedArgs): Promise<number> {
  const sessionArg = parsed.positional[0];
  const flagAll = parsed.flags['all'] === true;
  const flagByTool = parsed.flags['by-tool'] === true;
  const flagByModel = parsed.flags['by-model'] === true;
  const flagCsv = parsed.flags['csv'] === true;
  const flagLimit = parseLimit(parsed.flags['limit']);
  const flagBranch = readStringFlag(parsed.flags, 'branch');

  if (sessionArg !== undefined && flagAll) {
    process.stderr.write('harness: session-cost: pass <session-id> OR --all, not both\n');
    return 1;
  }

  const repo = Repo.open(process.cwd());
  try {
    if (sessionArg !== undefined) {
      const cost = repo.sessionCost(sessionArg);
      if (cost === null) {
        process.stderr.write(
          `harness: session-cost: no turn_metrics rows for ${sessionArg}\n` +
          `  (run 'harness ingest-session ${sessionArg}' first)\n`,
        );
        return 1;
      }
      if (flagCsv) printCsv([cost]);
      else if (flagByTool) printByTool(cost);
      else if (flagByModel) printByModel([cost]);
      else printOneSession(cost);
      return 0;
    }

    if (flagAll) {
      // Walk every session that has turn_metrics rows — includes
      // backfilled sessions (ingested without a prior hook fire).
      // For attribution-only filtering, see --branch.
      const sessionIds = repo.ingestedSessionIds();
      const all: SessionCostSummary[] = [];
      for (const id of sessionIds) {
        const c = repo.sessionCost(id);
        if (c !== null) all.push(c);
      }
      if (flagBranch !== null) {
        // Restrict to sessions whose first attribution snapshot is on
        // the named branch. The query is one-row-per-snapshot scan
        // already inside the SQLite query layer; here we filter
        // post-aggregate for simplicity.
        const filtered: SessionCostSummary[] = [];
        for (const s of all) {
          const traj = repo.trajectoryOf(s.sessionId);
          if (traj.length === 0) continue;
          const first = repo.snapshot(traj[0]!.snapshotId);
          if (first.branch === flagBranch) filtered.push(s);
        }
        renderAll(filtered, flagLimit, flagByTool, flagByModel, flagCsv);
        return 0;
      }
      renderAll(all, flagLimit, flagByTool, flagByModel, flagCsv);
      return 0;
    }

    process.stderr.write(USAGE);
    return 1;
  } finally {
    repo.close();
  }
}

function renderAll(
  rows: SessionCostSummary[],
  limit: number | undefined,
  byTool: boolean,
  byModel: boolean,
  csv: boolean,
): void {
  if (rows.length === 0) {
    process.stderr.write('(no sessions ingested yet — run \'harness ingest-session --all\')\n');
    return;
  }
  // Order by total tokens DESC per spec pin 6 (verified-pins).
  const ordered = [...rows].sort((a, b) => totalTokens(b) - totalTokens(a));
  const sliced = limit !== undefined ? ordered.slice(0, limit) : ordered;
  if (csv) { printCsv(sliced); return; }
  if (byTool) { printByToolAggregate(sliced); return; }
  if (byModel) { printByModel(sliced); return; }
  printAllSessions(sliced);
}

function printOneSession(s: SessionCostSummary): void {
  process.stdout.write(`Session ${s.sessionId}\n`);
  process.stdout.write(`  Turns:                ${s.totalTurns} (${s.userTurns} user / ${s.assistantTurns} assistant)\n`);
  if (s.models.length > 0) {
    process.stdout.write(`  Models:               ${s.models.join(', ')}\n`);
  }
  process.stdout.write(`  Input tokens (live):  ${formatNumber(s.inputTokens)}\n`);
  process.stdout.write(`  Cache read:           ${formatNumber(s.cacheReadInputTokens)}\n`);
  process.stdout.write(`  Cache creation:       ${formatNumber(s.cacheCreationInputTokens)}\n`);
  process.stdout.write(`  Output tokens:        ${formatNumber(s.outputTokens)}\n`);
  const tools = Object.entries(s.tools).sort((a, b) => b[1] - a[1]);
  if (tools.length > 0) {
    const toolStr = tools.map(([n, c]) => `${n}: ${c}`).join(', ');
    process.stdout.write(`  Tools called:         {${toolStr}}\n`);
  }
  if (s.claudeCodeVersion !== null) {
    process.stdout.write(`  Claude Code version:  ${s.claudeCodeVersion}\n`);
  }
}

function printByTool(s: SessionCostSummary): void {
  const tools = Object.entries(s.tools).sort((a, b) => b[1] - a[1]);
  if (tools.length === 0) {
    process.stdout.write(`(session ${s.sessionId} called no tools)\n`);
    return;
  }
  process.stdout.write(`Session ${s.sessionId} — by tool (call counts only; ${c.dim('per-tool tokens NOT supportable per spec/format.md §10.3')}):\n`);
  for (const [name, count] of tools) {
    process.stdout.write(`  ${name.padEnd(36)}  ${formatNumber(count)} call${count === 1 ? '' : 's'}\n`);
  }
}

function printByToolAggregate(rows: SessionCostSummary[]): void {
  const totals: Record<string, number> = {};
  for (const r of rows) {
    for (const [n, count] of Object.entries(r.tools)) {
      totals[n] = (totals[n] ?? 0) + count;
    }
  }
  const ordered = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  if (ordered.length === 0) {
    process.stdout.write('(no tool calls across the matched sessions)\n');
    return;
  }
  process.stdout.write(`Across ${rows.length} session${rows.length === 1 ? '' : 's'} — by tool ` +
    `(call counts only; ${c.dim('per-tool tokens NOT supportable per spec/format.md §10.3')}):\n`);
  for (const [name, count] of ordered) {
    process.stdout.write(`  ${name.padEnd(36)}  ${formatNumber(count)} call${count === 1 ? '' : 's'}\n`);
  }
}

function printByModel(rows: SessionCostSummary[]): void {
  const buckets = new Map<string, { sessions: number; tokens: number }>();
  for (const r of rows) {
    // A session can use multiple models. Attribute its total tokens
    // to each distinct model — a session that touched two models
    // counts in both buckets. This is the most useful default for
    // "I want to see what each model cost me"; if multi-model sessions
    // are common we can revisit.
    for (const m of r.models) {
      const b = buckets.get(m) ?? { sessions: 0, tokens: 0 };
      b.sessions++;
      b.tokens += totalTokens(r);
      buckets.set(m, b);
    }
  }
  const ordered = [...buckets.entries()].sort((a, b) => b[1].tokens - a[1].tokens);
  if (ordered.length === 0) {
    process.stdout.write('(no models observed across the matched sessions)\n');
    return;
  }
  for (const [model, b] of ordered) {
    process.stdout.write(
      `${model.padEnd(20)} ${b.sessions} session${b.sessions === 1 ? '' : 's'}   ` +
      `${formatNumber(b.tokens)} tokens total\n`,
    );
  }
}

function printAllSessions(rows: SessionCostSummary[]): void {
  // One-line-per-session digest, ordered by total tokens DESC.
  process.stdout.write(
    `${rows.length} session${rows.length === 1 ? '' : 's'} (ordered by total tokens DESC):\n`,
  );
  for (const r of rows) {
    process.stdout.write(
      `  ${r.sessionId.slice(0, 8)}…  ${formatNumber(totalTokens(r)).padStart(12)} tokens  ` +
      `${r.totalTurns} turn${r.totalTurns === 1 ? '' : 's'}  ` +
      c.dim(`(${r.assistantTurns} asst, ${r.userTurns} user; ${r.models.join(',') || '?'})`) + '\n',
    );
  }
}

function printCsv(rows: SessionCostSummary[]): void {
  process.stdout.write([
    'session_id', 'total_turns', 'user_turns', 'assistant_turns',
    'input_tokens', 'output_tokens',
    'cache_creation_input_tokens', 'cache_read_input_tokens',
    'models', 'tools', 'claude_code_version',
  ].join(',') + '\n');
  for (const r of rows) {
    process.stdout.write([
      r.sessionId, r.totalTurns, r.userTurns, r.assistantTurns,
      r.inputTokens, r.outputTokens,
      r.cacheCreationInputTokens, r.cacheReadInputTokens,
      JSON.stringify(r.models.join('|')),
      JSON.stringify(
        Object.entries(r.tools).map(([n, c]) => `${n}:${c}`).join('|'),
      ),
      r.claudeCodeVersion ?? '',
    ].join(',') + '\n');
  }
}

function totalTokens(r: SessionCostSummary): number {
  return r.inputTokens + r.outputTokens + r.cacheCreationInputTokens + r.cacheReadInputTokens;
}

function parseLimit(v: unknown): number | undefined {
  if (v === undefined || v === true) return undefined;
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function readStringFlag(flags: Record<string, string | boolean>, key: string): string | null {
  const v = flags[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

const USAGE = `Usage: harness session-cost [<session-id>] [options]
                            [--all]
                            [--by-tool] [--by-model]
                            [--branch <name>] [--limit <N>] [--csv]

Query turn_metrics for cost data. Without a <session-id>, reports a
project-wide roll-up across every ingested session.

Per-tool TOKEN attribution is NOT supportable (spec/format.md §10.3):
the JSONL usage block is per-assistant-turn; a single turn invokes
multiple tools and the usage sums across them. --by-tool reports
CALL COUNTS only.

Flags:
  --all          Roll up every session in the project.
  --by-tool      Group by tool name. Lists call counts per tool.
                 Does NOT report per-tool tokens.
  --by-model     Group by model id. Per-model session counts and
                 total tokens (multi-model sessions count in each
                 bucket).
  --branch <n>   With --all: restrict to sessions whose first
                 attribution snapshot is on the given branch.
  --limit <N>    With --all: top-N rows ordered by total tokens DESC.
                 Default: unlimited.
  --csv          Machine-readable CSV. Compatible with all selectors.

Exit codes: 0 success, 1 user error (unknown session, no rows), 2 internal.
`;
