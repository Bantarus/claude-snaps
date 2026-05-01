import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { snapshotId } from './canonical.js';
import { IoError, IntegrityError, ParseError } from './errors.js';
import type { Snapshot } from './types.js';

/**
 * Read a snapshot blob from `<harnessDir>/snapshots/<aa>/<rest>.json`.
 * Verifies on read: (a) the blob is valid JSON, (b) `blob.id` matches
 * the filename id, (c) recomputed `snapshotId` matches `blob.id`.
 *
 * @throws {ParseError} on malformed JSON.
 * @throws {IntegrityError} on hash mismatch (filename, blob.id, recomputed disagree).
 * @throws {IoError} on filesystem failure.
 */
export function readSnapshot(harnessDir: string, id: string): Snapshot {
  if (!/^[0-9a-f]{40}$/.test(id)) {
    throw new IntegrityError(`invalid snapshot id (must be 40 hex): ${id}`);
  }
  const path = blobPath(harnessDir, id);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (cause) {
    throw new IoError(`failed to read snapshot ${id} at ${path}`, cause);
  }
  let blob: Snapshot;
  try {
    blob = JSON.parse(raw) as Snapshot;
  } catch (cause) {
    throw new ParseError(`invalid JSON in ${path}`, cause);
  }
  if (blob.id !== id) {
    throw new IntegrityError(
      `blob.id (${blob.id}) does not match filename id (${id}) at ${path}`,
    );
  }
  const recomputed = snapshotId(blob);
  if (recomputed !== id) {
    throw new IntegrityError(
      `snapshot ${id} fails canonical-hash verification (recomputed ${recomputed}); blob may be corrupted or tampered with`,
    );
  }
  return blob;
}

/**
 * Write a snapshot blob atomically. If `snap.id` is absent, computes it.
 * If `snap.id` is present, validates that it matches the recomputed id
 * before writing; mismatch is an IntegrityError.
 *
 * Atomicity: write to `<rest>.json.tmp` in the same dir, fsync, rename.
 * The rename is atomic on POSIX; the tmp file is reclaimed on failure.
 *
 * @returns the snapshot with `id` set.
 * @throws {IntegrityError} if `snap.id` is supplied but doesn't match.
 * @throws {IoError} on filesystem failure.
 */
export function writeSnapshot(
  harnessDir: string,
  snap: Snapshot | Omit<Snapshot, 'id'>,
): Snapshot {
  const computed = snapshotId(snap);
  const supplied = (snap as Snapshot).id;
  if (supplied !== undefined && supplied !== computed) {
    throw new IntegrityError(
      `supplied snap.id (${supplied}) does not match canonical hash (${computed})`,
    );
  }
  const blob: Snapshot = { ...(snap as Snapshot), id: computed };
  const finalPath = blobPath(harnessDir, computed);
  const tmpPath = `${finalPath}.tmp`;
  const dir = join(harnessDir, 'snapshots', computed.slice(0, 2));

  try {
    mkdirSync(dir, { recursive: true });
    // Pretty-print on disk for human diffability — only canonical bytes
    // are normative for hashing (spec/format.md §2.0).
    const json = JSON.stringify(blob, null, 2) + '\n';
    writeFileSync(tmpPath, json, { encoding: 'utf-8', flag: 'w' });
    const fd = openSync(tmpPath, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, finalPath);
  } catch (cause) {
    throw new IoError(`failed to write snapshot ${computed} to ${finalPath}`, cause);
  }
  return blob;
}

/**
 * Enumerate all snapshot ids on disk by walking `<harnessDir>/snapshots/*`.
 * Returns ids only — does NOT load blobs. Order is unspecified.
 *
 * @throws {IoError} on filesystem failure other than ENOENT (missing dir → []).
 */
export function listSnapshots(harnessDir: string): string[] {
  const root = join(harnessDir, 'snapshots');
  let topLevel: string[];
  try {
    topLevel = readdirSync(root);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new IoError(`failed to read ${root}`, cause);
  }
  const ids: string[] = [];
  for (const aa of topLevel) {
    if (!/^[0-9a-f]{2}$/.test(aa)) continue; // skip stray files
    const sub = join(root, aa);
    let entries: string[];
    try {
      const s = statSync(sub);
      if (!s.isDirectory()) continue;
      entries = readdirSync(sub);
    } catch (cause) {
      throw new IoError(`failed to read ${sub}`, cause);
    }
    for (const fname of entries) {
      if (!fname.endsWith('.json')) continue;
      if (fname.endsWith('.json.tmp')) continue; // partial atomic write
      const rest = fname.slice(0, -'.json'.length);
      if (!/^[0-9a-f]{38}$/.test(rest)) continue;
      ids.push(aa + rest);
    }
  }
  return ids;
}

// ── private ────────────────────────────────────────────────────────────────

function blobPath(harnessDir: string, id: string): string {
  return join(harnessDir, 'snapshots', id.slice(0, 2), `${id.slice(2)}.json`);
}
