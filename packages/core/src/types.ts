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

export type SnapshotKind = 'init' | 'manual' | 'tag';

export interface Snapshot {
  id: string;
  parentIds: string[];
  branch: string;
  kind: SnapshotKind;
  // Nullable in v0.2.0: hook-captured snapshots have no user-supplied
  // message and write `null`. Manual `harness snap -m <msg>` writes the
  // user's text; tag operations write the tag annotation.
  message: string | null;
  version?: string;
  codePin: string | null;
  apmLockHash: string | null;
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

// Attribution event — a session's observation of a snapshot at an
// instant. Lives in lineage.sqlite only; no on-disk blob form. See
// spec/format.md §2.7 and §5.4. Implementation lands in step 4.
export type AttributionEventKind =
  | 'session_start'    // SessionStart hook fired (fresh session)
  | 'user_prompt'      // UserPromptSubmit hook fired
  | 'manual_snap'      // user ran `harness snap`
  | 'migrated';        // backfilled from v0.1.x snapshots.session_id

export interface Attribution {
  sessionId: string;
  snapshotId: string;
  observedAt: string;
  eventKind: AttributionEventKind;
  source: string | null; // 'startup'|'resume'|'clear'|'compact' for session_start; null otherwise
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
