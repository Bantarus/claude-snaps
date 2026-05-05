import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  apmLockHash as apmLockHashOf,
  parseApmLockfile,
  readApmLock,
  runApmInstallLocked,
  writeApmLockfile,
} from './apm.js';
import { captureCurrentState } from './capture.js';
import { IntegrityError, IoError } from './errors.js';
import type {
  Module, ReproduceOptions, ReproduceResult, Snapshot,
} from './types.js';

// The set of host-known builtins. Mirrors capture.ts's BUILTIN_TOOLS.
// A snapshot's builtin module is "verified" when its name appears here.
// Builtins are not load-bearing for reproduction — a missing one is
// reported, not fatal — but capturing the set centralized here keeps the
// host's known surface in one place.
const KNOWN_BUILTINS: ReadonlySet<string> = new Set([
  'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write',
  'Task', 'TodoWrite', 'WebFetch', 'WebSearch', 'NotebookEdit',
]);

/**
 * Materialize a snapshot's harness composition into the working
 * `.claude/` directory. Implementation of the reproducer contract
 * defined in spec/format.md §6.1.
 *
 * APM is a hard prerequisite for content. Snapshots whose
 * `apmLockfile` is null (v0.3.x snapshots, or projects without APM
 * at capture time) reproduce as builtins-only verification + local-
 * source reporting; nothing is written to `.claude/` for content.
 *
 * Side effects when not in dry-run:
 *   1. Pre-checks `apm` is on PATH; aborts before any other action if not.
 *   2. Backs up `.claude/` to `.claude.harness-backup-<ISO timestamp>/`.
 *   3. If snapshot has `apmLockfile` AND any apm-source module:
 *      - Writes the lockfile to `apm.lock.yaml` (existing lockfile is
 *        moved aside to `apm.lock.yaml.harness-backup`).
 *      - Runs `apm install --frozen`.
 *      - Re-walks `.claude/` and verifies each apm-source module's
 *        configHash matches the snapshot's recorded value.
 *   4. Verifies builtins against the host's known set (reports missing
 *      but does not abort).
 *   5. Reports local-source modules (no filesystem action — the
 *      reproducer does not materialize local-source content).
 *   6. On success (apm phase not failed): advances HEAD to the snapshot
 *      id (detached).
 *
 * @throws {IoError} on filesystem failure (backup write, lockfile write).
 * @throws {IntegrityError} only if the snapshot itself is malformed.
 */
export function reproduceSnapshot(args: {
  projectRoot: string;
  harnessDir: string;
  snapshotId: string;
  snapshot: Snapshot;
  options?: ReproduceOptions;
}): ReproduceResult {
  const { projectRoot, harnessDir, snapshotId, snapshot, options } = args;
  const dryRun = options?.dryRun ?? false;

  // Categorize modules upfront — this work is shared by dry-run and
  // real-run paths so they describe the same plan.
  const apmModules: Array<{ module: Module; expected: string | undefined }> = [];
  const builtinsExpectedRaw: Module[] = [];
  const localSourceReported: ReproduceResult['localSourceReported'] = [];
  for (const m of snapshot.modules) {
    if (m.source.kind === 'apm') {
      apmModules.push({ module: m, expected: m.configHash });
    } else if (m.source.kind === 'builtin') {
      builtinsExpectedRaw.push(m);
    } else if (m.source.kind === 'local') {
      const entry: ReproduceResult['localSourceReported'][number] = {
        name: m.name,
        type: m.type as string,
        path: m.source.path,
      };
      if (m.configHash !== undefined) entry.configHash = m.configHash;
      localSourceReported.push(entry);
    }
    // x-extension kinds: opaque per §9.2; treated like "neither apm
    // nor builtin nor local" — not in the reproducer's contract.
    // Silently dropped; readers preserve them on round-trip but the
    // reproducer cannot act on them.
  }

  const backupPath = computeBackupPath(projectRoot);
  const headPath = join(harnessDir, 'HEAD');

  // SUBTRACTIVE CLEANUP PRECOMPUTE (v0.4.1; spec §6.1).
  // Compute the set of paths the reproducer would remove. Done before
  // any side effect so dry-run can describe the planned cleanup.
  const subtractiveScope = computeSubtractiveScope({
    projectRoot,
    targetLockfileContent: snapshot.apmLockfile ?? null,
    targetModules: snapshot.modules,
  });

  if (dryRun) {
    return {
      snapshotId,
      backupPath,
      dryRun: true,
      apmPhase: chooseApmPhaseForDryRun(snapshot, apmModules.length),
      apmModulesExpected: apmModules.length,
      apmModulesVerified: 0,
      apmFailures: [],
      builtinsExpected: builtinsExpectedRaw.length,
      builtinsMissing: [],
      localSourceReported,
      headAdvanced: false,
      pathsRemoved: subtractiveScope.pathsToRemove,
      projectLockfileRemoved: subtractiveScope.willRemoveProjectLockfile,
    };
  }

  // 1. Pre-flight: apm on PATH? Only if we'd actually invoke it.
  //    Per spec §6.1: "Reproducer aborts BEFORE backup. Clear error."
  //
  //    APM install runs whenever the snapshot has an apmLockfile, NOT
  //    only when it has apm-kind modules. The lockfile is what gets
  //    reinstalled; module categorization (apm vs local) is a capture
  //    decision that doesn't change what install --frozen does. A
  //    snapshot whose apmLockfile is populated always wants apm
  //    install --frozen run during reproduction; the per-module
  //    verification step happens only for apm-kind modules.
  const willRunApm = snapshot.apmLockfile !== undefined
    && snapshot.apmLockfile !== null;
  if (willRunApm) {
    assertApmOnPath();
  }

  // 2. Backup .claude/.
  backupClaudeDir(projectRoot, backupPath);

  // 3. APM phase.
  let apmPhase: ReproduceResult['apmPhase'] = 'skipped';
  let apmModulesVerified = 0;
  const apmFailures: ReproduceResult['apmFailures'] = [];
  let apmStderr: string | undefined;

  if (willRunApm) {
    // SAFETY: the type-narrowed snapshot.apmLockfile is non-null per the
    // willRunApm check above; the assertion is for the type checker.
    const lockfileContent = snapshot.apmLockfile as string;
    writeApmLockfile(projectRoot, lockfileContent);
    const installResult = runApmInstallLocked(projectRoot);
    if (!installResult.success) {
      apmPhase = 'failed';
      apmStderr = installResult.stderr;
    } else {
      apmPhase = 'success';
      // Re-capture and verify configHashes.
      const observed = captureCurrentState(projectRoot);
      const observedByKey = new Map<string, Module>();
      for (const m of observed) observedByKey.set(moduleKey(m), m);
      for (const { module: m, expected } of apmModules) {
        const found = observedByKey.get(moduleKey(m));
        if (found === undefined) {
          apmFailures.push({
            name: m.name,
            type: m.type as string,
            reason: 'apm install completed but module not found in re-captured composition',
          });
          continue;
        }
        if (expected !== undefined && found.configHash !== expected) {
          apmFailures.push({
            name: m.name,
            type: m.type as string,
            reason: `configHash mismatch (expected ${expected}, observed ${found.configHash ?? 'none'})`,
          });
          continue;
        }
        apmModulesVerified += 1;
      }
      if (apmFailures.length > 0) apmPhase = 'failed';
    }
  }

  // Cross-check the embedded lockfile bytes if present — the on-disk
  // copy after writeApmLockfile should hash to apmLockHash exactly. This
  // is a sanity check that the snapshot blob isn't internally inconsistent
  // (apmLockHash and apmLockfile drift).
  if (willRunApm && snapshot.apmLockHash !== null && apmPhase === 'success') {
    const recomputed = apmLockHashOf(projectRoot);
    if (recomputed !== snapshot.apmLockHash) {
      // This is a real "snapshot is malformed" signal — the recorded hash
      // doesn't match the recorded content. Surface it loudly but don't
      // abort the result; the user has already seen apm install succeed.
      apmFailures.push({
        name: '<lockfile>',
        type: 'apm',
        reason: `apmLockHash mismatch after install: recorded ${snapshot.apmLockHash}, recomputed ${recomputed ?? 'null'}`,
      });
    }
  }

  // 4. Builtins verification (advisory — does not abort).
  const builtinsMissing: ReproduceResult['builtinsMissing'] = [];
  for (const m of builtinsExpectedRaw) {
    if (!KNOWN_BUILTINS.has(m.name)) {
      builtinsMissing.push({ name: m.name, type: m.type as string });
    }
  }

  // 5. SUBTRACTIVE PASS (v0.4.1; spec §6.1).
  //    Only on a clean APM phase — if install failed, we leave the
  //    backup as-is and don't touch the (potentially partial) tree
  //    further. Files that were APM-managed in the prior state but
  //    aren't in the target snapshot's scope OR target's local-source
  //    paths are removed. Local-source paths are never touched.
  //    Project-root apm.lock.yaml is removed when target recorded no
  //    APM state.
  const pathsRemoved: string[] = [];
  let projectLockfileRemoved = false;
  if (apmPhase !== 'failed') {
    for (const rel of subtractiveScope.pathsToRemove) {
      const abs = join(projectRoot, rel);
      try {
        if (existsSync(abs)) {
          rmSync(abs, { recursive: true, force: true });
          pathsRemoved.push(rel);
        }
      } catch (cause) {
        throw new IoError(`failed to remove ${abs}`, cause);
      }
    }
    if (subtractiveScope.willRemoveProjectLockfile) {
      const lockfilePath = join(projectRoot, 'apm.lock.yaml');
      try {
        copyFileSync(lockfilePath, `${lockfilePath}.harness-backup`);
        rmSync(lockfilePath, { force: true });
        projectLockfileRemoved = true;
      } catch (cause) {
        throw new IoError(`failed to remove ${lockfilePath}`, cause);
      }
    }
  }

  // 6. Advance HEAD if APM phase was not failed. Detached.
  let headAdvanced = false;
  if (apmPhase !== 'failed') {
    try {
      writeFileSync(headPath, `${snapshotId}\n`, 'utf-8');
      headAdvanced = true;
    } catch (cause) {
      throw new IoError(`failed to advance HEAD at ${headPath}`, cause);
    }
  }

  const result: ReproduceResult = {
    snapshotId,
    backupPath,
    dryRun: false,
    apmPhase,
    apmModulesExpected: apmModules.length,
    apmModulesVerified,
    apmFailures,
    builtinsExpected: builtinsExpectedRaw.length,
    builtinsMissing,
    localSourceReported,
    headAdvanced,
    pathsRemoved,
    projectLockfileRemoved,
  };
  if (apmStderr !== undefined) result.apmStderr = apmStderr;
  return result;
}

/**
 * Compute which paths the subtractive pass would remove. Pure read-
 * only function; safe to call from dry-run.
 *
 * Algorithm (v0.4.1; spec/format.md §6.1):
 *   current_apm_paths = deployed_files entries from project's live
 *                       apm.lock.yaml (if present)
 *   target_apm_paths  = deployed_files entries from snapshot.apmLockfile
 *                       (if non-null)
 *   target_local_paths = m.source.path for each local-kind module in
 *                        target snapshot
 *
 *   pathsToRemove = current_apm_paths
 *                 - target_apm_paths
 *                 - target_local_paths
 *
 *   willRemoveProjectLockfile = (target.apmLockfile is null) AND
 *                                project has live apm.lock.yaml
 *
 * Restricting removal to paths under `.claude/` is enforced by the
 * deployed_files shape — APM only deploys into `.claude/` (or the
 * other tool-specific dirs we don't claim). Per the amendment, local-
 * source paths are excluded from removal even if they happen to
 * appear in the live lockfile (defensive: a misconfigured project
 * shouldn't lose hand-written files to the reproducer).
 */
function computeSubtractiveScope(args: {
  projectRoot: string;
  targetLockfileContent: string | null;
  targetModules: Module[];
}): { pathsToRemove: string[]; willRemoveProjectLockfile: boolean } {
  const { projectRoot, targetLockfileContent, targetModules } = args;

  const currentEntries = readApmLock(projectRoot) ?? [];
  const targetEntries = targetLockfileContent !== null
    ? (parseApmLockfile(targetLockfileContent, '<snapshot.apmLockfile>') ?? [])
    : [];

  const currentApmPaths = new Set<string>(currentEntries.flatMap((e) => e.deployedFiles));
  const targetApmPaths = new Set<string>(targetEntries.flatMap((e) => e.deployedFiles));
  const targetLocalPaths = new Set<string>(
    targetModules
      .filter((m) => m.source.kind === 'local')
      .map((m) => (m.source as { path: string }).path),
  );

  const pathsToRemove: string[] = [];
  for (const p of currentApmPaths) {
    if (targetApmPaths.has(p)) continue;
    if (targetLocalPaths.has(p)) continue;
    if (isPathUnderClaudeDir(p)) pathsToRemove.push(p);
  }
  // Stable order — sort lexicographically so dry-run output is
  // deterministic and tests can pin the rendering.
  pathsToRemove.sort();

  const lockfilePath = join(projectRoot, 'apm.lock.yaml');
  const willRemoveProjectLockfile =
    targetLockfileContent === null && existsSync(lockfilePath);

  return { pathsToRemove, willRemoveProjectLockfile };
}

function isPathUnderClaudeDir(p: string): boolean {
  // Restrict removal to the `.claude/` subtree. Defensive: a
  // hypothetical lockfile that lists paths outside `.claude/` (e.g.
  // a misconfigured `deployed_files` pointing at `/etc/...`) MUST
  // NOT cause the reproducer to delete arbitrary files.
  return p === '.claude' || p.startsWith('.claude/');
}

// ── helpers ────────────────────────────────────────────────────────────────

function moduleKey(m: Module): string {
  return `${m.type} ${m.name}`;
}

function chooseApmPhaseForDryRun(snap: Snapshot, _apmModuleCount: number): ReproduceResult['apmPhase'] {
  // Dry-run reports "what would happen if the install succeeded": skipped
  // when no apmLockfile is recorded, success otherwise. Module count
  // doesn't gate the install — the lockfile is what gets reinstalled.
  if (snap.apmLockfile === undefined || snap.apmLockfile === null) return 'skipped';
  return 'success';
}

function computeBackupPath(projectRoot: string): string {
  // ISO-8601 with `:` and `.` replaced by `-` to make the directory name
  // shell-safe across platforms. Matches the shape documented in
  // format.md §6.1's "Side effects" section.
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return join(projectRoot, `.claude.harness-backup-${ts}`);
}

function backupClaudeDir(projectRoot: string, backupPath: string): void {
  const claudeDir = join(projectRoot, '.claude');
  try {
    mkdirSync(backupPath, { recursive: true });
    if (existsSync(claudeDir)) {
      cpSync(claudeDir, backupPath, { recursive: true });
    }
    // If .claude/ doesn't exist, the backup is an empty directory. The
    // contract is "back up before any write" — the empty directory is
    // the honest representation of pre-reproduce state.
  } catch (cause) {
    throw new IoError(`failed to back up ${claudeDir} to ${backupPath}`, cause);
  }
}

function assertApmOnPath(): void {
  // spawnSync with a no-op flag tells us whether the binary resolves
  // without doing real work. We use `--version` because every CLI
  // implements it cheaply and never modifies state.
  const probe = spawnSync('apm', ['--version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  if (probe.error !== undefined && (probe.error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new IntegrityError(
      'harness: apm not found on PATH; install APM (https://github.com/microsoft/apm) to use harness reproduce',
    );
  }
  // Non-zero exit from --version is unusual but not fatal here; the real
  // failure surfaces from `apm install --frozen` if the binary is
  // genuinely broken.
}

