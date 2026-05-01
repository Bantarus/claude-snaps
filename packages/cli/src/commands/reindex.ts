import { Repo } from '@harness/core';
import type { ParsedArgs } from '../main.js';

export async function cmdReindex(_parsed: ParsedArgs): Promise<number> {
  const repo = Repo.open(process.cwd());
  try {
    const r = repo.reindex();
    process.stdout.write(
      `Reindexed: +${r.added} snapshots, ~${r.updated}, −${r.removed}.\n`,
    );
  } finally {
    repo.close();
  }
  return 0;
}
