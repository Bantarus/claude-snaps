import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK_BIN = resolve(here, '../bin/harness-hook');
const HARNESS_BIN = resolve(here, '../../cli/bin/harness');

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

export function runHarness(args: string[], opts: { cwd: string }): Promise<RunResult> {
  return new Promise((res) => {
    const proc = spawn(HARNESS_BIN, args, {
      cwd: opts.cwd,
      env: { ...process.env, NO_COLOR: '1' },
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (b) => { stdout += b.toString(); });
    proc.stderr.on('data', (b) => { stderr += b.toString(); });
    proc.on('close', (code) => res({ stdout, stderr, code: code ?? -1 }));
  });
}

export async function freshHarnessRepo(): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), 'harness-hooktest-'));
  const r = await runHarness(['init'], { cwd });
  if (r.code !== 0) throw new Error(`init failed: ${r.stderr}`);
  return cwd;
}

export function writeMinimalClaude(cwd: string): void {
  mkdirSync(join(cwd, '.claude/skills/research'), { recursive: true });
  writeFileSync(join(cwd, '.claude/skills/research/SKILL.md'), '# research v0.1\n');
}
