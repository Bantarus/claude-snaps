import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Repo, InvalidStateError } from '@harness/core';
import { resolveRef } from '../resolve.js';
import type { ParsedArgs } from '../main.js';

/**
 * `harness checkout <ref>`. Moves HEAD to <ref>. If <ref> is a branch
 * name, HEAD becomes a symbolic ref. Otherwise HEAD is detached.
 *
 * Does NOT mutate `.claude/`. Working-tree application of the checked-out
 * snapshot is the reproducer's job (prompt D).
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
      // Symbolic checkout
      writeFileSync(headPath, `ref: refs/heads/${ref}\n`, 'utf-8');
      id = branches[ref]!;
    } else {
      // Detached checkout
      id = resolveRef(repo, ref);
      writeFileSync(headPath, `${id}\n`, 'utf-8');
    }
    process.stdout.write(
      `HEAD now at ${id.slice(0, 8)}. Working tree unchanged. ` +
      `Use 'harness reproduce ${ref}' to materialize this snapshot's ` +
      `harness composition into .claude/.\n`,
    );
  } finally {
    repo.close();
  }
  return 0;
}
