import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Repo, InvalidStateError, snapshotId, canonicalize } from '@harness/core';
import { c } from '../format.js';
import { resolveRef } from '../resolve.js';
import type { ParsedArgs } from '../main.js';

/**
 * `harness checkout <ref>`. Moves HEAD to <ref>. If <ref> is a branch
 * name, HEAD becomes a symbolic ref. Otherwise HEAD is detached.
 *
 * Does NOT mutate `.claude/`. v0.4.x adds an explicit divergence
 * warning: the command compares the working-tree composition against
 * the checked-out snapshot's composition and prints a clear "drift
 * detected" line when they don't match, pointing at `harness reproduce`.
 * The day-7 dogfood footgun came from users assuming `harness checkout`
 * was a content-restoring command; the warning closes that read.
 */
export async function cmdCheckout(parsed: ParsedArgs): Promise<number> {
  const [ref] = parsed.positional;
  if (ref === undefined) {
    throw new InvalidStateError("usage: harness checkout <ref>");
  }
  const repo = Repo.open(process.cwd());
  try {
    const branches = repo.branches();
    const headPath = join(repo.harnessDir, 'HEAD');
    let id: string;
    if (Object.prototype.hasOwnProperty.call(branches, ref)) {
      writeFileSync(headPath, `ref: refs/heads/${ref}\n`, 'utf-8');
      id = branches[ref]!;
    } else {
      id = resolveRef(repo, ref);
      writeFileSync(headPath, `${id}\n`, 'utf-8');
    }
    process.stdout.write(`HEAD now at ${id.slice(0, 8)}. Working tree unchanged.\n`);

    // Compare working-tree composition to the checked-out snapshot.
    // Same-id ⇒ no drift; different-id ⇒ user's `.claude/` is something
    // other than what they just checked out. The compare is by
    // recomputed snapshot id (the canonical identity) rather than per-
    // module diff — cheaper, sufficient signal for "do the user a
    // pointer to reproduce."
    const target = repo.snapshot(id);
    const liveModules = repo.workingTree();
    const liveLockHash = repo.apmLockHash();
    const liveLockfile = repo.apmLockfileContent();
    const liveId = snapshotId({
      formatVersion: target.formatVersion ?? '0.5',
      parentIds: target.parentIds,
      branch: target.branch,
      kind: target.kind,
      codePin: target.codePin,
      apmLockHash: liveLockHash,
      apmLockfile: liveLockfile,
      createdAt: target.createdAt,
      modules: canonicalize(liveModules) as typeof liveModules,
    });
    void canonicalize; // referenced for type compatibility in callers
    if (liveId !== id) {
      process.stdout.write(
        `${c.chg('!')} Working tree DIVERGED from ${id.slice(0, 8)}: ` +
        `your .claude/ composition does not match this snapshot.\n` +
        `   Run ${c.bold(`harness reproduce ${ref}`)} to materialize the ` +
        `snapshot's composition (backed up first).\n`,
      );
    } else {
      process.stdout.write(
        `${c.dim(`Working tree matches ${id.slice(0, 8)}; no reproduce needed.`)}\n`,
      );
    }
  } finally {
    repo.close();
  }
  return 0;
}
