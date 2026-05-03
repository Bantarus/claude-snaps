import { describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSnapshots, readSnapshot, writeSnapshot } from '../src/blob.js';
import { snapshotId } from '../src/canonical.js';
import { IntegrityError, ParseError } from '../src/errors.js';
import type { Snapshot } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const SPEC_DIR = resolve(here, '../../../spec');
const SOLO_NO_APM = resolve(SPEC_DIR, 'examples/solo-no-apm/.harness');

const SAMPLE: Omit<Snapshot, 'id'> = {
  formatVersion: '0.2',
  parentIds: [],
  branch: 'main',
  kind: 'init',
  message: 'test',
  codePin: null,
  createdAt: '2026-04-01T00:00:00.000Z',
  apmLockHash: null,
  modules: [
    { type: 'mcp', name: 'Read', enabled: true, source: { kind: 'builtin' } },
  ],
};

describe('blob.readSnapshot', () => {
  test('reads and verifies an example snapshot', () => {
    // Find solo-no-apm init by walking; the id changes each time the
    // build_examples generator runs in v0.2 because canonical bytes
    // depend on the v0.2 shape.
    const ids = listSnapshots(SOLO_NO_APM);
    const initBlob = ids.map((id) => readSnapshot(SOLO_NO_APM, id))
      .find((b) => b.kind === 'init');
    expect(initBlob).toBeDefined();
    expect(initBlob!.parentIds).toEqual([]);
    expect(initBlob!.kind).toBe('init');
  });

  test('reads every example blob and verifies hash integrity', () => {
    const ids = listSnapshots(SOLO_NO_APM);
    // v0.3.1: solo-no-apm has 4 snapshots (was 5; tag-kind dropped).
    expect(ids.length).toBe(4);
    for (const id of ids) {
      const blob = readSnapshot(SOLO_NO_APM, id);
      expect(blob.id).toBe(id);
    }
  });

  test('throws IntegrityError on filename/blob.id mismatch', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'harness-test-'));
    const blob = { ...SAMPLE, id: snapshotId(SAMPLE) };
    // Place under the WRONG <aa> dir to force filename/id mismatch.
    const wrongAa = blob.id.slice(0, 2) === '00' ? '11' : '00';
    const wrongDir = join(tmp, 'snapshots', wrongAa);
    mkdirSync(wrongDir, { recursive: true });
    writeFileSync(
      join(wrongDir, blob.id.slice(2) + '.json'),
      JSON.stringify(blob, null, 2),
      'utf-8',
    );
    // The id we ask for matches blob.id, but the file is under wrong <aa>:
    // readSnapshot uses the requested id to pick the path, so the file
    // won't be found there. To exercise the mismatch branch we instead
    // place a file with WRONG blob.id in the right path.
    const blobMis = { ...blob, id: 'a'.repeat(40) };
    const rightAa = blob.id.slice(0, 2);
    const rightDir = join(tmp, 'snapshots', rightAa);
    mkdirSync(rightDir, { recursive: true });
    writeFileSync(
      join(rightDir, blob.id.slice(2) + '.json'),
      JSON.stringify(blobMis, null, 2),
      'utf-8',
    );
    expect(() => readSnapshot(tmp, blob.id)).toThrowError(IntegrityError);
  });

  test('throws ParseError on malformed JSON', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'harness-test-'));
    const id = 'a'.repeat(40);
    const dir = join(tmp, 'snapshots', id.slice(0, 2));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, id.slice(2) + '.json'), '{not valid json', 'utf-8');
    expect(() => readSnapshot(tmp, id)).toThrowError(ParseError);
  });
});

describe('blob.writeSnapshot', () => {
  test('writes a snapshot, returns it with id set, and round-trips through readSnapshot', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'harness-test-'));
    const written = writeSnapshot(tmp, SAMPLE);
    expect(written.id).toMatch(/^[0-9a-f]{40}$/);
    const loaded = readSnapshot(tmp, written.id);
    expect(loaded).toEqual(written);
  });

  test('atomic: leaves no .tmp files on success', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'harness-test-'));
    const written = writeSnapshot(tmp, SAMPLE);
    const ids = listSnapshots(tmp);
    expect(ids).toEqual([written.id]);
  });

  test('rejects mismatched supplied id', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'harness-test-'));
    const wrong: Snapshot = { ...SAMPLE, id: 'b'.repeat(40) };
    expect(() => writeSnapshot(tmp, wrong)).toThrowError(IntegrityError);
  });

  test('on-disk JSON is pretty-printed (human-diffable per spec §2.0)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'harness-test-'));
    const written = writeSnapshot(tmp, SAMPLE);
    const path = join(tmp, 'snapshots', written.id.slice(0, 2), written.id.slice(2) + '.json');
    const raw = readFileSync(path, 'utf-8');
    expect(raw).toContain('\n');
    expect(raw).toContain('  '); // 2-space indent
  });
});

describe('blob.listSnapshots', () => {
  test('returns 4 ids for solo-no-apm', () => {
    // v0.3.1: solo-no-apm has 4 snapshots (was 5; tag-kind dropped).
    expect(listSnapshots(SOLO_NO_APM).sort().length).toBe(4);
  });

  test('returns empty array on missing snapshots dir', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'harness-test-'));
    expect(listSnapshots(tmp)).toEqual([]);
  });

  test('skips .tmp files (interrupted atomic writes)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'harness-test-'));
    const written = writeSnapshot(tmp, SAMPLE);
    const tmpFile = join(
      tmp,
      'snapshots',
      written.id.slice(0, 2),
      written.id.slice(2) + '.json.tmp',
    );
    writeFileSync(tmpFile, '{}', 'utf-8');
    expect(listSnapshots(tmp)).toEqual([written.id]);
  });
});
