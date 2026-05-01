import { Repo, EmptyRepositoryError } from '@harness/core';
import { c } from '../format.js';
import type { ParsedArgs } from '../main.js';

export async function cmdLog(parsed: ParsedArgs): Promise<number> {
  const repo = Repo.open(process.cwd());
  try {
    const head = repo.resolveHead();
    if (head === null && parsed.flags['branch'] === undefined) {
      throw new EmptyRepositoryError(
        "no commits yet; run 'harness-hook' or write a snapshot before 'harness log'",
      );
    }

    const filter: { branch?: string; limit?: number } = {
      limit: typeof parsed.flags['limit'] === 'string' ? Number(parsed.flags['limit']) : 50,
    };
    if (typeof parsed.flags['branch'] === 'string') filter.branch = parsed.flags['branch'];

    const snaps = repo.log(filter);
    for (const s of snaps) {
      const idShort = c.dim(s.id.slice(0, 8));
      const kindGlyph = c.kind(s.kind);
      const msg = s.message;
      const branch = c.dim(`(${s.branch})`);
      const version = s.version !== undefined ? ' ' + c.inverseYellow(` ${s.version} `) : '';
      const code = s.codePin !== null ? ' ' + c.dim(`code:${s.codePin.slice(0, 7)}`) : '';
      process.stdout.write(`${idShort} ${kindGlyph} ${msg}  ${branch}${version}${code}\n`);
    }
    if (snaps.length === 0) {
      process.stderr.write('(no snapshots match)\n');
    }
  } finally {
    repo.close();
  }
  return 0;
}
