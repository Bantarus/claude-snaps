import { Repo, EmptyRepositoryError } from '@harness/core';
import { c } from '../format.js';
import type { ParsedArgs } from '../main.js';

export async function cmdLog(parsed: ParsedArgs): Promise<number> {
  const repo = Repo.open(process.cwd());
  try {
    const head = repo.resolveHead();
    if (head === null && parsed.flags['branch'] === undefined) {
      throw new EmptyRepositoryError(
        "no commits yet; run 'harness-hook' or 'harness snap' before 'harness log'",
      );
    }

    const filter: { branch?: string; limit?: number } = {
      limit: typeof parsed.flags['limit'] === 'string' ? Number(parsed.flags['limit']) : 50,
    };
    if (typeof parsed.flags['branch'] === 'string') filter.branch = parsed.flags['branch'];

    const withSessions = parsed.flags['with-sessions'] === true;

    const snaps = repo.log(filter);
    for (const s of snaps) {
      const idShort = c.dim(s.id.slice(0, 8));
      const kindGlyph = c.kind(s.kind);
      // v0.2: message is nullable. Hook-driven snapshots have no message;
      // show "(no message)" dimmed so the row stays visually consistent.
      const msg = s.message ?? c.dim('(no message)');
      const branch = c.dim(`(${s.branch})`);
      const version = s.version !== undefined && s.version !== null
        ? ' ' + c.inverseYellow(` ${s.version} `)
        : '';
      const code = s.codePin !== null ? ' ' + c.dim(`code:${s.codePin.slice(0, 7)}`) : '';
      let line = `${idShort} ${kindGlyph} ${msg}  ${branch}${version}${code}`;
      if (withSessions) {
        const sessions = repo.sessionsAt(s.id);
        const count = sessions.length;
        line += ' ' + c.dim(`[${count} session${count === 1 ? '' : 's'}]`);
      }
      process.stdout.write(line + '\n');
    }
    if (snaps.length === 0) {
      process.stderr.write('(no snapshots match)\n');
    }
  } finally {
    repo.close();
  }
  return 0;
}
