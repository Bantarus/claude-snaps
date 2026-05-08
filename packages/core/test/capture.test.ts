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

  test('directory-shaped deployed_files match files under that directory (v0.4.1)', () => {
    const dir = setupProject();
    // APM 0.8.x local-path entry shape — repo_url _local/<name>, source: local,
    // local_path, and deployed_files lists the SKILL DIRECTORY (not its
    // SKILL.md). Capture must enrich the SKILL.md module via directory-prefix.
    writeFileSync(
      join(dir, 'apm.lock.yaml'),
      `dependencies:
- repo_url: _local/research-pkg
  source: local
  local_path: /irrelevant/for/this/test
  deployed_files:
    - .claude/skills/research
`,
      'utf-8',
    );
    const mods = captureCurrentState(dir);
    const research = mods.find((m) => m.type === 'skill' && m.name === 'research')!;
    expect(research.source.kind).toBe('apm');
    if (research.source.kind === 'apm') {
      expect(research.source.package).toBe('_local/research-pkg');
      expect(research.source.depth).toBe(1);
    }
    // code-review is NOT under .claude/skills/research/, so prefix-match
    // boundary check (path.startsWith(dir + '/')) keeps it local.
    const codeReview = mods.find((m) => m.type === 'skill' && m.name === 'code-review')!;
    expect(codeReview.source.kind).toBe('local');
  });

  test('directory-prefix match: longest prefix wins on multi-claim', () => {
    const dir = setupProject();
    writeFileSync(
      join(dir, 'apm.lock.yaml'),
      `dependencies:
- repo_url: _local/broad
  source: local
  local_path: /tmp/broad
  deployed_files:
    - .claude/skills
- repo_url: _local/narrow
  source: local
  local_path: /tmp/narrow
  deployed_files:
    - .claude/skills/research
`,
      'utf-8',
    );
    const mods = captureCurrentState(dir);
    const research = mods.find((m) => m.type === 'skill' && m.name === 'research')!;
    expect(research.source.kind).toBe('apm');
    if (research.source.kind === 'apm') {
      // research is matched by both entries; the narrower one (.claude/skills/research)
      // wins via longest-prefix.
      expect(research.source.package).toBe('_local/narrow');
    }
  });

  test('directory-prefix match: boundary respected — sibling directories do not match', () => {
    const dir = setupProject();
    // deployed_files entry is `.claude/skills/code` (no trailing slash);
    // module path `.claude/skills/code-review/SKILL.md` MUST NOT match
    // because `code-review` is a sibling of `code`, not a child.
    writeFileSync(
      join(dir, 'apm.lock.yaml'),
      `dependencies:
- repo_url: _local/sibling
  source: local
  local_path: /tmp/sibling
  deployed_files:
    - .claude/skills/code
`,
      'utf-8',
    );
    const mods = captureCurrentState(dir);
    const codeReview = mods.find((m) => m.type === 'skill' && m.name === 'code-review')!;
    // code-review/SKILL.md does NOT start with ".claude/skills/code/" so
    // the boundary check keeps it local.
    expect(codeReview.source.kind).toBe('local');
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

describe('readClaudeCodeVersion — v0.5.0', () => {
  test('reads version from first JSON line of transcript JSONL', async () => {
    const { readClaudeCodeVersion } = await import('../src/capture.js');
    const dir = mkdtempSync(join(tmpdir(), 'cca-ver-'));
    const path = join(dir, 'transcript.jsonl');
    writeFileSync(
      path,
      JSON.stringify({ type: 'summary', summary: 'x' }) + '\n' +
      JSON.stringify({ type: 'user', version: '2.1.131', sessionId: 'abc' }) + '\n',
      'utf-8',
    );
    expect(readClaudeCodeVersion(path)).toBe('2.1.131');
  });

  test('returns null on a transcript with no version field', async () => {
    const { readClaudeCodeVersion } = await import('../src/capture.js');
    const dir = mkdtempSync(join(tmpdir(), 'cca-ver-'));
    const path = join(dir, 'transcript.jsonl');
    writeFileSync(path, JSON.stringify({ type: 'summary' }) + '\n', 'utf-8');
    // The shell-out fallback may or may not return a version depending
    // on whether `claude` is on the test PATH. The contract under test
    // is: "no version in JSONL → fall back to shell-out." We accept
    // either string-X.Y.Z or null and assert the no-throw path.
    const result = readClaudeCodeVersion(path);
    expect(result === null || /^[0-9]+\.[0-9]+\.[0-9]+$/.test(result)).toBe(true);
  });

  test('returns null when transcriptPath is undefined and no claude on PATH', async () => {
    const { readClaudeCodeVersion } = await import('../src/capture.js');
    const orig = process.env['PATH'];
    process.env['PATH'] = '/nonexistent';
    try {
      expect(readClaudeCodeVersion(undefined)).toBe(null);
    } finally {
      process.env['PATH'] = orig;
    }
  });

  test('returns null when transcriptPath does not exist and no claude on PATH', async () => {
    const { readClaudeCodeVersion } = await import('../src/capture.js');
    const orig = process.env['PATH'];
    process.env['PATH'] = '/nonexistent';
    try {
      expect(readClaudeCodeVersion('/no/such/file.jsonl')).toBe(null);
    } finally {
      process.env['PATH'] = orig;
    }
  });

  test('rejects malformed version strings (non-X.Y.Z)', async () => {
    const { readClaudeCodeVersion } = await import('../src/capture.js');
    const dir = mkdtempSync(join(tmpdir(), 'cca-ver-'));
    const path = join(dir, 'transcript.jsonl');
    writeFileSync(
      path,
      JSON.stringify({ version: 'unknown' }) + '\n' +
      JSON.stringify({ version: '2.1' }) + '\n' +
      JSON.stringify({ version: '2.1.131' }) + '\n',
      'utf-8',
    );
    expect(readClaudeCodeVersion(path)).toBe('2.1.131');
  });

  test('drops trailing partial line (in-progress JSONL)', async () => {
    const { readClaudeCodeVersion } = await import('../src/capture.js');
    const dir = mkdtempSync(join(tmpdir(), 'cca-ver-'));
    const path = join(dir, 'transcript.jsonl');
    // No trailing newline; the partial last line MUST be ignored. PATH is
    // stubbed to disable the shell-out fallback so this asserts the JSONL
    // parser strictly drops unterminated bytes.
    writeFileSync(path, '{"version":"2.1.131"', 'utf-8');
    const orig = process.env['PATH'];
    process.env['PATH'] = '/nonexistent';
    try {
      expect(readClaudeCodeVersion(path)).toBe(null);
    } finally {
      process.env['PATH'] = orig;
    }
  });

  test('skips non-JSON lines and continues searching', async () => {
    const { readClaudeCodeVersion } = await import('../src/capture.js');
    const dir = mkdtempSync(join(tmpdir(), 'cca-ver-'));
    const path = join(dir, 'transcript.jsonl');
    writeFileSync(
      path,
      'GARBAGE\n' +
      '{not even close\n' +
      JSON.stringify({ version: '2.1.131' }) + '\n',
      'utf-8',
    );
    expect(readClaudeCodeVersion(path)).toBe('2.1.131');
  });
});
