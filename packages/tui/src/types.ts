// Type model for the harness lineage. The key idea: a Snapshot is an
// IMMUTABLE record of the project's harness composition (which personas,
// MCPs, skills, hooks, commands, output styles were active and pinned).
// A Session is a real run that starts pinned to one Snapshot. Versioning
// of harnesses is decoupled from code versioning — but each Snapshot
// records `codePin` (the git sha at the moment) so lineage can be traced
// alongside code without being coupled to it.

// TUI display vocabulary. Includes legacy display aliases the Ink screens
// were built around (`persona`, `cmd`) and core's canonical newer types
// (`agent`, `instruction`). The adapter in data/adapters.ts maps from
// core's enum (chatmode/instruction/prompt/skill/agent/hook/mcp/style)
// into this union: `chatmode → persona`, `prompt → cmd`, others
// pass-through. Per spec/format.md §2.5 readers may surface either name.
export type ModuleType =
  | 'persona'
  | 'agent'
  | 'instruction'
  | 'mcp'
  | 'skill'
  | 'hook'
  | 'cmd'
  | 'style';

export interface ModuleRef {
  type: ModuleType;
  name: string;
  version?: string;
  enabled?: boolean;
}

// kind controls how the snapshot is rendered in the lineage graph:
// init  = first snapshot of the harness
// edit  = working-tree commit (manual edit captured)
// auto  = auto-snapshot taken when a session starts
// fork  = snapshot that creates a new branch
// tag   = a "promotion" that names the snapshot vN
export type SnapshotKind = 'init' | 'edit' | 'auto' | 'fork' | 'tag';

export interface Snapshot {
  id: string;
  parentIds: string[]; // 0=init, 1=normal, 2=merge
  branch: string;
  kind: SnapshotKind;
  message: string;
  version?: string; // present on tag snapshots
  codePin: string; // git sha at snapshot time (decoupled but tracked)
  sessionId?: string; // present on auto snapshots
  ageLabel: string; // pre-formatted relative age for the mock
  modules: ModuleRef[];
}

export type TraceKind = 'user' | 'hook' | 'persona' | 'tool' | 'skill' | 'ok';

export interface TraceEvent {
  t: string;
  kind: TraceKind;
  message: string;
}

export interface Session {
  id: string;
  snapshotId: string;
  message: string;
  startLabel: string;
  durationLabel: string;
  status: 'ok' | 'warn' | 'fail';
  filesTouched: number;
  pr?: string;
  author?: string;
  trace: TraceEvent[];
}

// Working-tree state used by the editor
export interface WorkingTreeChange {
  kind: 'add' | 'remove' | 'change';
  module: ModuleRef;
  fromVersion?: string;
  toVersion?: string;
}

export interface WorkingTree {
  baseSnapshotId: string;
  modules: Array<ModuleRef & { state: 'same' | 'changed' | 'draft' }>;
  changes: WorkingTreeChange[];
}
