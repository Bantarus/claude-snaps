import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Repo } from '@harness/core';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK_BIN = resolve(here, '../bin/harness-hook');

export interface RunResult { stdout: string; stderr: string; code: number; }

export function runHook(
  args: string[],
  opts: { cwd: string; stdin?: string; env?: Record<string, string> } = { cwd: process.cwd() },
): Promise<RunResult> {
  return new Promise((res) => {
    const proc = spawn(HOOK_BIN, args, {
      cwd: opts.cwd,
      env: { ...process.env, NO_COLOR: '1', ...(opts.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (b) => { stdout += b.toString(); });
    proc.stderr.on('data', (b) => { stderr += b.toString(); });
    proc.on('close', (code) => res({ stdout, stderr, code: code ?? -1 }));
    if (opts.stdin !== undefined) {
      proc.stdin.write(opts.stdin);
    }
    proc.stdin.end();
  });
}

/**
 * Initialize a fresh `.harness/` via the @harness/core API directly,
 * not via the `harness init` CLI. This decouples hook tests from the
 * CLI's own rewrite cadence (step 6); the hook is verified in
 * isolation here.
 */
export async function freshHarnessRepo(): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), 'harness-hooktest-'));
  const repo = Repo.init(cwd);
  repo.close();
  return cwd;
}

export function writeMinimalClaude(cwd: string): void {
  mkdirSync(join(cwd, '.claude/skills/research'), { recursive: true });
  writeFileSync(join(cwd, '.claude/skills/research/SKILL.md'), '# research v0.1\n');
}

/** Open a Repo for read-only inspection in tests. */
export function openRepo(cwd: string): Repo {
  return Repo.open(cwd);
}
