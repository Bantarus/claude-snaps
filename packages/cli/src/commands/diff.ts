import { Repo, InvalidStateError } from '@harness/core';
import { c, GLYPH } from '../format.js';
import { resolveRef } from '../resolve.js';
import type { ParsedArgs } from '../main.js';

export async function cmdDiff(parsed: ParsedArgs): Promise<number> {
  const [a, b] = parsed.positional;
  if (a === undefined || b === undefined) {
    throw new InvalidStateError("usage: harness diff <a> <b>");
  }
  const repo = Repo.open(process.cwd());
  try {
    const idA = resolveRef(repo, a);
    const idB = resolveRef(repo, b);
    process.stdout.write(`${c.dim(idA.slice(0, 8))}..${c.dim(idB.slice(0, 8))}\n`);
    const ops = repo.diff(idA, idB);
    let added = 0, removed = 0, changed = 0;
    for (const op of ops) {
      const glyph = c.type(op.moduleType, GLYPH[op.moduleType]);
      if (op.kind === 'add') {
        added++;
        const v = op.after?.version !== undefined ? ' ' + op.after.version : '';
        process.stdout.write(`${c.add('+')} ${glyph} ${op.name}${v}            ${c.dim('(added)')}\n`);
      } else if (op.kind === 'remove') {
        removed++;
        const v = op.before?.version !== undefined ? ' ' + op.before.version : '';
        process.stdout.write(`${c.rm('−')} ${glyph} ${op.name}${v}            ${c.dim('(removed)')}\n`);
      } else {
        changed++;
        const vb = op.before?.version ?? '?';
        const va = op.after?.version ?? '?';
        process.stdout.write(`${c.chg('~')} ${glyph} ${op.name} ${vb} → ${va}  ${c.dim('(changed)')}\n`);
      }
    }
    process.stdout.write(
      `\n${c.add('+' + added)} added  ${c.rm('−' + removed)} removed  ${c.chg('~' + changed)} changed\n`,
    );
  } finally {
    repo.close();
  }
  return 0;
}
