import { describe, expect, test } from 'vitest';
import type { Snapshot as CoreSnapshot, Module as CoreModule } from '@harness/core';
import {
  ageLabelOf,
  diffOpFromCore,
  moduleFromCore,
  moduleTypeFromCore,
  snapshotFromCore,
} from '../src/data/adapters.js';

describe('moduleTypeFromCore', () => {
  test('chatmode maps to legacy persona', () => {
    expect(moduleTypeFromCore('chatmode')).toBe('persona');
  });
  test('prompt maps to legacy cmd', () => {
    expect(moduleTypeFromCore('prompt')).toBe('cmd');
  });
  test.each(['agent', 'instruction', 'mcp', 'skill', 'hook', 'style'] as const)(
    '%s passes through unchanged',
    (t) => { expect(moduleTypeFromCore(t)).toBe(t); },
  );
});

describe('moduleFromCore', () => {
  test('strips configHash + source, keeps name/type/version/enabled', () => {
    const core: CoreModule = {
      type: 'skill',
      name: 'research',
      version: 'v1.6',
      enabled: true,
      configHash: 'sha256:' + 'a'.repeat(64),
      source: { kind: 'local', path: '.claude/skills/research/SKILL.md' },
    };
    expect(moduleFromCore(core)).toEqual({
      type: 'skill',
      name: 'research',
      version: 'v1.6',
      enabled: true,
    });
  });
  test('omits version when absent (exactOptionalPropertyTypes-friendly)', () => {
    const core: CoreModule = {
      type: 'mcp', name: 'Read', enabled: true, source: { kind: 'builtin' },
    };
    const out = moduleFromCore(core);
    expect('version' in out).toBe(false);
  });
});

describe('snapshotFromCore', () => {
  const core: CoreSnapshot = {
    id: 'a3f9c1ef2244c3e85d10b0a6b7d52f0911aabbcc',
    parentIds: ['b22e80aa12cc34dd56ee78ff90aabbccddeeff00'],
    branch: 'main',
    kind: 'auto',
    message: 'auto · refactor',
    codePin: '9c12aa44b30115ee61b2c7a890fdc31002ee30bb',
    apmLockHash: null,
    createdAt: '2026-04-25T08:03:45.812Z',
    sessionId: 'sess-187',
    modules: [],
  };

  test('shortens id and codePin for the TUI display layer', () => {
    const tui = snapshotFromCore(core, new Date('2026-04-25T10:03:45.812Z'));
    expect(tui.id).toBe('a3f9c1ef');
    expect(tui.id.length).toBe(8);
    expect(tui.parentIds[0]).toBe('b22e80aa');
    expect(tui.codePin).toBe('9c12aa');
    expect(tui.ageLabel).toBe('2h');
  });

  test('null codePin renders as em-dash placeholder', () => {
    const tui = snapshotFromCore({ ...core, codePin: null });
    expect(tui.codePin).toBe('—');
  });

  test('omits sessionId when absent', () => {
    const noSess: CoreSnapshot = { ...core };
    delete (noSess as { sessionId?: string }).sessionId;
    const tui = snapshotFromCore(noSess);
    expect('sessionId' in tui).toBe(false);
  });
});

describe('ageLabelOf', () => {
  const T0 = new Date('2026-05-01T12:00:00.000Z');
  test.each<[string, string]>([
    ['2026-05-01T11:59:31.000Z', 'now'],   // 29s
    ['2026-05-01T11:59:00.000Z', '1m'],
    ['2026-05-01T11:00:00.000Z', '1h'],
    ['2026-05-01T07:00:00.000Z', '5h'],
    ['2026-04-30T12:00:00.000Z', '1d'],
    ['2026-04-27T12:00:00.000Z', '4d'],
    ['2026-04-23T12:00:00.000Z', '8d'],    // 8 days stays as days < 14 (matches git --relative-date)
    ['2026-04-16T12:00:00.000Z', '2w'],    // 15 days → 2w
    ['2026-04-01T12:00:00.000Z', '4w'],
    ['2026-02-15T12:00:00.000Z', '2mo'],
    ['2025-05-01T12:00:00.000Z', '1y'],
  ])('age %s → %s', (iso, expected) => {
    expect(ageLabelOf(iso, T0)).toBe(expected);
  });

  test('future timestamps clamp to "now" (no negative ages)', () => {
    expect(ageLabelOf('2026-05-01T13:00:00.000Z', T0)).toBe('now');
  });

  test('unparseable input returns "?"', () => {
    expect(ageLabelOf('not-a-date', T0)).toBe('?');
  });
});

describe('diffOpFromCore', () => {
  const before: CoreModule = {
    type: 'mcp', name: 'github', version: 'v1.4', enabled: true,
    source: { kind: 'local', path: '.claude/settings.json' },
  };
  const after: CoreModule = {
    type: 'mcp', name: 'github', version: 'v1.6', enabled: true,
    source: { kind: 'local', path: '.claude/settings.json' },
  };

  test('add → state="added", only right populated', () => {
    const row = diffOpFromCore({ kind: 'add', moduleType: 'mcp', name: 'postgres', after });
    expect(row.state).toBe('added');
    expect(row.left).toBeUndefined();
    expect(row.right).toEqual({ type: 'mcp', name: 'github', version: 'v1.6' });
  });

  test('remove → state="removed", only left populated', () => {
    const row = diffOpFromCore({ kind: 'remove', moduleType: 'mcp', name: 'github', before });
    expect(row.state).toBe('removed');
    expect(row.right).toBeUndefined();
    expect(row.left).toEqual({ type: 'mcp', name: 'github', version: 'v1.4' });
  });

  test('change → state="changed", both populated', () => {
    const row = diffOpFromCore({
      kind: 'change', moduleType: 'mcp', name: 'github', before, after,
    });
    expect(row.state).toBe('changed');
    expect(row.left?.version).toBe('v1.4');
    expect(row.right?.version).toBe('v1.6');
  });

  test('chatmode→persona alias survives diff', () => {
    const cmBefore: CoreModule = {
      type: 'chatmode', name: 'senior-eng', enabled: true,
      source: { kind: 'local', path: '.claude/agents/senior-eng.md' },
    };
    const row = diffOpFromCore({ kind: 'remove', moduleType: 'chatmode', name: 'senior-eng', before: cmBefore });
    expect(row.left?.type).toBe('persona');
  });
});
