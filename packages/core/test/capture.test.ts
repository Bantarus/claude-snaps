import { describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureCurrentState } from '../src/capture.js';

function setupProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-capture-'));
  mkdirSync(join(dir, '.claude/skills/research'), { recursive: true });
  mkdirSync(join(dir, '.claude/skills/code-review'), { recursive: true });
  mkdirSync(join(dir, '.claude/commands'), { recursive: true });
  mkdirSync(join(dir, '.claude/agents'), { recursive: true });
  mkdirSync(join(dir, '.claude/output-styles'), { recursive: true });

  writeFileSync(join(dir, '.claude/skills/research/SKILL.md'), '# Research\n', 'utf-8');
  writeFileSync(join(dir, '.claude/skills/code-review/SKILL.md'), '# Code review\n', 'utf-8');
  writeFileSync(join(dir, '.claude/commands/plan.md'), '# /plan\n', 'utf-8');
  writeFileSync(join(dir, '.claude/agents/senior-eng.md'), '# senior-eng\n', 'utf-8');
  writeFileSync(join(dir, '.claude/output-styles/terse.md'), '# terse\n', 'utf-8');
  writeFileSync(join(dir, 'CLAUDE.md'), '# Project rules\n', 'utf-8');
  writeFileSync(
    join(dir, '.claude/settings.json'),
    JSON.stringify({
      mcpServers: {
        github: { command: 'github-mcp', env: { TOKEN: 'x' } },
        postgres: { command: 'pg-mcp' },
      },
      hooks: {
        SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo' }] }],
      },
    }, null, 2),
    'utf-8',
  );
  return dir;
}

describe('captureCurrentState — local-only project', () => {
  test('discovers all primitive types', () => {
    const dir = setupProject();
    const mods = captureCurrentState(dir);

    const byType = (t: string) => mods.filter((m) => m.type === t);
    expect(byType('skill').map((m) => m.name).sort()).toEqual(['code-review', 'research']);
    expect(byType('prompt').map((m) => m.name)).toEqual(['/plan']);
    expect(byType('agent').map((m) => m.name)).toEqual(['senior-eng']);
    expect(byType('style').map((m) => m.name)).toEqual(['terse']);
    expect(byType('instruction').map((m) => m.name)).toEqual(['CLAUDE.md']);

    const mcps = byType('mcp');
    expect(mcps.some((m) => m.name === 'github' && m.source.kind === 'local')).toBe(true);
    expect(mcps.some((m) => m.name === 'Read' && m.source.kind === 'builtin')).toBe(true);

    const hooks = byType('hook');
    expect(hooks.length).toBeGreaterThan(0);
    expect(hooks.every((h) => h.source.kind === 'local')).toBe(true);
  });

  test('module ordering matches spec/hooks.md §2.2 (canonical type order, then name)', () => {
    const dir = setupProject();
    const mods = captureCurrentState(dir);
    const ORDER = ['chatmode', 'instruction', 'agent', 'skill', 'prompt', 'mcp', 'hook', 'style'];
    let lastTypeIdx = -1;
    let lastName = '';
    for (const m of mods) {
      const idx = ORDER.indexOf(m.type);
      if (idx > lastTypeIdx) {
        lastTypeIdx = idx;
        lastName = '';
      }
      expect(idx).toBeGreaterThanOrEqual(lastTypeIdx);
      if (idx === lastTypeIdx) {
        expect(m.name >= lastName).toBe(true);
        lastName = m.name;
      }
    }
  });

  test('configHash is stable across runs', () => {
    const dir = setupProject();
    const a = captureCurrentState(dir);
    const b = captureCurrentState(dir);
    expect(a).toEqual(b);
  });
});

describe('captureCurrentState — APM enrichment', () => {
  test('matches deployed_files from apm.lock.yaml and rewrites local→apm', () => {
    const dir = setupProject();
    // Add a lockfile that claims research/SKILL.md is APM-deployed.
    writeFileSync(
      join(dir, 'apm.lock.yaml'),
      `packages:
  - package: example/research-pkg
    repo_url: https://github.com/example/research-pkg
    resolved_commit: ${'a'.repeat(40)}
    depth: 1
    deployed_files:
      - .claude/skills/research/SKILL.md
`,
      'utf-8',
    );
    const mods = captureCurrentState(dir);
    const research = mods.find((m) => m.type === 'skill' && m.name === 'research')!;
    const codeReview = mods.find((m) => m.type === 'skill' && m.name === 'code-review')!;
    expect(research.source.kind).toBe('apm');
    if (research.source.kind === 'apm') {
      expect(research.source.package).toBe('example/research-pkg');
      expect(research.source.depth).toBe(1);
    }
    // Not in deployed_files — stays local.
    expect(codeReview.source.kind).toBe('local');
  });

  test('multi-package conflict: prefer lower depth', () => {
    const dir = setupProject();
    writeFileSync(
      join(dir, 'apm.lock.yaml'),
      `packages:
  - package: a/transitive
    repo_url: https://github.com/a/transitive
    resolved_commit: ${'b'.repeat(40)}
    depth: 2
    resolved_by: a/direct
    deployed_files:
      - .claude/skills/research/SKILL.md
  - package: a/direct
    repo_url: https://github.com/a/direct
    resolved_commit: ${'c'.repeat(40)}
    depth: 1
    deployed_files:
      - .claude/skills/research/SKILL.md
`,
      'utf-8',
    );
    const mods = captureCurrentState(dir);
    const research = mods.find((m) => m.type === 'skill' && m.name === 'research')!;
    expect(research.source.kind).toBe('apm');
    if (research.source.kind === 'apm') {
      expect(research.source.package).toBe('a/direct');
      expect(research.source.depth).toBe(1);
    }
  });

  test('builtin tools never get APM-enriched even if a lockfile is present', () => {
    const dir = setupProject();
    writeFileSync(
      join(dir, 'apm.lock.yaml'),
      `packages: []`,
      'utf-8',
    );
    const mods = captureCurrentState(dir);
    const read = mods.find((m) => m.name === 'Read' && m.type === 'mcp')!;
    expect(read.source.kind).toBe('builtin');
  });
});

describe('captureCurrentState — minimal project (just builtins)', () => {
  test('returns only builtin modules when .claude/ is empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-capture-min-'));
    const mods = captureCurrentState(dir);
    expect(mods.every((m) => m.source.kind === 'builtin')).toBe(true);
    expect(mods.length).toBeGreaterThan(0);
  });
});
