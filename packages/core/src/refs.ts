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
import { join, posix } from 'node:path';
import { IntegrityError, IoError, RefNotFoundError } from './errors.js';
import type { HeadState } from './types.js';

const REF_NAME_RE = /^[A-Za-z0-9._/-]+$/;
const ID_RE = /^[0-9a-f]{40}$/;

/**
 * Validate a branch or ref-segment name (no leading `refs/...` path).
 * Same character class and exclusions as validateRefPath but exported
 * for callers (Repo.init's --branch, branch/tag commands) that
 * receive a bare name from the user.
 *
 * @throws {IntegrityError} when the name contains anything outside
 * [A-Za-z0-9._/-], a `..` segment, a `.lock` suffix, or is absolute.
 */
export function validateRefName(name: string): void {
  if (!REF_NAME_RE.test(name) || name.includes('..') || name.endsWith('.lock')) {
    throw new IntegrityError(`invalid ref name: ${JSON.stringify(name)}`);
  }
  if (posix.isAbsolute(name)) {
    throw new IntegrityError(`ref name must be relative: ${name}`);
  }
}

/**
 * Read `<harnessDir>/HEAD`. Returns:
 *   - { type: 'symbolic', ref } when HEAD contains "ref: <path>"
 *   - { type: 'detached', id } when HEAD contains a 40-hex id
 *   - null only when HEAD itself is missing (a malformed/non-conforming repo)
 *
 * The empty-repo case (HEAD pointing at a not-yet-existing branch ref)
 * still returns { type: 'symbolic', ref } — call resolveHead to learn
 * whether the symbolic ref actually resolves to an id.
 *
 * @throws {ParseError} if HEAD is present but unparseable.
 * @throws {IoError} on filesystem failure other than ENOENT.
 */
export function readHead(harnessDir: string): HeadState {
  const path = join(harnessDir, 'HEAD');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new IoError(`failed to read HEAD at ${path}`, cause);
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('ref:')) {
    const ref = trimmed.slice('ref:'.length).trim();
    if (!ref.startsWith('refs/')) {
      throw new IntegrityError(`HEAD symbolic ref must start with 'refs/' (got: ${ref})`);
    }
    return { type: 'symbolic', ref };
  }
  if (ID_RE.test(trimmed)) return { type: 'detached', id: trimmed };
  throw new IntegrityError(`HEAD has unrecognized form: ${JSON.stringify(trimmed)}`);
}

/**
 * Resolve HEAD to a snapshot id, or null if HEAD is symbolic and points
 * at a branch ref that does not yet exist on disk (the empty-repo case
 * specified in spec/format.md §4.4).
 *
 * Detached HEAD resolves to its id. Missing HEAD throws (malformed repo).
 */
export function resolveHead(harnessDir: string): string | null {
  const head = readHead(harnessDir);
  if (head === null) {
    throw new IntegrityError(`missing HEAD at ${join(harnessDir, 'HEAD')}`);
  }
  if (head.type === 'detached') return head.id;
  // symbolic: read the underlying ref. It may not exist yet (empty repo).
  const refPath = head.ref.startsWith('refs/') ? head.ref.slice('refs/'.length) : head.ref;
  try {
    return readRef(harnessDir, refPath);
  } catch (e) {
    if (e instanceof RefNotFoundError) return null;
    throw e;
  }
}

/**
 * Read a ref file under `<harnessDir>/refs/`. `refPath` is the suffix
 * after `refs/`, e.g. `'heads/main'` or `'tags/v0.4'`.
 *
 * @returns the snapshot id stored in the ref (40 hex chars).
 * @throws {RefNotFoundError} when the file does not exist.
 * @throws {IntegrityError} when the file content is not a valid id.
 * @throws {IoError} on other filesystem failures.
 */
export function readRef(harnessDir: string, refPath: string): string {
  validateRefPath(refPath);
  const path = join(harnessDir, 'refs', refPath);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new RefNotFoundError(`ref not found: ${refPath}`, cause);
    }
    throw new IoError(`failed to read ref ${refPath} at ${path}`, cause);
  }
  const id = raw.trim();
  if (!ID_RE.test(id)) {
    throw new IntegrityError(
      `ref ${refPath} content is not a valid 40-hex snapshot id (got: ${JSON.stringify(id)})`,
    );
  }
  return id;
}

/**
 * Write a ref file atomically (write tmp + fsync + rename).
 *
 * @throws {IntegrityError} on invalid refPath or invalid id.
 * @throws {IoError} on filesystem failure.
 */
export function writeRef(harnessDir: string, refPath: string, id: string): void {
  validateRefPath(refPath);
  if (!ID_RE.test(id)) {
    throw new IntegrityError(`writeRef: invalid id (must be 40 hex): ${id}`);
  }
  const finalPath = join(harnessDir, 'refs', refPath);
  const tmpPath = `${finalPath}.tmp`;
  const dir = join(harnessDir, 'refs', refPath.split('/').slice(0, -1).join('/'));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmpPath, id + '\n', { encoding: 'utf-8', flag: 'w' });
    const fd = openSync(tmpPath, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmpPath, finalPath);
  } catch (cause) {
    throw new IoError(`failed to write ref ${refPath} at ${finalPath}`, cause);
  }
}

/**
 * List refs under `refs/heads/` or `refs/tags/`. Returns a map of
 * ref-name → snapshot id. Empty if the directory is missing.
 */
export function listRefs(
  harnessDir: string,
  prefix: 'heads/' | 'tags/' = 'heads/',
): Record<string, string> {
  const dir = join(harnessDir, 'refs', prefix);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new IoError(`failed to read ${dir}`, cause);
  }
  const out: Record<string, string> = {};
  for (const name of entries) {
    const full = join(dir, name);
    let s;
    try { s = statSync(full); } catch { continue; }
    if (!s.isFile()) continue;
    if (name.endsWith('.tmp')) continue;
    out[name] = readRef(harnessDir, prefix + name);
  }
  return out;
}

// ── private ────────────────────────────────────────────────────────────────

function validateRefPath(refPath: string): void {
  if (!REF_NAME_RE.test(refPath) || refPath.includes('..') || refPath.endsWith('.lock')) {
    throw new IntegrityError(`invalid ref path: ${JSON.stringify(refPath)}`);
  }
  if (posix.isAbsolute(refPath)) {
    throw new IntegrityError(`ref path must be relative under refs/: ${refPath}`);
  }
}
