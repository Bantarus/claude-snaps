import { Repo } from '@harness/core';
import { c } from '../format.js';
import type { ParsedArgs } from '../main.js';

/**
 * `harness snap [-m <message>] [--message <message>]`
 *
 * Manual capture. Wraps `repo.observe({ eventKind: 'manual_snap',
 * sessionId: '<manual>', message })`. Per spec/format.md §2.7:
 *
 * - With `-m`: a new snapshot is always written (the message
 *   participates in canonical bytes per §3.1, so the new id won't
 *   match any existing snapshot's id even if modules are unchanged).
 * - Without `-m`: composition-change detection runs in observe(); on
 *   unchanged composition only an attribution row is appended.
 *
 * The literal sessionId `<manual>` distinguishes manual snaps from
 * runtime sessions in attribution queries.
 */
export async function cmdSnap(parsed: ParsedArgs): Promise<number> {
  const message =
    typeof parsed.flags['m'] === 'string' ? parsed.flags['m'] :
    typeof parsed.flags['message'] === 'string' ? parsed.flags['message'] :
    null;

  const repo = Repo.open(process.cwd());
  try {
    const before = repo.resolveHead();
    const id = repo.observe({
      sessionId: '<manual>',
      eventKind: 'manual_snap',
      ...(message !== null ? { message } : {}),
    });
    const isNew = before !== id;
    if (isNew) {
      const note = message !== null ? ` "${message}"` : '';
      process.stdout.write(`Captured ${c.dim(id.slice(0, 8))}${note}\n`);
    } else {
      process.stdout.write(
        `No composition change since ${c.dim(id.slice(0, 8))}; attribution recorded.\n`,
      );
    }
  } finally {
    repo.close();
  }
  return 0;
}
