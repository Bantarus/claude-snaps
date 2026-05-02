import { describe, expect, test } from 'vitest';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listRefs, readHead, readRef, resolveHead, writeRef } from '../src/refs.js';
import { IntegrityError, RefNotFoundError } from '../src/errors.js';

const here = dirname(fileURLToPath(import.meta.url));
const SPEC_DIR = resolve(here, '../../../spec');
const EMPTY = resolve(SPEC_DIR, 'examples/empty/.harness');
const TEAM = resolve(SPEC_DIR, 'examples/team-shared/.harness');
const SOLO_NO_APM = resolve(SPEC_DIR, 'examples/solo-no-apm/.harness');

describe('readHead / resolveHead', () => {
  test('symbolic ref to existing branch resolves to id', () => {
    const head = readHead(TEAM);
    expect(head).toEqual({ type: 'symbolic', ref: 'refs/heads/main' });
    expect(resolveHead(TEAM)).toBe('0ab4f7c92c551342fb585c709dc6e5c2bbb71c89');
  });

  test('empty repo: HEAD is symbolic, resolveHead returns null (spec §4.4)', () => {
    expect(readHead(EMPTY)).toEqual({ type: 'symbolic', ref: 'refs/heads/main' });
    expect(resolveHead(EMPTY)).toBeNull();
  });

  test('readRef on empty-repo default branch throws RefNotFoundError', () => {
    expect(() => readRef(EMPTY, 'heads/main')).toThrowError(RefNotFoundError);
  });
});

describe('readRef / listRefs', () => {
  test('reads team-shared refs/heads/main', () => {
    expect(readRef(TEAM, 'heads/main')).toBe('0ab4f7c92c551342fb585c709dc6e5c2bbb71c89');
  });

  test('reads team-shared refs/tags/v0.4', () => {
    expect(readRef(TEAM, 'tags/v0.4')).toBe('0ab4f7c92c551342fb585c709dc6e5c2bbb71c89');
  });

  test('listRefs heads returns 2 refs for team-shared', () => {
    const heads = listRefs(TEAM, 'heads/');
    expect(Object.keys(heads).sort()).toEqual(['experimental', 'main']);
    expect(heads.experimental).toBe('50f074787cd86a84dee47859ed631dcd2fd70019');
  });

  test('listRefs tags returns v0.2 for solo-no-apm', () => {
    expect(listRefs(SOLO_NO_APM, 'tags/')).toEqual({
      'v0.2': 'b456f1a0ece11dc2e70e9f75e19b9f93b257e29c',
    });
  });

  test('listRefs returns empty when refs dir missing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'harness-test-'));
    expect(listRefs(tmp, 'heads/')).toEqual({});
  });
});

describe('writeRef', () => {
  test('writes and reads back a branch ref', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'harness-test-'));
    cpSync(EMPTY, tmp, { recursive: true });
    const id = 'a'.repeat(40);
    writeRef(tmp, 'heads/main', id);
    expect(readRef(tmp, 'heads/main')).toBe(id);
  });

  test('rejects invalid id', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'harness-test-'));
    cpSync(EMPTY, tmp, { recursive: true });
    expect(() => writeRef(tmp, 'heads/main', 'not-hex')).toThrowError(IntegrityError);
  });

  test('rejects invalid ref path (.. traversal)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'harness-test-'));
    cpSync(EMPTY, tmp, { recursive: true });
    expect(() => writeRef(tmp, 'heads/../etc', 'a'.repeat(40))).toThrowError(IntegrityError);
  });

  test('rejects ref ending in .lock', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'harness-test-'));
    cpSync(EMPTY, tmp, { recursive: true });
    expect(() => writeRef(tmp, 'heads/main.lock', 'a'.repeat(40))).toThrowError(IntegrityError);
  });
});
