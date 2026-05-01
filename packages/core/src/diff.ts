import type { DiffOp, Module, ModuleType } from './types.js';

// Identity for diff is (type, name): two modules with the same type+name
// represent the same logical entity even if version/configHash/source/
// enabled have shifted. Output is changes-only — the consumer joins
// against the full module list to render `unchanged` rows.
//
// Output order is deterministic — sort by (moduleType, name, kind) so
// snapshot tests stay stable across runs.

const TYPE_ORDER: Record<ModuleType, number> = {
  chatmode: 0, instruction: 1, agent: 2, skill: 3,
  prompt: 4, mcp: 5, hook: 6, style: 7,
};

const KIND_ORDER: Record<DiffOp['kind'], number> = {
  add: 0, change: 1, remove: 2,
};

/** Diff two module arrays by (type, name) identity. Returns only changes. */
export function diff(before: Module[], after: Module[]): DiffOp[] {
  const beforeMap = byIdentity(before);
  const afterMap = byIdentity(after);
  const ops: DiffOp[] = [];

  // adds and changes
  for (const [key, a] of afterMap) {
    const b = beforeMap.get(key);
    if (b === undefined) {
      ops.push({ kind: 'add', moduleType: a.type, name: a.name, after: a });
    } else if (!modulesEqual(a, b)) {
      ops.push({ kind: 'change', moduleType: a.type, name: a.name, before: b, after: a });
    }
  }
  // removes
  for (const [key, b] of beforeMap) {
    if (!afterMap.has(key)) {
      ops.push({ kind: 'remove', moduleType: b.type, name: b.name, before: b });
    }
  }

  ops.sort((x, y) => {
    const tx = TYPE_ORDER[x.moduleType];
    const ty = TYPE_ORDER[y.moduleType];
    if (tx !== ty) return tx - ty;
    if (x.name !== y.name) return x.name < y.name ? -1 : 1;
    return KIND_ORDER[x.kind] - KIND_ORDER[y.kind];
  });
  return ops;
}

// ── private ────────────────────────────────────────────────────────────────

function byIdentity(mods: Module[]): Map<string, Module> {
  const out = new Map<string, Module>();
  for (const m of mods) out.set(`${m.type}\0${m.name}`, m);
  return out;
}

function modulesEqual(a: Module, b: Module): boolean {
  if (a.type !== b.type) return false;
  if (a.name !== b.name) return false;
  if (a.enabled !== b.enabled) return false;
  if (a.version !== b.version) return false;
  if (a.configHash !== b.configHash) return false;
  return sourcesEqual(a.source, b.source);
}

function sourcesEqual(a: Module['source'], b: Module['source']): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'builtin':
      return true;
    case 'local':
      return a.path === (b as { path: string }).path;
    case 'apm': {
      const bb = b as Extract<Module['source'], { kind: 'apm' }>;
      return (
        a.package === bb.package &&
        a.resolvedCommit === bb.resolvedCommit &&
        a.depth === bb.depth &&
        (a.resolvedBy ?? null) === (bb.resolvedBy ?? null)
      );
    }
    default:
      // x-* extension: compare by JSON canonicalization.
      return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  }
}

function canonical(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonical);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    out[k] = canonical((value as Record<string, unknown>)[k]);
  }
  return out;
}
