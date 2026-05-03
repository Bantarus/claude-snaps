import { Repo } from '@harness/core';
import { c } from '../format.js';
import { resolveRef } from '../resolve.js';
import type { ParsedArgs } from '../main.js';

/**
 * `harness notes <snapshot-ref>`
 *
 * List every `note` attribution event ever attached to a snapshot,
 * across sessions. The cross-session-notes query (Q2) from
 * spec/format.md §2.7 / §5.4. Cheap query — backed by
 * `idx_attributions_snapshot`.
 */
export async function cmdNotes(parsed: ParsedArgs): Promise<number> {
  const ref = parsed.positional[0];
  if (typeof ref !== 'string' || ref.length === 0) {
    process.stderr.write(
      `harness notes: a snapshot ref is required. Usage:\n  harness notes <ref>\n`,
    );
    return 1;
  }

  const repo = Repo.open(process.cwd());
  try {
    const id = resolveRef(repo, ref);
    const notes = repo.notesOf(id);
    if (notes.length === 0) {
      process.stderr.write(`(no notes on ${c.dim(id.slice(0, 8))})\n`);
      return 0;
    }
    process.stdout.write(`Notes on ${c.dim(id.slice(0, 8))}...:\n`);
    const distinctSessions = new Set(notes.map((n) => n.sessionId));
    for (const n of notes) {
      const text = n.noteText ?? '';
      process.stdout.write(
        `  ${c.dim(n.observedAt)}  ${n.sessionId}  "${text}"\n`,
      );
    }
    const noteWord = notes.length === 1 ? 'note' : 'notes';
    const sessWord = distinctSessions.size === 1 ? 'session' : 'sessions';
    process.stdout.write(
      `\n${notes.length} ${noteWord} from ${distinctSessions.size} ${sessWord}.\n`,
    );
  } finally {
    repo.close();
  }
  return 0;
}
