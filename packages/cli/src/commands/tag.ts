import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Repo, IntegrityError, InvalidStateError } from '@harness/core';
import { resolveRef } from '../resolve.js';
import type { ParsedArgs } from '../main.js';

const NAME_RE = /^[A-Za-z0-9._/-]+$/;

export async function cmdTag(parsed: ParsedArgs): Promise<number> {
  const [name, idArg] = parsed.positional;
  if (name === undefined) throw new InvalidStateError("usage: harness tag <name> [<id>] [--force]");
  if (!NAME_RE.test(name) || name.includes('..') || name.endsWith('.lock')) {
    throw new IntegrityError(`invalid tag name: ${JSON.stringify(name)}`);
  }
  const force = parsed.flags['force'] === true;
  const repo = Repo.open(process.cwd());
  try {
    const tagPath = join(repo.harnessDir, 'refs', 'tags', name);
    if (existsSync(tagPath) && !force) {
      throw new IntegrityError(`tag '${name}' already exists; pass --force to overwrite`);
    }
    const id = idArg !== undefined ? resolveRef(repo, idArg) : resolveRef(repo, 'HEAD');
    repo.setTag(name, id);
    process.stdout.write(`Tagged ${id.slice(0, 8)} as ${name}\n`);
  } finally {
    repo.close();
  }
  return 0;
}
