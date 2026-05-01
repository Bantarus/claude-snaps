import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Repo, IntegrityError, InvalidStateError } from '@harness/core';
import { resolveRef } from '../resolve.js';
import type { ParsedArgs } from '../main.js';

const NAME_RE = /^[A-Za-z0-9._/-]+$/;

export async function cmdBranch(parsed: ParsedArgs): Promise<number> {
  const [name, idArg] = parsed.positional;
  if (name === undefined) {
    throw new InvalidStateError("usage: harness branch <name> [<id>] [--force]");
  }
  if (!NAME_RE.test(name) || name.includes('..') || name.endsWith('.lock')) {
    throw new IntegrityError(`invalid branch name: ${JSON.stringify(name)}`);
  }
  const force = parsed.flags['force'] === true;
  const repo = Repo.open(process.cwd());
  try {
    const refPath = join(repo.harnessDir, 'refs', 'heads', name);
    if (existsSync(refPath) && !force) {
      throw new IntegrityError(`branch '${name}' already exists; pass --force to overwrite`);
    }
    const id = idArg !== undefined ? resolveRef(repo, idArg) : resolveRef(repo, 'HEAD');
    repo.setBranch(name, id);
    process.stdout.write(`Created branch ${name} at ${id.slice(0, 8)}\n`);
  } finally {
    repo.close();
  }
  return 0;
}
