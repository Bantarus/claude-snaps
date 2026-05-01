import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const HARNESS_BIN = resolve(here, '../bin/harness');

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Spawn the CLI as a subprocess. We test the actual binary, not the
 * library, to catch shim+arg-parsing issues.
 */
export function runCli(
  args: string[],
  opts: { cwd: string; input?: string } = { cwd: process.cwd() },
): Promise<RunResult> {
  return new Promise((resolve_) => {
    const proc = spawn(HARNESS_BIN, args, {
      cwd: opts.cwd,
      env: { ...process.env, NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b) => { stdout += b.toString(); });
    proc.stderr.on('data', (b) => { stderr += b.toString(); });
    proc.on('close', (code) => resolve_({ stdout, stderr, code: code ?? -1 }));
    if (opts.input !== undefined) {
      proc.stdin.write(opts.input);
      proc.stdin.end();
    }
  });
}

export const HOOK_BIN = resolve(here, '../../hook/bin/harness-hook');

export function runHook(
  args: string[],
  opts: { cwd: string } = { cwd: process.cwd() },
): Promise<RunResult> {
  return new Promise((resolve_) => {
    const proc = spawn(HOOK_BIN, args, {
      cwd: opts.cwd,
      env: { ...process.env, NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b) => { stdout += b.toString(); });
    proc.stderr.on('data', (b) => { stderr += b.toString(); });
    proc.on('close', (code) => resolve_({ stdout, stderr, code: code ?? -1 }));
  });
}
