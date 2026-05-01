import { Repo, snapshotId, type Snapshot } from '@harness/core';
import { parseHookArgs } from './args.js';

/**
 * harness-hook entry point. Captures a SessionStart snapshot and exits 0
 * on every code path — including caught exceptions — per spec/hooks.md §1
 * and the B2 defense-in-depth pin. The host MUST NOT block on a non-zero
 * exit per the spec, but we never give it one to mishandle.
 *
 * Idempotency: if a snapshot for the given session id is already in the
 * index, the run is a no-op (but still exits 0).
 */
export async function run(argv: string[]): Promise<void> {
  let repo: Repo | undefined;
  try {
    const args = parseHookArgs(argv);
    repo = Repo.open(args.cwd);

    // Idempotency check first — don't even capture state if we've fired
    // for this session before.
    const existing = repo.findSnapshotBySessionId(args.sessionId);
    if (existing !== null) {
      if (args.dryRun) {
        process.stdout.write(`harness-hook: idempotent: session ${args.sessionId} already snapshotted as ${existing.id}\n`);
      }
      return;
    }

    const headId = repo.resolveHead();
    const branch = repo.currentBranchName() ?? 'main';
    const modules = repo.workingTree();

    const blobNoId: Omit<Snapshot, 'id'> = {
      formatVersion: '0.1',
      parentIds: headId !== null ? [headId] : [],
      branch,
      kind: headId !== null ? 'auto' : 'init',
      message: `auto · session ${args.sessionId.slice(0, 8)}`,
      codePin: repo.gitSha(),
      apmLockHash: repo.apmLockHash(),
      createdAt: new Date().toISOString(),
      sessionId: args.sessionId,
      modules,
    };
    if (args.model !== undefined) blobNoId.model = args.model;
    if (args.permissionMode !== undefined) blobNoId.permissionMode = args.permissionMode;

    if (args.dryRun) {
      const dryId = snapshotId(blobNoId);
      process.stdout.write(JSON.stringify({ id: dryId, ...blobNoId }, null, 2) + '\n');
      return;
    }

    const written = repo.writeSnapshot(blobNoId);

    // Advance the branch ref if HEAD is symbolic; do not auto-advance
    // detached HEAD (per spec/hooks.md §3 / B2 prompt).
    if (repo.head()?.type === 'symbolic') {
      repo.setBranch(branch, written.id);
    } else {
      process.stderr.write(
        `harness-hook: detached HEAD; snapshot ${written.id.slice(0, 8)} written but no branch advanced\n`,
      );
    }
  } catch (err) {
    // Defense in depth: never give the host a non-zero exit.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`harness-hook: error: ${msg}\n`);
  } finally {
    repo?.close();
  }
  process.exit(0);
}
