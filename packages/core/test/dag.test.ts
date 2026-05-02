import { describe, expect, test } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ancestorsOf, descendantsOf, isAncestor, lcaOf } from '../src/dag.js';

const here = dirname(fileURLToPath(import.meta.url));
const SPEC_DIR = resolve(here, '../../../spec');
const COMPAT = resolve(SPEC_DIR, 'examples/compat-fixtures/.harness');

// The diamond DAG (from compat-fixtures):
//
//   INIT ────┬──> LEFT ──┐
//            │           ├──> MERGE ──> XEXT
//            └──> RIGHT ─┘
//
const INIT  = '7ed2cc47a0732811628b28fe64ffe87a8062174b';
const LEFT  = '4f879e686bf40c2d72bb92543d5a298e4eab9751';
const RIGHT = 'ef76f830568eb7ba5186cd520c37177e7b0b0a0c';
const MERGE = '641137a06e841d897aeedd11133f40b041f6ab99';
const XEXT  = 'c036dcc3362ceca7795fe0eef0356f8ab9dd7799';

describe('dag.ancestorsOf — diamond DAG (Gate 2)', () => {
  test('ancestorsOf MERGE visits INIT exactly once (no double-visit via diamond)', () => {
    const ancestors = ancestorsOf(COMPAT, MERGE);
    expect(ancestors.sort()).toEqual([INIT, LEFT, RIGHT].sort());
    expect(ancestors).toHaveLength(3); // not 4 — INIT must not appear twice
  });

  test('ancestorsOf XEXT covers the full diamond', () => {
    const ancestors = ancestorsOf(COMPAT, XEXT);
    expect(ancestors.sort()).toEqual([INIT, LEFT, RIGHT, MERGE].sort());
    expect(ancestors).toHaveLength(4);
  });

  test('ancestorsOf init returns empty', () => {
    expect(ancestorsOf(COMPAT, INIT)).toEqual([]);
  });

  test('ancestorsOf left and right return [INIT]', () => {
    expect(ancestorsOf(COMPAT, LEFT)).toEqual([INIT]);
    expect(ancestorsOf(COMPAT, RIGHT)).toEqual([INIT]);
  });
});

describe('dag.descendantsOf', () => {
  test('descendantsOf INIT covers the full diamond', () => {
    expect(descendantsOf(COMPAT, INIT).sort()).toEqual(
      [LEFT, RIGHT, MERGE, XEXT].sort(),
    );
  });

  test('descendantsOf MERGE returns just [XEXT]', () => {
    expect(descendantsOf(COMPAT, MERGE)).toEqual([XEXT]);
  });

  test('descendantsOf XEXT (a leaf) returns empty', () => {
    expect(descendantsOf(COMPAT, XEXT)).toEqual([]);
  });
});

describe('dag.isAncestor', () => {
  test('init is ancestor of every other node in the diamond', () => {
    expect(isAncestor(COMPAT, INIT, LEFT)).toBe(true);
    expect(isAncestor(COMPAT, INIT, RIGHT)).toBe(true);
    expect(isAncestor(COMPAT, INIT, MERGE)).toBe(true);
    expect(isAncestor(COMPAT, INIT, XEXT)).toBe(true);
  });

  test('left and right are NOT ancestors of each other', () => {
    expect(isAncestor(COMPAT, LEFT, RIGHT)).toBe(false);
    expect(isAncestor(COMPAT, RIGHT, LEFT)).toBe(false);
  });

  test('reflexive case: a node is not its own ancestor', () => {
    expect(isAncestor(COMPAT, MERGE, MERGE)).toBe(false);
  });
});

describe('dag.lcaOf', () => {
  test('LCA of left and right is init', () => {
    expect(lcaOf(COMPAT, LEFT, RIGHT)).toBe(INIT);
  });

  test('LCA of merge and merge is init (LCA is non-reflexive)', () => {
    // LCA of a node with itself returns the node itself per common
    // definition; our impl includes idA in candidates.
    expect(lcaOf(COMPAT, MERGE, MERGE)).toBe(MERGE);
  });

  test('LCA of left and merge is left (left is ancestor of merge)', () => {
    expect(lcaOf(COMPAT, LEFT, MERGE)).toBe(LEFT);
  });

  test('LCA of xext and right walks across the diamond → right', () => {
    expect(lcaOf(COMPAT, XEXT, RIGHT)).toBe(RIGHT);
  });
});
