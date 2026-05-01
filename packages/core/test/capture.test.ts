import { afterEach, describe, expect, test, vi } from 'vitest';
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

describe('captureCurrentState — scope: "user" (spec/format.md §1.1)', () => {
  // os.homedir() consults HOME on Linux and USERPROFILE on Windows. We
  // stub both so the user-scope walk lands on a fake home directory we
  // control, avoiding any contact with the real ~/.claude/.
  function stubHome(home: string): void {
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function setupUserHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'harness-fake-home-'));
    mkdirSync(join(home, '.claude/skills/research'), { recursive: true });
    mkdirSync(join(home, '.claude/skills/code-review'), { recursive: true });
    writeFileSync(join(home, '.claude/skills/research/SKILL.md'), '# user research\n', 'utf-8');
    writeFileSync(join(home, '.claude/skills/code-review/SKILL.md'), '# user code-review\n', 'utf-8');
    writeFileSync(
      join(home, '.claude/settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo user-hook' }] }],
        },
      }, null, 2),
      'utf-8',
    );
    return home;
  }

  test('default scope (omitted) walks project only — user-level invisible', () => {
    const home = setupUserHome();
    stubHome(home);
    const dir = mkdtempSync(join(tmpdir(), 'harness-default-scope-'));
    // Empty project — only builtins should land.
    const mods = captureCurrentState(dir);
    expect(mods.every((m) => m.source.kind === 'builtin')).toBe(true);
  });

  test('scope="user" walks $HOME/.claude/ and emits kind="user" for those modules', () => {
    const home = setupUserHome();
    stubHome(home);
    const dir = setupProject(); // project from the helper at top of file
    const mods = captureCurrentState(dir, { scope: 'user' });

    const userModules = mods.filter((m) => m.source.kind === 'user');
    const userSkillNames = userModules
      .filter((m) => m.type === 'skill')
      .map((m) => m.name)
      .sort();
    expect(userSkillNames).toEqual(['code-review', 'research']);

    // The user-level hook is captured too (settings.json under $HOME).
    expect(userModules.some((m) => m.type === 'hook')).toBe(true);

    // Project-level modules still emit `local` (not user) — disambiguated.
    const projectSkill = mods.find((m) => m.type === 'skill' && m.source.kind === 'local');
    expect(projectSkill).toBeDefined();
  });

  test('user-kind paths are $HOME-relative POSIX (not absolute, no leading slash)', () => {
    const home = setupUserHome();
    stubHome(home);
    const dir = mkdtempSync(join(tmpdir(), 'harness-user-paths-'));
    const mods = captureCurrentState(dir, { scope: 'user' });
    for (const m of mods) {
      if (m.source.kind === 'user') {
        expect(m.source.path.startsWith('/')).toBe(false);
        expect(m.source.path.includes('\\')).toBe(false);
        // Should be under .claude/ since that's what we walked.
        expect(m.source.path.startsWith('.claude/')).toBe(true);
      }
    }
  });

  test('scope="user" when projectRoot === $HOME does NOT double-walk', () => {
    const home = setupUserHome();
    stubHome(home);
    // Edge case: a developer scaffolds harness in their home directory.
    // The user-scope walk should be skipped (projectRoot === home), so
    // every captured module appears once with kind="local", not duplicated
    // as kind="user".
    const mods = captureCurrentState(home, { scope: 'user' });
    expect(mods.some((m) => m.source.kind === 'user')).toBe(false);
    expect(mods.some((m) => m.source.kind === 'local')).toBe(true);
  });

  test('configHash is stable across user-scope captures', () => {
    const home = setupUserHome();
    stubHome(home);
    const dir = setupProject();
    const a = captureCurrentState(dir, { scope: 'user' });
    const b = captureCurrentState(dir, { scope: 'user' });
    expect(a).toEqual(b);
  });
});
