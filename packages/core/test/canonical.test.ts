import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { canonicalBytes, canonicalize, snapshotId } from '../src/canonical.js';
import { IntegrityError } from '../src/errors.js';
import type { Snapshot } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const SPEC_DIR = resolve(here, '../../../spec');

// The literal test vector from spec/format.md §3.3 — copied verbatim
// (with `id` omitted, as the spec specifies).
const TV_INPUT: Omit<Snapshot, 'id'> = {
  formatVersion: '0.3',
  parentIds: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
  branch: 'main',
  kind: 'auto',
  codePin: 'b22e80aa12cc34dd56ee78ff90aabbccddeeff00',
  createdAt: '2026-04-29T18:20:00.000Z',
  apmLockHash: null,
  modules: [
    {
      type: 'chatmode',
      name: 'senior-eng',
      enabled: true,
      source: { kind: 'local', path: '.claude/agents/senior-eng.md' },
    },
    {
      type: 'mcp',
      name: 'postgres',
      version: 'v0.9',
      enabled: true,
      source: { kind: 'local', path: '.claude/settings.json' },
    },
  ],
};

// v0.3.0 fixture digest. Filename `canonical-501.bin` is historical
// (the v0.1.1 fixture was 501 bytes); the v0.3.0 fixture is 382 bytes
// — message and sessionId both dropped over v0.1 → v0.2 → v0.3, and
// §3.1 strips createdAt/codePin/model/permissionMode from canonical
// bytes. Historical breadcrumbs at canonical-501-v0_1_1.bin and
// canonical-501-v0_2_0.bin.
const FIXTURE_DIGEST = 'da5289e572c0fe42e6dcda250a6d392543302965325c56a31f9fce9c4d740412';
const FIXTURE_ID = 'da5289e572c0fe42e6dcda250a6d392543302965';
const FIXTURE_BYTE_LENGTH = 382;

// Fields stripped from canonical bytes per spec/format.md §3.1.
const EXCLUDED_FIELDS = [
  'id',
  'createdAt',
  'codePin',
  'model',
  'permissionMode',
  'claudeCodeVersion',
] as const;

function stripExcluded<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = { ...obj };
  for (const k of EXCLUDED_FIELDS) delete out[k];
  return out as Partial<T>;
}

describe('canonical fixture (Gate 1)', () => {
  test('canonicalBytes of TV_INPUT (post §3.1 strip) is byte-identical to canonical-501.bin', () => {
    const expected = readFileSync(resolve(SPEC_DIR, 'test-vectors/canonical-501.bin'));
    const actual = canonicalBytes(stripExcluded(TV_INPUT as Record<string, unknown>));
    expect(actual.byteLength).toBe(FIXTURE_BYTE_LENGTH);
    expect(actual.byteLength).toBe(expected.byteLength);
    expect(Buffer.from(actual).equals(expected)).toBe(true);
  });

  test('snapshotId(TV_INPUT) matches the spec digest prefix', () => {
    expect(snapshotId(TV_INPUT)).toBe(FIXTURE_ID);
    // Spot-check the full digest by hashing fixture bytes directly.
    const fixture = readFileSync(resolve(SPEC_DIR, 'test-vectors/canonical-501.bin'));
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    expect(createHash('sha256').update(fixture).digest('hex')).toBe(FIXTURE_DIGEST);
  });

  test('snapshotId of every example blob round-trips against its filename', () => {
    // For every example blob, recomputing the id from the on-disk JSON
    // (with `id` removed) must equal the filename's id segment.
    const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const examples = path.resolve(SPEC_DIR, 'examples');
    let count = 0;
    function walk(dir: string): void {
      for (const entry of readdirSync(dir)) {
        const p = path.join(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (entry.endsWith('.json')) {
          const blob = JSON.parse(readFileSync(p, 'utf-8')) as Snapshot;
          const segs = p.split(path.sep);
          const onDiskId = segs[segs.length - 2] + segs[segs.length - 1]!.replace('.json', '');
          expect(blob.id).toBe(onDiskId);
          expect(snapshotId(blob)).toBe(onDiskId);
          count++;
        }
      }
    }
    walk(examples);
    expect(count).toBeGreaterThanOrEqual(13);
  });
});

describe('canonicalize: structural rules', () => {
  test('canonical bytes are independent of Object.keys insertion order', () => {
    const a = { z: 1, a: 2, m: 3 };
    const b = { a: 2, m: 3, z: 1 };
    const c = { m: 3, z: 1, a: 2 };
    expect(canonicalBytes(a)).toEqual(canonicalBytes(b));
    expect(canonicalBytes(b)).toEqual(canonicalBytes(c));
  });

  test('nested objects are sorted at every depth', () => {
    const x = { outer: { z: 1, a: 2 }, inner: { y: { d: 1, c: 2 } } };
    const y = { inner: { y: { c: 2, d: 1 } }, outer: { a: 2, z: 1 } };
    expect(canonicalBytes(x)).toEqual(canonicalBytes(y));
  });

  test('arrays preserve order even after sorting their object members keys', () => {
    const a = { arr: [{ z: 1, a: 2 }, { b: 3 }] };
    expect(new TextDecoder().decode(canonicalBytes(a))).toBe(
      '{"arr":[{"a":2,"z":1},{"b":3}]}',
    );
  });

  test('canonicalize does not mutate input', () => {
    const input = { z: 1, a: 2 };
    const before = JSON.stringify(input);
    canonicalize(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  test('snapshotId does not mutate input', () => {
    const input: Snapshot = {
      ...TV_INPUT,
      id: 'placeholder0000000000000000000000000000a',
    };
    const before = JSON.stringify(input);
    snapshotId(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('canonicalize: error cases', () => {
  test('non-integer numbers throw IntegrityError', () => {
    expect(() => canonicalBytes({ x: 1.5 })).toThrowError(IntegrityError);
    expect(() => canonicalBytes({ x: 0.1 })).toThrowError(/integer/);
  });

  test('NaN and Infinity throw IntegrityError', () => {
    expect(() => canonicalBytes({ x: NaN })).toThrowError(/non-finite/);
    expect(() => canonicalBytes({ x: Infinity })).toThrowError(/non-finite/);
  });

  test('integers and zero are accepted', () => {
    expect(() => canonicalBytes({ x: 0 })).not.toThrow();
    expect(() => canonicalBytes({ x: -1 })).not.toThrow();
    expect(() => canonicalBytes({ x: 9007199254740991 })).not.toThrow();
  });
});

describe('snapshotId: shape', () => {
  test('returns 40-char lowercase hex', () => {
    expect(snapshotId(TV_INPUT)).toMatch(/^[0-9a-f]{40}$/);
  });

  test('is deterministic across calls', () => {
    expect(snapshotId(TV_INPUT)).toBe(snapshotId(TV_INPUT));
  });

  test('different blobs produce different ids', () => {
    const a = { ...TV_INPUT };
    const b: Omit<Snapshot, 'id'> = { ...TV_INPUT, branch: 'experimental' };
    expect(snapshotId(a)).not.toBe(snapshotId(b));
  });
});
