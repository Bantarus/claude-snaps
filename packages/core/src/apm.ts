import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ParseError } from './errors.js';

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

// ── private ────────────────────────────────────────────────────────────────

function strField(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' ? v : null;
}
