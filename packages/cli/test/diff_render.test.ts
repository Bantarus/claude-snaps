import { describe, expect, test } from 'vitest';
import type { Module } from '@harness/core';
import { renderChangedAttrs } from '../src/commands/diff_render.js';

// Base module the cases below mutate. Constructed directly — no Repo,
// no fixtures, no I/O — so the helper's behavior is observed in
// isolation.
function base(overrides: Partial<Module> = {}): Module {
  return {
    type: 'skill',
    name: 'research',
    enabled: true,
    configHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    source: { kind: 'local', path: '.claude/skills/research/SKILL.md' },
    ...overrides,
  };
}

describe('renderChangedAttrs', () => {
  test('configHash-only drift names the attribute', () => {
    const before = base({ configHash: 'sha256:' + 'a'.repeat(64) });
    const after = base({ configHash: 'sha256:' + 'b'.repeat(64) });
    expect(renderChangedAttrs(before, after)).toBe('(configHash)');
  });

  test('version drift on both sides keeps the arrow form', () => {
    const before = base({ version: 'v0.4' });
    const after = base({ version: 'v0.5' });
    expect(renderChangedAttrs(before, after)).toBe('v0.4 → v0.5');
  });

  test('version added (was undefined) renders none → vX', () => {
    const before = base();
    const after = base({ version: 'v0.5' });
    expect(renderChangedAttrs(before, after)).toBe('none → v0.5');
  });

  test('version removed (now undefined) renders vX → none', () => {
    const before = base({ version: 'v0.4' });
    const after = base();
    expect(renderChangedAttrs(before, after)).toBe('v0.4 → none');
  });

  test('enabled flipped to false renders (disabled)', () => {
    const before = base({ enabled: true });
    const after = base({ enabled: false });
    expect(renderChangedAttrs(before, after)).toBe('(disabled)');
  });

  test('enabled flipped to true renders (enabled)', () => {
    const before = base({ enabled: false });
    const after = base({ enabled: true });
    expect(renderChangedAttrs(before, after)).toBe('(enabled)');
  });

  test('source kind change (local → apm) renders (source)', () => {
    const before = base({ source: { kind: 'local', path: '.claude/skills/research/SKILL.md' } });
    const after = base({
      source: {
        kind: 'apm',
        package: 'team/research',
        resolvedCommit: 'a'.repeat(40),
        depth: 0,
      },
    });
    expect(renderChangedAttrs(before, after)).toBe('(source)');
  });

  test('apm.resolvedCommit drift inside same kind renders (source)', () => {
    const before = base({
      source: {
        kind: 'apm',
        package: 'team/research',
        resolvedCommit: 'a'.repeat(40),
        depth: 0,
      },
    });
    const after = base({
      source: {
        kind: 'apm',
        package: 'team/research',
        resolvedCommit: 'b'.repeat(40),
        depth: 0,
      },
    });
    expect(renderChangedAttrs(before, after)).toBe('(source)');
  });

  test('multi-attribute change combines arrow + parenthesized list', () => {
    const before = base({
      version: 'v0.4',
      configHash: 'sha256:' + 'a'.repeat(64),
      source: { kind: 'local', path: '.claude/skills/research/SKILL.md' },
    });
    const after = base({
      version: 'v0.5',
      configHash: 'sha256:' + 'b'.repeat(64),
      source: {
        kind: 'apm',
        package: 'team/research',
        resolvedCommit: 'c'.repeat(40),
        depth: 0,
      },
    });
    expect(renderChangedAttrs(before, after)).toBe('v0.4 → v0.5  (configHash, source)');
  });

  test('all attrs drift simultaneously: state → configHash → source order', () => {
    const before = base({
      enabled: true,
      version: 'v0.4',
      configHash: 'sha256:' + 'a'.repeat(64),
      source: { kind: 'local', path: '.claude/skills/research/SKILL.md' },
    });
    const after = base({
      enabled: false,
      version: 'v0.5',
      configHash: 'sha256:' + 'b'.repeat(64),
      source: { kind: 'builtin' },
    });
    expect(renderChangedAttrs(before, after)).toBe(
      'v0.4 → v0.5  (disabled, configHash, source)',
    );
  });

  test('regression guard: ? literally never appears in any output', () => {
    const cases: Array<[Module, Module]> = [
      [base({ configHash: 'sha256:' + 'a'.repeat(64) }), base({ configHash: 'sha256:' + 'b'.repeat(64) })],
      [base({ version: 'v0.4' }), base({ version: 'v0.5' })],
      [base(), base({ version: 'v0.5' })],
      [base({ version: 'v0.4' }), base()],
      [base({ enabled: true }), base({ enabled: false })],
      [base({ enabled: false }), base({ enabled: true })],
      [
        base({ source: { kind: 'local', path: 'a' } }),
        base({ source: { kind: 'builtin' } }),
      ],
      [
        base({ version: 'v0.4', enabled: true, configHash: 'sha256:' + 'a'.repeat(64) }),
        base({ version: 'v0.5', enabled: false, configHash: 'sha256:' + 'b'.repeat(64) }),
      ],
    ];
    for (const [before, after] of cases) {
      expect(renderChangedAttrs(before, after)).not.toContain('?');
    }
  });
});
