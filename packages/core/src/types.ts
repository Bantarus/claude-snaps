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
  // and UserPromptSubmit). Both optional: pre-amendment snapshots and
  // non-hook writers omit them.
  model?: string;
  permissionMode?: string;
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

// Resolved HEAD: a symbolic ref pointing at a branch, a detached id, or
// null on an empty repository whose default branch has no commit yet
// (per spec/format.md §4.4).
export type HeadState =
  | { type: 'symbolic'; ref: string }
  | { type: 'detached'; id: string }
  | null;
