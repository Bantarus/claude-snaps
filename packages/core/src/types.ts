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

export type SnapshotKind = 'init' | 'edit' | 'auto' | 'fork' | 'tag';

export interface Snapshot {
  id: string;
  parentIds: string[];
  branch: string;
  kind: SnapshotKind;
  message: string;
  version?: string;
  codePin: string | null;
  apmLockHash: string | null;
  createdAt: string;
  sessionId?: string;
  author?: string;
  formatVersion?: string;
  // Session-level context shipped in the SessionStart hook stdin payload.
  // Both are optional: pre-amendment snapshots and non-hook writers omit them.
  model?: string;
  permissionMode?: string;
  modules: Module[];
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
