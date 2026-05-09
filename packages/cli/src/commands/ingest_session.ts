import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { encodeProjectDir, readClaudeCodeVersion, Repo, type IngestSessionResult } from '@harness/core';

import { c } from '../format.js';
import type { ParsedArgs } from '../main.js';

/**
 * `harness ingest-session [<session-id>] [--all] [--since-turn N]
 *                         [--dry-run] [--transcript-path <path>]`
 *
 * Read the per-session transcript JSONL from
 * `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` and extract
 * metadata (model, token usage, tool names, Claude Code version)
 * into `.harness/lineage.sqlite` (`turn_metrics` table). Idempotent:
 * re-running on the same JSONL produces no new rows.
 *
 * Privacy: only the whitelisted fields per spec/format.md §10.2 are
 * read. Prompt text, tool inputs, tool results, system prompts, and
 * thinking content are NEVER copied. The fuzz gate W12.5 verifies
 * this on every CI run.
 *
 * Resolution order for the JSONL path:
 *   1. `--transcript-path <path>` — explicit override.
 *   2. `<session-id>` arg → `~/.claude/projects/<encoded-cwd>/<id>.jsonl`
 *      where encoded-cwd is `process.cwd()` mapped per §10.5
 *      (drift detector L2.2). Per the §10.7 invariant, every session
 *      whose hook fired into THIS `.harness/` was running in this cwd.
 *   3. `--all` → enumerate sessions via attribution rows; ingest each.
 */
export async function cmdIngestSession(parsed: ParsedArgs): Promise<number> {
  const sessionArg = parsed.positional[0];
  const flagAll = parsed.flags['all'] === true;
  const flagDryRun = parsed.flags['dry-run'] === true;
  const flagSince = parseSince(parsed.flags['since-turn']);
  const flagTranscript = readStringFlag(parsed.flags, 'transcript-path');

  if (sessionArg !== undefined && flagAll) {
    process.stderr.write('harness: ingest-session: pass <session-id> OR --all, not both\n');
    return 1;
  }
  if (sessionArg === undefined && !flagAll) {
    process.stderr.write(USAGE);
    return 1;
  }
  if (flagAll && flagTranscript !== null) {
    process.stderr.write('harness: ingest-session: --transcript-path is incompatible with --all\n');
    return 1;
  }

  const cwd = process.cwd();
  const repo = Repo.open(cwd);
  try {
    if (flagAll) {
      return ingestAll(repo, cwd, flagSince, flagDryRun);
    }
    return ingestOne(repo, cwd, sessionArg!, flagTranscript, flagSince, flagDryRun);
  } finally {
    repo.close();
  }
}

function ingestOne(
  repo: Repo,
  cwd: string,
  sessionId: string,
  transcriptOverride: string | null,
  sinceTurn: number | undefined,
  dryRun: boolean,
): number {
  const path = transcriptOverride !== null
    ? resolve(transcriptOverride)
    : defaultTranscriptPath(cwd, sessionId);
  if (!existsSync(path)) {
    process.stderr.write(
      `harness: ingest-session: transcript not found at ${path}\n` +
      `  (pass --transcript-path <path> to override the default location)\n`,
    );
    return 1;
  }
  const result = repo.ingestSession({
    sessionId,
    transcriptPath: path,
    options: {
      ...(sinceTurn !== undefined ? { sinceTurn } : {}),
      ...(dryRun ? { dryRun: true } : {}),
    },
  });
  // Pull the observed CC version directly from the JSONL — the
  // transcript's per-turn `version` field is the canonical source
  // (per-turn, tracks auto-updates). The snapshot's claudeCodeVersion
  // (first-observation-wins) is shown by `harness session-cost`; here
  // the ingest report describes the transcript itself.
  const versionFromTranscript = readClaudeCodeVersion(path);
  printIngestResult(result, path, versionFromTranscript);
  return 0;
}

function ingestAll(
  repo: Repo,
  cwd: string,
  sinceTurn: number | undefined,
  dryRun: boolean,
): number {
  const sessions = repo.sessionIds();
  if (sessions.length === 0) {
    process.stderr.write(
      '(no sessions in .harness/lineage.sqlite — fire the hook at least once first)\n',
    );
    return 0;
  }
  let ingested = 0;
  let missing = 0;
  let skippedAlready = 0;
  let totalAdded = 0;
  for (const s of sessions) {
    const path = defaultTranscriptPath(cwd, s.sessionId);
    if (!existsSync(path)) {
      missing++;
      continue;
    }
    const result = repo.ingestSession({
      sessionId: s.sessionId,
      transcriptPath: path,
      options: {
        ...(sinceTurn !== undefined ? { sinceTurn } : {}),
        ...(dryRun ? { dryRun: true } : {}),
      },
    });
    if (result.added > 0) {
      ingested++;
      totalAdded += result.added;
    } else if (result.skipped > 0) {
      skippedAlready++;
    } else {
      // empty transcript or all-skipped — count as no-op without surfacing noise
    }
  }
  process.stdout.write(
    `Ingested ${c.add(String(ingested))} session${ingested === 1 ? '' : 's'} ` +
    `(${totalAdded} new turn${totalAdded === 1 ? '' : 's'}); ` +
    `${skippedAlready} idempotent no-ops; ` +
    `${c.dim(String(missing))} session${missing === 1 ? '' : 's'} had no transcript on disk.\n` +
    (dryRun ? c.dim('(dry-run — nothing written)\n') : ''),
  );
  return 0;
}

function defaultTranscriptPath(cwd: string, sessionId: string): string {
  return join(homedir(), '.claude', 'projects', encodeProjectDir(cwd), `${sessionId}.jsonl`);
}

function printIngestResult(
  r: IngestSessionResult,
  path: string,
  observedVersion: string | null,
): void {
  if (r.dryRun) {
    process.stdout.write(c.dim(`(dry-run — read ${path}; would ingest below)\n`));
  }
  const verb = r.dryRun ? 'Would ingest' : 'Ingested';
  process.stdout.write(
    `${verb} ${c.add(String(r.added))} new turn${r.added === 1 ? '' : 's'} ` +
    `from session ${r.sessionId}\n`,
  );
  if (r.skipped > 0) {
    process.stdout.write(
      c.dim(`  (${r.skipped} turn${r.skipped === 1 ? '' : 's'} already stored — idempotent)\n`),
    );
  }
  if (!r.dryRun) {
    process.stdout.write(
      `  user turns: ${r.cost.userTurns}, assistant turns: ${r.cost.assistantTurns}\n`,
    );
    if (r.cost.models.length > 0) {
      process.stdout.write(`  models: ${r.cost.models.join(', ')}\n`);
    }
    const totalIn = r.cost.cacheReadInputTokens + r.cost.cacheCreationInputTokens + r.cost.inputTokens;
    process.stdout.write(
      `  tokens: ${formatNumber(totalIn)} input ` +
      `(${formatNumber(r.cost.cacheReadInputTokens)} cache-read, ` +
      `${formatNumber(r.cost.cacheCreationInputTokens)} cache-creation, ` +
      `${formatNumber(r.cost.inputTokens)} live), ` +
      `${formatNumber(r.cost.outputTokens)} output\n`,
    );
    const tools = Object.entries(r.cost.tools)
      .sort((a, b) => b[1] - a[1]);
    if (tools.length > 0) {
      const toolStr = tools.map(([n, c]) => `${n}×${c}`).join(', ');
      process.stdout.write(`  tools: ${toolStr}\n`);
    }
    // Prefer the snapshot-stored value (load-bearing immutable
    // first-observation), but fall back to whatever the transcript
    // currently reports if no snapshot exists for this session yet
    // (e.g. backfilling a session whose hooks fired before harness
    // was wired). When they differ, the snapshot value wins for
    // display because it's the auditable source — the transcript
    // version is informational.
    const reportedVersion = r.cost.claudeCodeVersion ?? observedVersion;
    if (reportedVersion !== null) {
      process.stdout.write(`  Claude Code version observed: ${reportedVersion}\n`);
    }
  }
}

function parseSince(v: unknown): number | undefined {
  if (v === undefined || v === true) return undefined;
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function readStringFlag(flags: Record<string, string | boolean>, key: string): string | null {
  const v = flags[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

const USAGE = `Usage: harness ingest-session [<session-id>] [options]
                              [--all] [--since-turn <N>]
                              [--dry-run] [--transcript-path <path>]

Read the per-session transcript JSONL Claude Code writes and extract
metadata (model, token usage, tool names, Claude Code version) into
.harness/lineage.sqlite. Idempotent: re-running on the same JSONL
produces no new rows.

Privacy: only the whitelisted fields per spec/format.md §10.2 are
read. Prompt text, tool inputs, tool results, system prompts, and
thinking content are NEVER copied to harness storage.

Args:
  <session-id>            Resolve the JSONL via the host's
                          ~/.claude/projects/<encoded-cwd>/ convention.
                          Required unless --all.

Flags:
  --all                   Ingest every session referenced by attribution
                          rows in lineage.sqlite for which a transcript
                          file exists on disk.
  --since-turn <N>        Force re-ingestion starting from turn N
                          (defaults to MAX(turn_index)+1).
  --dry-run               Parse the JSONL, report counts, write nothing.
  --transcript-path <p>   Override the default JSONL path (mostly for
                          tests). Incompatible with --all.

Exit codes: 0 success, 1 user error (unknown session, transcript
missing), 2 internal.
`;
