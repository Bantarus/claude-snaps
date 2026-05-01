import type { Snapshot, Session, WorkingTree } from '../../src/types.js';

// ──────────────────────────────────────────────────────────────
// Snapshot lineage (newest first in this list)
// Two branches: main and experimental. v0.4 is the latest tagged.
// ──────────────────────────────────────────────────────────────

export const snapshots: Snapshot[] = [
  {
    id: '4a1',
    parentIds: ['4a0'],
    branch: 'main',
    kind: 'auto',
    message: 'auto · refactor auth flow',
    version: 'v0.4',
    codePin: 'a3f9c1',
    sessionId: 'sess#187',
    ageLabel: '2h',
    modules: v04Modules(),
  },
  {
    id: '4a0',
    parentIds: ['39c'],
    branch: 'main',
    kind: 'auto',
    message: 'auto · draft RFC for queues',
    version: 'v0.4',
    codePin: 'a3f9c1',
    sessionId: 'sess#186',
    ageLabel: '5h',
    modules: v04Modules(),
  },
  {
    id: '39c',
    parentIds: ['39b'],
    branch: 'main',
    kind: 'tag',
    message: 'promote v0.4',
    version: 'v0.4',
    codePin: 'a3f9c1',
    ageLabel: '1d',
    modules: v04Modules(),
  },
  {
    id: '39b',
    parentIds: ['38a'],
    branch: 'main',
    kind: 'edit',
    message: '+ postgres MCP, terse style',
    codePin: 'b22e80',
    ageLabel: '1d',
    modules: v04Modules(),
  },
  {
    id: '38a',
    parentIds: ['350'],
    branch: 'main',
    kind: 'fork',
    message: 'fork → experimental',
    codePin: 'b22e80',
    ageLabel: '2d',
    modules: v03Modules(),
  },
  {
    id: '37f',
    parentIds: ['38a'],
    branch: 'experimental',
    kind: 'auto',
    message: 'auto · review @ben PR #882',
    version: 'exp',
    codePin: 'b22e80',
    sessionId: 'sess#181',
    ageLabel: '2d',
    modules: v03Modules(),
  },
  {
    id: '350',
    parentIds: ['34f'],
    branch: 'main',
    kind: 'tag',
    message: 'promote v0.3',
    version: 'v0.3',
    codePin: '9c12aa',
    ageLabel: '4d',
    modules: v03Modules(),
  },
  {
    id: '34f',
    parentIds: ['320'],
    branch: 'main',
    kind: 'auto',
    message: 'auto · crawl pricing pages',
    version: 'v0.3',
    codePin: '9c12aa',
    sessionId: 'sess#162',
    ageLabel: '4d',
    modules: v03Modules(),
  },
  {
    id: '320',
    parentIds: ['300'],
    branch: 'main',
    kind: 'edit',
    message: '– deprecated /ship cmd',
    codePin: '71fe33',
    ageLabel: '1w',
    modules: v01Modules(),
  },
  {
    id: '300',
    parentIds: [],
    branch: 'main',
    kind: 'init',
    message: 'init from recipe: research-base',
    version: 'v0.1',
    codePin: '71fe33',
    ageLabel: '1w',
    modules: v01Modules(),
  },
];

// Two canonical harness compositions used across snapshots.
function v01Modules() {
  return [
    { type: 'persona', name: 'senior-eng' },
    { type: 'mcp', name: 'filesystem', version: 'v2.1' },
    { type: 'mcp', name: 'github', version: 'v1.2' },
    { type: 'skill', name: 'research', version: 'v0.4' },
    { type: 'skill', name: 'summarize', version: 'v0.2' },
    { type: 'hook', name: 'format-pre' },
    { type: 'cmd', name: '/plan' },
    { type: 'cmd', name: '/ship' },
  ] as const as Array<import('../../src/types.js').ModuleRef>;
}

function v03Modules() {
  return [
    { type: 'persona', name: 'senior-eng' },
    { type: 'mcp', name: 'filesystem', version: 'v2.1' },
    { type: 'mcp', name: 'github', version: 'v1.4' },
    { type: 'skill', name: 'research', version: 'v0.4' },
    { type: 'skill', name: 'summarize', version: 'v0.2' },
    { type: 'hook', name: 'format-pre' },
    { type: 'hook', name: 'format-post' },
    { type: 'cmd', name: '/plan' },
    { type: 'cmd', name: '/ship' },
  ] as const as Array<import('../../src/types.js').ModuleRef>;
}

function v04Modules() {
  return [
    { type: 'persona', name: 'senior-eng' },
    { type: 'mcp', name: 'filesystem', version: 'v2.1' },
    { type: 'mcp', name: 'github', version: 'v1.6' },
    { type: 'mcp', name: 'postgres', version: 'v0.9' },
    { type: 'skill', name: 'research', version: 'v0.5' },
    { type: 'skill', name: 'summarize', version: 'v0.2' },
    { type: 'hook', name: 'format-pre' },
    { type: 'hook', name: 'format-post' },
    { type: 'cmd', name: '/plan' },
    { type: 'style', name: 'terse' },
  ] as const as Array<import('../../src/types.js').ModuleRef>;
}

// ──────────────────────────────────────────────────────────────
// Sessions
// ──────────────────────────────────────────────────────────────

export const sessions: Session[] = [
  {
    id: 'sess#187',
    snapshotId: '4a1',
    message: 'refactor auth flow',
    startLabel: '2h ago',
    durationLabel: '4m12s',
    status: 'ok',
    filesTouched: 4,
    pr: '#882',
    author: '@ben',
    trace: [
      { t: '12:04:12', kind: 'user', message: '/plan refactor auth flow' },
      { t: '12:04:13', kind: 'hook', message: 'format-pre fired' },
      { t: '12:04:14', kind: 'persona', message: 'senior-eng activated' },
      { t: '12:04:18', kind: 'tool', message: 'github.read_repo()' },
      { t: '12:04:25', kind: 'skill', message: 'research browsed 3 docs' },
      { t: '12:05:03', kind: 'user', message: 'approved plan' },
      { t: '12:05:04', kind: 'tool', message: 'filesystem.patch app/auth.ts' },
      { t: '12:05:11', kind: 'tool', message: 'filesystem.patch app/login.ts' },
      { t: '12:05:14', kind: 'tool', message: 'filesystem.patch app/session.ts' },
      { t: '12:05:18', kind: 'hook', message: 'format-post · prettier' },
      { t: '12:05:22', kind: 'tool', message: 'github.commit (a3f9c1)' },
      { t: '12:08:24', kind: 'ok', message: 'session ended · 4 files' },
    ],
  },
];

// ──────────────────────────────────────────────────────────────
// Working tree (uncommitted changes, draft v0.5)
// ──────────────────────────────────────────────────────────────

export const workingTree: WorkingTree = {
  baseSnapshotId: '4a1', // based on v0.4
  modules: [
    { type: 'persona', name: 'senior-eng', state: 'same', enabled: true },
    { type: 'mcp', name: 'filesystem', version: 'v2.1', state: 'same', enabled: true },
    { type: 'mcp', name: 'github', version: 'v1.6', state: 'same', enabled: true },
    { type: 'mcp', name: 'postgres', version: 'v0.9', state: 'same', enabled: true },
    { type: 'mcp', name: 'vector-store', version: 'v0.3', state: 'draft', enabled: true },
    { type: 'skill', name: 'research', version: 'v0.5', state: 'same', enabled: true },
    { type: 'skill', name: 'code-review', version: 'v0.1', state: 'draft', enabled: true },
    { type: 'skill', name: 'summarize', version: 'v0.2', state: 'same', enabled: false },
    { type: 'hook', name: 'format-pre', state: 'same', enabled: true },
    { type: 'hook', name: 'format-post', state: 'same', enabled: true },
    { type: 'cmd', name: '/plan', state: 'same', enabled: true },
    { type: 'style', name: 'terse', state: 'changed', enabled: true },
  ],
  changes: [
    { kind: 'add', module: { type: 'mcp', name: 'vector-store', version: 'v0.3' } },
    { kind: 'add', module: { type: 'skill', name: 'code-review', version: 'v0.1' } },
    { kind: 'change', module: { type: 'style', name: 'terse' } },
  ],
};

// ──────────────────────────────────────────────────────────────
// Module-page data (github)
// ──────────────────────────────────────────────────────────────

export const githubModule = {
  type: 'mcp' as const,
  name: 'github',
  versionsUsage: [
    { v: 'v1.6', n: 14, note: 'current  · official', cur: true, old: false },
    { v: 'v1.4', n: 8, note: 'pinned in v0.3', cur: false, old: false },
    { v: 'v1.2', n: 2, note: 'older sessions', cur: false, old: true },
  ],
  configShapes: [
    { label: 'read-only · org/*', count: 18 },
    { label: '+ write · me/notes', count: 4 },
    { label: 'read-only · all', count: 2 },
  ],
  // sparkline of last-7d session counts
  trendDays: [1, 2, 1, 3, 5, 4, 7],
  recentSessions: [
    { age: '2h', message: 'refactor auth flow', harness: 'v0.4', moduleVer: 'v1.6', status: 'ok' as const },
    { age: '5h', message: 'draft RFC for queues', harness: 'v0.4', moduleVer: 'v1.6', status: 'ok' as const },
    { age: '1d', message: 'migrate users table', harness: 'v0.3', moduleVer: 'v1.4', status: 'ok' as const },
    { age: '2d', message: 'review @ben PR #882', harness: 'exp', moduleVer: 'v1.4', status: 'warn' as const },
    { age: '4d', message: 'crawl pricing pages', harness: 'v0.2', moduleVer: 'v1.2', status: 'ok' as const },
    { age: '5d', message: 'revert hotfix', harness: 'v0.2', moduleVer: 'v1.2', status: 'fail' as const },
  ],
};
