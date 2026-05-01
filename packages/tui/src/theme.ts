// Ink supports truecolor hex strings via chalk under the hood.
// These names mirror the wireframe palette so module-type associations
// stay consistent across screens.

export const T = {
  // Surfaces
  fg: '#e8e6df',
  dim: '#8a8780',
  faint: '#5a5853',
  line: '#3a3a3f',

  // Module-type accents (single source of truth)
  cmd: '#ff8b5a', // / commands       — orange
  mcp: '#5fb3f0', // tools            — blue
  hook: '#f5c542', // hooks           — yellow
  persona: '#7fc97f', // personas     — green
  skill: '#c569d6', // skills         — purple
  style: '#e85a8a', // output styles  — pink

  // Diff states
  add: '#7fc97f',
  rm: '#e85a8a',
  chg: '#f5c542',

  // Selection
  sel: '#f5c542',
  selFg: '#0e0f12',
} as const;

// Shared single-glyph for each module type
export const GLYPHS: Record<string, string> = {
  persona: '◐',
  mcp: '⌥',
  skill: '✦',
  hook: '⚡',
  cmd: '/',
  style: '◇',
};

export const glyphColor = (t: string): string => {
  switch (t) {
    case 'persona':
      return T.persona;
    case 'mcp':
      return T.mcp;
    case 'skill':
      return T.skill;
    case 'hook':
      return T.hook;
    case 'cmd':
      return T.cmd;
    case 'style':
      return T.style;
    default:
      return T.fg;
  }
};
