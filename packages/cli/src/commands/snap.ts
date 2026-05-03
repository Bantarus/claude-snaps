import { Repo } from '@harness/core';
import { c } from '../format.js';
import type { ParsedArgs } from '../main.js';

/**
 * `harness snap "<note>"`
 *
 * Capture current composition (writing a new snapshot if novel) and
 * attach a `note` attribution event carrying the user's text. Per
 * spec/format.md §2.7, the note text is required — there is no
 * anonymous CLI capture path.
 *
 * Mechanics:
 *   - Routes through `Repo.note({ sessionId: '<manual>', noteText })`.
 *   - On unchanged composition: no new snapshot blob, no ref advance;
 *     only the `note` row is appended.
 *   - On changed composition: a new `auto`-kind snapshot is written
 *     and the branch ref advances, then the `note` row attaches to it.
 *
 * The literal `<manual>` session id distinguishes CLI-driven notes
 * from runtime sessions in `harness sessions` output. Cheap to change
 * later if it bothers anyone.
 */
export async function cmdSnap(parsed: ParsedArgs): Promise<number> {
  const noteText = parsed.positional[0];
  if (typeof noteText !== 'string' || noteText.length === 0) {
    process.stderr.write(
      `harness snap: a note is required. Usage:\n  harness snap "<note>"\n`,
    );
    return 1;
  }
  if (parsed.positional.length > 1) {
    process.stderr.write(
      `harness snap: extra arguments — quote the note as a single string: "${parsed.positional.join(' ')}"\n`,
    );
    return 1;
  }

  const repo = Repo.open(process.cwd());
  try {
    const before = repo.resolveHead();
    const id = repo.note({ sessionId: '<manual>', noteText });
    const isNew = before !== id;
    const short = c.dim(id.slice(0, 8));
    if (isNew) {
      process.stdout.write(`Captured ${short} with note: "${noteText}"\n`);
    } else {
      process.stdout.write(
        `No composition change since ${short}; note attached to existing snapshot.\n`,
      );
    }
  } finally {
    repo.close();
  }
  return 0;
}
