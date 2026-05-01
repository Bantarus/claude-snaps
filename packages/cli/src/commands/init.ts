import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Repo, IoError } from '@harness/core';
import type { ParsedArgs } from '../main.js';

export async function cmdInit(parsed: ParsedArgs): Promise<number> {
  const cwd = process.cwd();
  if (existsSync(join(cwd, '.harness'))) {
    throw new IoError(
      `.harness/ already exists at ${cwd}; use 'harness reindex' to rebuild the lineage index`,
    );
  }
  const branchFlag = parsed.flags['branch'];
  const initOpts: { defaultBranch?: string } = {};
  if (typeof branchFlag === 'string') initOpts.defaultBranch = branchFlag;
  const repo = Repo.init(cwd, initOpts);
  try {
    process.stdout.write(`Initialized empty harness repository in ${join(cwd, '.harness')}/\n`);
  } finally {
    repo.close();
  }
  return 0;
}
