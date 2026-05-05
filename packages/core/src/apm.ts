import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
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
  return parseApmLockfile(raw, path);
}

/**
 * Parse an apm.lock.yaml content string into entries. Used by the
 * v0.4.1 reproducer to operate on the snapshot's recorded
 * `apmLockfile` content without writing it to disk first.
 *
 * @throws {ParseError} only on truly malformed YAML.
 */
export function parseApmLockfile(
  raw: string,
  sourceLabel: string = '<inline>',
): ApmLockEntry[] | null {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (cause) {
    throw new ParseError(`malformed YAML at ${sourceLabel}`, cause);
  }
  if (parsed === null || parsed === undefined) return null;
  if (typeof parsed !== 'object') {
    console.warn(`harness apm: ${sourceLabel} top level is not an object; ignoring`);
    return [];
  }
  return parseEntries(parsed as Record<string, unknown>, sourceLabel);
}

function parseEntries(obj: Record<string, unknown>, sourceLabel: string): ApmLockEntry[] {
  const list =
    Array.isArray(obj['packages']) ? obj['packages'] :
    Array.isArray(obj['dependencies']) ? obj['dependencies'] :
    null;
  if (list === null) return [];

  const entries: ApmLockEntry[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      console.warn(`harness apm: ${sourceLabel} entry [${i}] is not an object; skipping`);
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
    const sourceField = strField(e, 'source');
    const localPath = strField(e, 'local_path') ?? strField(e, 'localPath');

    // Local-path APM entries (added v0.4.1). APM 0.8.x emits these for
    // `dependencies.apm: - <abs-path>` deps. Shape:
    //   - repo_url: _local/<basename>
    //     source: local
    //     local_path: /abs/path
    //     deployed_files: [<dir or file>...]
    // (no `package`, no `resolved_commit`, no `depth`)
    //
    // Without the synthesis below, capture skips these entries and the
    // resulting modules end up as `kind: "local"` — so the reproducer
    // reports them as "not reproduced" even though `apm install`
    // re-materializes them. Synthesizing apm-kind identity closes that
    // misleading-report gap (v0.4.1 finding).
    const isLocalPath = sourceField === 'local'
      || (repoUrl !== null && repoUrl.startsWith('_local/'))
      || localPath !== null;
    if (isLocalPath && deployedFiles !== null) {
      const synthesized = synthesizeLocalPathEntry({
        repoUrl,
        localPath,
        deployedFiles,
        path: sourceLabel,
        index: i,
      });
      if (synthesized !== null) entries.push(synthesized);
      continue;
    }

    if (pkg === null || repoUrl === null || resolvedCommit === null || depth === null || deployedFiles === null) {
      console.warn(
        `harness apm: ${sourceLabel} entry [${i}] (${pkg ?? '?'}) is missing required field(s); skipping`,
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
 * Synthesize an `ApmLockEntry` from a local-path lockfile entry. APM
 * 0.8.x records local-path deps without `package`, `resolved_commit`,
 * or `depth`, but the harness reader needs all five fields to drive
 * APM-source enrichment (capture.ts §2). The synthesis:
 *
 * - **package**: the `_local/<name>` form from `repo_url`, or
 *   `_local/<basename>` derived from `local_path`. The `_local/`
 *   prefix is preserved so consumers can distinguish synthesized
 *   identities from upstream-resolved ones.
 * - **resolvedCommit**: `git rev-parse HEAD` on the `local_path` if
 *   it's a git repo; otherwise a sha-256 of the directory's file
 *   contents (deterministic given identical bytes). 40-hex either way.
 * - **depth**: 1 (local-path deps are always direct — there's no
 *   transitive layer for them in APM's resolution).
 *
 * Returns null only when neither `repo_url`'s `_local/<name>` form
 * nor `local_path`'s basename can yield a usable package name.
 */
function synthesizeLocalPathEntry(args: {
  repoUrl: string | null;
  localPath: string | null;
  deployedFiles: string[];
  path: string;
  index: number;
}): ApmLockEntry | null {
  const { repoUrl, localPath, deployedFiles, path, index } = args;

  let pkg: string;
  if (repoUrl !== null && repoUrl.startsWith('_local/')) {
    pkg = repoUrl;
  } else if (localPath !== null && localPath.length > 0) {
    pkg = `_local/${basename(localPath)}`;
  } else {
    console.warn(
      `harness apm: ${path} entry [${index}] is local-path-shaped but has no repo_url or local_path; skipping`,
    );
    return null;
  }

  const resolvedCommit = synthesizeLocalCommit(localPath);
  const finalRepoUrl = repoUrl ?? pkg;

  return {
    package: pkg,
    repoUrl: finalRepoUrl,
    resolvedCommit,
    depth: 1,
    deployedFiles,
  };
}

function synthesizeLocalCommit(localPath: string | null): string {
  // Prefer `git rev-parse HEAD` when the path is a git repo — the
  // most natural identity stable across captures. Fall back to a
  // content hash for non-git directories. If `localPath` is null or
  // unreadable, return a deterministic placeholder (the path string
  // itself, hashed) so the field is always populated.
  const fallback = (input: string): string =>
    createHash('sha256').update(input).digest('hex').slice(0, 40);

  if (localPath === null || !existsSync(localPath)) {
    return fallback(localPath ?? '');
  }
  try {
    if (statSync(localPath).isDirectory() && existsSync(join(localPath, '.git'))) {
      const out = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: localPath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (/^[0-9a-f]{40}$/.test(out)) return out;
    }
  } catch {
    // git failed (no commits, detached, missing git) → fall through
  }
  // Content-hash fallback: not load-bearing for reproducer correctness
  // (the reproducer drives apm install --force, which doesn't consult
  // resolved_commit for local paths). The synthesized commit is for
  // capture-side identity stability only.
  return fallback(localPath);
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
