import { Repo, EmptyRepositoryError, summarizeDiff } from '@harness/core';
import { c } from '../format.js';
import type { ParsedArgs } from '../main.js';

/**
 * `harness log [--branch=<name>] [--limit=N] [--with-sessions]`
 *
 * Lists snapshots, newest first. The per-row hint is computed at read
 * time from `summarizeDiff(parent_modules, current_modules)` — there
 * is no `message` field on snapshots in v0.3 (spec/format.md §2.1,
 * §2.7). Improvements to the summary are non-breaking because nothing
 * stores its output.
 *
 * `--with-sessions` appends `[N sessions]` per row, the count of
 * distinct sessions that ever observed that snapshot.
 */
export async function cmdLog(parsed: ParsedArgs): Promise<number> {
  const repo = Repo.open(process.cwd());
  try {
    const head = repo.resolveHead();
    if (head === null && parsed.flags['branch'] === undefined) {
      throw new EmptyRepositoryError(
        "no commits yet; run 'harness-hook' or 'harness snap \"<note>\"' before 'harness log'",
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
      const branch = c.dim(`(${s.branch})`);
      const version = s.version !== undefined && s.version !== null
        ? ' ' + c.inverseYellow(` ${s.version} `)
        : '';
      const code = s.codePin !== null ? ' ' + c.dim(`code:${s.codePin.slice(0, 7)}`) : '';

      // Compute the per-row diff summary at read time. For root
      // snapshots (kind=init), summarizeDiff renders "init"; otherwise
      // we compare against parentIds[0] (the dominant parent — for
      // merges, this loses the second-parent delta, which is fine for
      // a one-line summary).
      const parentBlob = s.parentIds.length > 0 ? repo.snapshot(s.parentIds[0]!) : null;
      const summary = summarizeDiff(parentBlob === null ? null : parentBlob.modules, s.modules);

      let line = `${idShort} ${kindGlyph} ${summary}  ${branch}${version}${code}`;
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
