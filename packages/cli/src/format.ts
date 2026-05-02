import type { ModuleType, SnapshotKind } from '@harness/core';

// Tiny ANSI helpers. No chalk dep; the surface is small enough that the
// raw escape codes fit in one file. Honors NO_COLOR and isTTY per
// standard ANSI etiquette.

const RESET = '\x1b[0m';
const SGR = {
  reset: 0,
  bold: 1,
  dim: 2,
  inverse: 7,
  fg: { red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36 },
} as const;

const COLOR_ENABLED = (() => {
  if (process.env['NO_COLOR']) return false;
  if (process.env['FORCE_COLOR']) return true;
  return process.stdout.isTTY === true;
})();

function wrap(s: string, ...codes: number[]): string {
  if (!COLOR_ENABLED) return s;
  return `\x1b[${codes.join(';')}m${s}${RESET}`;
}

export const c = {
  dim: (s: string): string => wrap(s, SGR.dim),
  bold: (s: string): string => wrap(s, SGR.bold),
  add: (s: string): string => wrap(s, SGR.fg.green),
  rm: (s: string): string => wrap(s, SGR.fg.red),
  chg: (s: string): string => wrap(s, SGR.fg.yellow),
  inverseYellow: (s: string): string => wrap(s, SGR.inverse, SGR.fg.yellow),
  type(kind: ModuleType, s: string): string {
    const code: number = (() => {
      switch (kind) {
        case 'chatmode':    return SGR.fg.green;
        case 'instruction': return SGR.fg.cyan;
        case 'agent':       return SGR.fg.green;
        case 'skill':       return SGR.fg.magenta;
        case 'prompt':      return SGR.fg.red;   // closest ANSI to /command orange
        case 'mcp':         return SGR.fg.blue;
        case 'hook':        return SGR.fg.yellow;
        case 'style':       return SGR.fg.magenta;
      }
    })();
    return wrap(s, code);
  },
  kind(k: SnapshotKind): string {
    switch (k) {
      case 'init':   return c.bold('★');
      case 'tag':    return c.chg('◆');
      case 'manual': return c.add('▶');
    }
  },
};

export const GLYPH: Record<ModuleType, string> = {
  chatmode: '◐', instruction: '✎', agent: '◐', skill: '✦',
  prompt: '/', mcp: '⌥', hook: '⚡', style: '◇',
};

/** Produce a unified-diff-style line listing for a JSON before/after. */
export function jsonDiff(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  // Naive line-level diff: longest common prefix + suffix, mark middle.
  // Sufficient for settings.json review; not a Myers algorithm.
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix++;
  const out: string[] = [];
  for (let i = 0; i < prefix; i++) out.push('  ' + a[i]);
  for (let i = prefix; i < a.length - suffix; i++) out.push(c.rm('- ' + a[i]));
  for (let i = prefix; i < b.length - suffix; i++) out.push(c.add('+ ' + b[i]));
  for (let i = a.length - suffix; i < a.length; i++) out.push('  ' + a[i]);
  return out.join('\n');
}
