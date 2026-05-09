// Mirrors spec/format.md §2 exactly. The TS types are the canonical
// in-memory representation; the JSON shape is the canonical on-disk
// representation; canonical.ts moves between them losslessly.

export type ModuleType =
  | 'chatmode'
  | 'instruction'
  | 'prompt'
  | 'skill'
  | 'agent'
  | 'hook'
  | 'mcp'
  | 'style';

export type ModuleSource =
  | { kind: 'apm'; package: string; resolvedCommit: string; depth: number; resolvedBy?: string }
  | { kind: 'local'; path: string }
  | { kind: 'builtin' }
  // Forward-compat per spec/format.md §9.2: unknown source kinds with the
  // `x-` prefix are preserved verbatim and treated as opaque.
  | { kind: `x-${string}`; [key: string]: unknown };

export interface Module {
  type: ModuleType;
  name: string;
  version?: string;
  enabled: boolean;
  configHash?: string;
  source: ModuleSource;
}

export type SnapshotKind = 'init' | 'auto';

export interface Snapshot {
  id: string;
  parentIds: string[];
  branch: string;
  kind: SnapshotKind;
  codePin: string | null;
  apmLockHash: string | null;
  // Verbatim text of `apm.lock.yaml` at capture time. Optional; absent
  // on v0.3.x snapshots and on projects without APM. When present,
  // `apmLockHash` MUST equal `sha256:` + sha-256 of these bytes. Added
  // v0.4.0 to make `harness reproduce` self-contained against the
  // project's git state. Participates in canonical bytes (format.md §3.1).
  apmLockfile?: string | null;
  createdAt: string;
  author?: string;
  formatVersion?: string;
  // Session-level context shipped in the hook stdin payload (SessionStart
  // and UserPromptSubmit). All optional: pre-amendment snapshots and
  // non-hook writers omit them. First-observation-wins per format.md §2.1.
  model?: string;
  permissionMode?: string;
  // Claude Code CLI version observed at first hook fire. Read from the
  // transcript JSONL's per-turn `version` field (or `claude --version`
  // fallback). Excluded from canonical bytes per format.md §3.1, so the
  // same composition observed across CLI version bumps still hashes the
  // same. Added v0.5.0.
  claudeCodeVersion?: string;
  modules: Module[];
}

// ── Reproducer (v0.4.0; spec/format.md §6.1) ────────────────────────────

export interface ReproduceOptions {
  dryRun?: boolean;
}

export type ReproducePhase = 'skipped' | 'success' | 'failed';

export interface ReproduceResult {
  snapshotId: string;
  /** Where `.claude/` was (or would be) backed up. Always populated, even on dry-run. */
  backupPath: string;
  /** True if dryRun was set; no side effects were performed. */
  dryRun: boolean;
  /** APM phase outcome. 'skipped' when the snapshot has no apmLockfile. */
  apmPhase: ReproducePhase;
  /** Count of APM modules in the snapshot (depth-1 + transitive). */
  apmModulesExpected: number;
  /** Count of APM modules whose post-install configHash matched the snapshot's recorded value. */
  apmModulesVerified: number;
  /** Per-module verification failures (configHash mismatch or file missing). Empty on success. */
  apmFailures: Array<{ name: string; type: string; reason: string }>;
  /** Captured stderr from `apm install --frozen` when apmPhase=failed. */
  apmStderr?: string;
  /** Builtins observed in the snapshot. Verified against the host's known builtin set. */
  builtinsExpected: number;
  /** Builtins missing from the host (rare; advisory only — does not abort). */
  builtinsMissing: Array<{ name: string; type: string }>;
  /** Local-source modules reported but not materialized (per the §6.1 contract). */
  localSourceReported: Array<{ name: string; type: string; path: string; configHash?: string }>;
  /** True when HEAD was advanced to snapshotId at the end of a successful reproduction. */
  headAdvanced: boolean;
  /**
   * Paths under `.claude/` that were APM-managed in the project's
   * pre-reproduce state but are NOT in the target snapshot's APM scope
   * — removed before HEAD advances per §6.1's subtractive contract
   * (added v0.4.1). Empty when the target snapshot's APM scope is a
   * superset of the project's current APM state, or when no APM
   * lockfile exists either side.
   */
  pathsRemoved: string[];
  /**
   * True when the project's `apm.lock.yaml` was removed because the
   * target snapshot recorded no APM state (apmLockfile null). Backed
   * up to `apm.lock.yaml.harness-backup` before removal.
   */
  projectLockfileRemoved: boolean;
}

// Attribution event — a session's observation of a snapshot at an
// instant, optionally carrying a free-form note. Lives in lineage.sqlite
// only; no on-disk blob form. See spec/format.md §2.7 and §5.4.
export type AttributionEventKind =
  | 'session_start'    // SessionStart hook fired (any source: startup/resume/clear/compact)
  | 'user_prompt'      // UserPromptSubmit hook fired
  | 'manual_capture'   // non-CLI writer captured composition without an annotation
  | 'note'             // user attached an annotation via `harness snap "<text>"`
  | 'migrated';        // reserved for backfill events; no v0.3 writer emits this

export interface Attribution {
  sessionId: string;
  snapshotId: string;
  observedAt: string;
  eventKind: AttributionEventKind;
  source: string | null; // 'startup'|'resume'|'clear'|'compact' for session_start; null otherwise
  // Non-null iff eventKind === 'note'. Enforced both at write time in
  // Repo.observe()/note() and by SQL CHECK (004_v0_3_notes.sql).
  noteText: string | null;
}

export interface DiffOp {
  kind: 'add' | 'remove' | 'change';
  moduleType: ModuleType;
  name: string;
  before?: Module;
  after?: Module;
}

// ── Session metrics (v0.5.0; spec/format.md §10) ────────────────────────

/**
 * One row in `turn_metrics` — one assistant or user JSONL turn after
 * the strict whitelist parser filters it. The shape is normative per
 * spec/format.md §10.1; new JSONL fields added by future Claude Code
 * versions are EXCLUDED unless they are added to this type explicitly.
 *
 * Privacy-load-bearing: every field on this type is a non-content
 * identifier or counter. No prompt text, tool input, tool result,
 * thinking content, or system prompt is permitted (§10.2 forbidden
 * whitelist). Adding a new field requires re-running W12.5.
 */
export interface TurnRecord {
  sessionId: string;
  /** 0-based; sequential index of emitted (user|assistant) rows. */
  turnIndex: number;
  turnType: 'user' | 'assistant';
  /** Model id reported on the assistant turn (e.g. `claude-opus-4-7`). Null on user turns. */
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  /** Comma-separated list of tool names (canonical, including `mcp__server__tool`). Null when no tools fired this turn. */
  toolNamesCsv: string | null;
  /** 1 when the turn ran inside a subagent (Task tool); 0 for the main thread. */
  isSidechain: 0 | 1;
  /** Active skill name on the assistant turn, if any. Null otherwise. */
  attributionSkill: string | null;
  /** ISO 8601 UTC. Stamped by the ingester at insert time, not from the JSONL. */
  ingestedAt: string;
  /** Anthropic API request id for the turn (assistant only). Null when absent. */
  requestId: string | null;
}

/**
 * Aggregate roll-up of `turn_metrics` rows for one session. Exposed
 * via `Repo.sessionCost(sessionId)`. Token counts are summed over
 * assistant turns; user turns contribute to `userTurns` only.
 *
 * `claudeCodeVersion` is read from the snapshot blob at the session's
 * first attribution (§2.1 first-observation-wins). Null when no
 * attribution row exists for the session, or when the snapshot
 * pre-dates v0.5.0.
 *
 * `tools` records call counts only — per spec/format.md §10.3,
 * per-tool token attribution is NOT supportable.
 */
export interface SessionCostSummary {
  sessionId: string;
  totalTurns: number;
  userTurns: number;
  assistantTurns: number;
  /** Distinct model ids observed on assistant turns. */
  models: string[];
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** Tool name → call count, summed across all assistant turns. */
  tools: Record<string, number>;
  claudeCodeVersion: string | null;
}

export interface IngestSessionOptions {
  /**
   * Force re-ingest from a specific turn (parser-bug recovery). Defaults
   * to "resume from `MAX(turn_index) + 1`" — the standard idempotent
   * incremental case.
   */
  sinceTurn?: number;
  /**
   * Parse the JSONL but write nothing. The returned record reflects what
   * WOULD have been added.
   */
  dryRun?: boolean;
}

export interface IngestSessionResult {
  sessionId: string;
  /** New rows inserted by this call. Zero on a no-op idempotent re-run. */
  added: number;
  /** Rows already in the database that the parser also produced (idempotent prefix). */
  skipped: number;
  /** Snapshot of session-cost data after ingestion. Same shape as `Repo.sessionCost`. */
  cost: SessionCostSummary;
  /** True when the call was a dry-run; no rows were written. */
  dryRun: boolean;
}

// Resolved HEAD: a symbolic ref pointing at a branch, a detached id, or
// null on an empty repository whose default branch has no commit yet
// (per spec/format.md §4.4).
export type HeadState =
  | { type: 'symbolic'; ref: string }
  | { type: 'detached'; id: string }
  | null;
