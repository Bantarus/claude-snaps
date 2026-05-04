import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { IoError, ParseError } from './errors.js';

// Tolerant reader: extract ONLY the five fields per spec/apm-integration.md.
// Unknown fields are dropped. Field-key tolerance accommodates upstream
// APM lockfile evolution (the example uses `packages`, but `dependencies`
// is also accepted; both `repoUrl`/`repo_url` shapes are accepted).
//
// Goal: APM bumping their lockfile schema in non-breaking ways MUST NOT
// break us. Renames of the five load-bearing fields would; structural
// changes to ignored fields would not.

export interface ApmLockEntry {
  package: string;
  repoUrl: string;
  resolvedCommit: string;
  depth: number;
  resolvedBy?: string;
  deployedFiles: string[];
}

const DEFAULT_LOCKFILE = 'apm.lock.yaml';

/**
 * Read `<projectRoot>/apm.lock.yaml` and return the entries we care about.
 * Returns `null` if the file is absent or empty.
 *
 * Tolerant: unknown top-level fields are ignored, unknown per-entry
 * fields are ignored, malformed entries are skipped with a console.warn,
 * and the field can be named `packages` or `dependencies` (we look at
 * both).
 *
 * @throws {ParseError} only on truly malformed YAML.
 */
export function readApmLock(
  projectRoot: string,
  filename: string = DEFAULT_LOCKFILE,
): ApmLockEntry[] | null {
  const path = join(projectRoot, filename);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf-8');
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (cause) {
    throw new ParseError(`malformed YAML at ${path}`, cause);
  }
  if (parsed === null || parsed === undefined) return null;
  if (typeof parsed !== 'object') {
    console.warn(`harness apm: ${path} top level is not an object; ignoring`);
    return [];
  }
  const obj = parsed as Record<string, unknown>;
  const list =
    Array.isArray(obj['packages']) ? obj['packages'] :
    Array.isArray(obj['dependencies']) ? obj['dependencies'] :
    null;
  if (list === null) return [];

  const entries: ApmLockEntry[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      console.warn(`harness apm: ${path} entry [${i}] is not an object; skipping`);
      continue;
    }
    const e = item as Record<string, unknown>;
    const pkg = strField(e, 'package');
    const repoUrl = strField(e, 'repo_url') ?? strField(e, 'repoUrl');
    const resolvedCommit = strField(e, 'resolved_commit') ?? strField(e, 'resolvedCommit');
    const depthRaw = e['depth'];
    const depth = typeof depthRaw === 'number' ? depthRaw : null;
    const resolvedBy = strField(e, 'resolved_by') ?? strField(e, 'resolvedBy');
    const deployedFilesRaw = e['deployed_files'] ?? e['deployedFiles'];
    const deployedFiles =
      Array.isArray(deployedFilesRaw) && deployedFilesRaw.every((x) => typeof x === 'string')
        ? (deployedFilesRaw as string[])
        : null;

    if (pkg === null || repoUrl === null || resolvedCommit === null || depth === null || deployedFiles === null) {
      console.warn(
        `harness apm: ${path} entry [${i}] (${pkg ?? '?'}) is missing required field(s); skipping`,
      );
      continue;
    }
    const out: ApmLockEntry = {
      package: pkg,
      repoUrl,
      resolvedCommit,
      depth,
      deployedFiles,
    };
    if (resolvedBy !== null) out.resolvedBy = resolvedBy;
    entries.push(out);
  }
  return entries;
}

/**
 * sha256 of the lockfile bytes, prefixed `sha256:`. Returns `null` if
 * the file is absent. Bytes are hashed verbatim — no normalization, no
 * reformatting (per spec/apm-integration.md §3).
 */
export function apmLockHash(
  projectRoot: string,
  filename: string = DEFAULT_LOCKFILE,
): string | null {
  const path = join(projectRoot, filename);
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

/**
 * Read the verbatim text of `<projectRoot>/apm.lock.yaml`. Returns
 * `null` if the file is absent. Used by capture (v0.4.0) to embed the
 * lockfile content into the snapshot blob so `harness reproduce` is
 * self-contained against the project's git state.
 *
 * Reads as UTF-8. The bytes are stored verbatim — no normalization,
 * no reformatting. `apmLockHash()` over the same path MUST produce
 * `sha256:` + sha-256 of these bytes (the invariant readers rely on
 * to detect tampering between capture and reproduce).
 */
export function readApmLockfileContent(
  projectRoot: string,
  filename: string = DEFAULT_LOCKFILE,
): string | null {
  const path = join(projectRoot, filename);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf-8');
  } catch (cause) {
    throw new IoError(`failed to read ${path}`, cause);
  }
}

/**
 * Write `<projectRoot>/apm.lock.yaml` with the supplied content. If a
 * lockfile already exists, it is moved aside to
 * `apm.lock.yaml.harness-backup` (overwriting any prior backup) before
 * the new content lands. The backup is intentional: a user who runs
 * `harness reproduce` while holding uncommitted lockfile changes can
 * recover by `mv`-ing the backup back.
 *
 * Used by `harness reproduce` (v0.4.0) to materialize the snapshot's
 * recorded `apmLockfile` before invoking `apm install --frozen`.
 *
 * @throws {IoError} on filesystem failure.
 */
export function writeApmLockfile(
  projectRoot: string,
  content: string,
  filename: string = DEFAULT_LOCKFILE,
): void {
  const path = join(projectRoot, filename);
  if (existsSync(path)) {
    const backupPath = `${path}.harness-backup`;
    try {
      copyFileSync(path, backupPath);
    } catch (cause) {
      throw new IoError(`failed to back up ${path} to ${backupPath}`, cause);
    }
  }
  try {
    writeFileSync(path, content, 'utf-8');
  } catch (cause) {
    throw new IoError(`failed to write ${path}`, cause);
  }
}

/**
 * Run `apm install --force` in `projectRoot`. Returns a structured
 * result. Captures stdout and stderr.
 *
 * Why `--force` and not `--frozen`: APM's default `apm install` already
 * honors the existing `apm.lock.yaml` (locked-commits-reused per the
 * APM CLI lifecycle table). The CLI's `--update` flag is the opt-in
 * for re-resolving; absence of `--update` IS the frozen behavior. The
 * additional `--force` is necessary because the reproducer typically
 * runs against a `.claude/` whose contents have drifted from the
 * captured composition (the user is reproducing precisely because
 * they want to overwrite that drift); without `--force`, APM refuses
 * to overwrite locally-authored files. APM 0.8.x has no literal
 * `--frozen` flag.
 *
 * Failure modes surfaced via `success: false`:
 *  - `apm` not on PATH (ENOENT — surfaced with a hint pointing at the
 *    APM repo).
 *  - `apm install --force` exits non-zero (network failure, deleted
 *    upstream commit, version conflict).
 *
 * Used by `harness reproduce` (spec/format.md §6.1).
 */
export function runApmInstallLocked(
  projectRoot: string,
): { success: true; stdout: string } | { success: false; stderr: string; exitCode: number | null; reason: 'not-on-path' | 'install-failed' } {
  const result = spawnSync('apm', ['install', '--force'], {
    cwd: projectRoot,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        success: false,
        stderr:
          'harness: apm not found on PATH; install APM (https://github.com/microsoft/apm) to use harness reproduce',
        exitCode: null,
        reason: 'not-on-path',
      };
    }
    return {
      success: false,
      stderr: `apm install failed to spawn: ${result.error.message}`,
      exitCode: null,
      reason: 'install-failed',
    };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '') + (result.stdout ?? '');
    return {
      success: false,
      stderr: stderr.length === 0 ? `apm install --force exited ${result.status}` : stderr,
      exitCode: result.status,
      reason: 'install-failed',
    };
  }
  return { success: true, stdout: result.stdout ?? '' };
}

// ── private ────────────────────────────────────────────────────────────────

function strField(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' ? v : null;
}
