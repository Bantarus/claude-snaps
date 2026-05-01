import { createInterface } from 'node:readline/promises';

/**
 * Block on stdin for a [y/N] confirmation. Default is no — only `y` or
 * `yes` (case-insensitive) returns true. Used by install-hook before
 * mutating .claude/settings.json.
 */
export async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}
