import { describe, expect, test } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSnapshot } from '../src/blob.js';
import { diff } from '../src/diff.js';
import type { Module } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const SPEC_DIR = resolve(here, '../../../spec');
const SOLO_NO_APM = resolve(SPEC_DIR, 'examples/solo-no-apm/.harness');

describe('diff — basic identity rules', () => {
  test('no changes → empty diff', () => {
    const a: Module = { type: 'mcp', name: 'Read', enabled: true, source: { kind: 'builtin' } };
    expect(diff([a], [a])).toEqual([]);
  });

  test('add', () => {
    const a: Module = { type: 'mcp', name: 'Read', enabled: true, source: { kind: 'builtin' } };
    const b: Module = { type: 'skill', name: 'research', enabled: true, source: { kind: 'local', path: 'x' } };
    const ops = diff([a], [a, b]);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: 'add', moduleType: 'skill', name: 'research' });
  });

  test('remove', () => {
    const a: Module = { type: 'mcp', name: 'Read', enabled: true, source: { kind: 'builtin' } };
    const b: Module = { type: 'skill', name: 'research', enabled: true, source: { kind: 'local', path: 'x' } };
    const ops = diff([a, b], [a]);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: 'remove', moduleType: 'skill', name: 'research' });
  });

  test('change: version differs → change op', () => {
    const before: Module = { type: 'skill', name: 'research', version: 'v0.4', enabled: true, source: { kind: 'local', path: 'x' } };
    const after:  Module = { type: 'skill', name: 'research', version: 'v0.5', enabled: true, source: { kind: 'local', path: 'x' } };
    const ops = diff([before], [after]);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: 'change', moduleType: 'skill', name: 'research', before, after });
  });

  test('change: source.kind differs (local→apm) → change op', () => {
    const before: Module = { type: 'skill', name: 'research', enabled: true, source: { kind: 'local', path: 'x' } };
    const after:  Module = {
      type: 'skill', name: 'research', enabled: true,
      source: { kind: 'apm', package: 'p', resolvedCommit: 'a'.repeat(40), depth: 1 },
    };
    const ops = diff([before], [after]);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('change');
  });

  test('change: enabled toggled → change op', () => {
    const before: Module = { type: 'mcp', name: 'github', enabled: true, source: { kind: 'local', path: 'x' } };
    const after:  Module = { type: 'mcp', name: 'github', enabled: false, source: { kind: 'local', path: 'x' } };
    expect(diff([before], [after])).toEqual([
      { kind: 'change', moduleType: 'mcp', name: 'github', before, after },
    ]);
  });
});

describe('diff — identity edge cases', () => {
  test('same name, different type → 2 ops (one remove, one add)', () => {
    const a: Module = { type: 'skill', name: 'foo', enabled: true, source: { kind: 'local', path: 'x' } };
    const b: Module = { type: 'prompt', name: 'foo', enabled: true, source: { kind: 'local', path: 'y' } };
    const ops = diff([a], [b]);
    expect(ops).toHaveLength(2);
    expect(ops.find((o) => o.kind === 'remove')!.moduleType).toBe('skill');
    expect(ops.find((o) => o.kind === 'add')!.moduleType).toBe('prompt');
  });
});

describe('diff — output order is deterministic', () => {
  test('two runs produce identical output', () => {
    const before: Module[] = [
      { type: 'skill', name: 'research', enabled: true, source: { kind: 'local', path: 'r' } },
      { type: 'mcp', name: 'github', enabled: true, source: { kind: 'local', path: 'g' } },
    ];
    const after: Module[] = [
      { type: 'mcp', name: 'github', version: 'v2', enabled: true, source: { kind: 'local', path: 'g' } },
      { type: 'mcp', name: 'postgres', enabled: true, source: { kind: 'local', path: 'p' } },
    ];
    const a = diff(before, after);
    const b = diff(before, after);
    expect(a).toEqual(b);
  });
});

describe('diff — example fixtures', () => {
  test('solo-no-apm: init → final reveals expected change set', () => {
    const init = readSnapshot(SOLO_NO_APM, '43fbe90461a62bd86fc437a49fdf9a07b9ea9460');
    const finalAuto = readSnapshot(SOLO_NO_APM, 'e412db6b8af8318d128441193b99a41cc4d4963e');
    const ops = diff(init.modules, finalAuto.modules);
    // The fixture lineage in build_examples.py adds a `format-post` hook
    // partway through; expect at minimum one add op.
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.some((o) => o.kind === 'add' && o.name === 'format-post')).toBe(true);
  });

  test('solo-no-apm: snapshot the exact diff (regression guard)', () => {
    const init = readSnapshot(SOLO_NO_APM, '43fbe90461a62bd86fc437a49fdf9a07b9ea9460');
    const finalAuto = readSnapshot(SOLO_NO_APM, 'e412db6b8af8318d128441193b99a41cc4d4963e');
    expect(diff(init.modules, finalAuto.modules)).toMatchSnapshot();
  });
});
