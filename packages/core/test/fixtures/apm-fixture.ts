import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Set up a local APM source repository as a real git tree on disk.
 * Returns the absolute path to the repo. The repo contains one APM
 * skill at `.apm/skills/<skillName>/SKILL.md` and a minimal `apm.yml`.
 *
 * APM rejects `file://` URLs but accepts absolute local paths under
 * `dependencies.apm` — those produce `source: local` lockfile entries
 * with `local_path: <abs>`. Tests use this form to exercise real APM
 * end-to-end without network.
 */
export function setupLocalApmSource(args: {
  packageName?: string;
  skillName?: string;
  skillContent?: string;
} = {}): { repoPath: string; sha: string; skillName: string } {
  const packageName = args.packageName ?? 'harness-test-fixture';
  const skillName = args.skillName ?? 'test-fixture';
  const skillContent =
    args.skillContent ??
    [
      '---',
      `name: ${skillName}`,
      'description: Fixture skill for harness reproduce integration tests',
      '---',
      '# Test Fixture',
      '',
      'This skill is installed via APM from a local fixture path.',
      '',
    ].join('\n');

  const repo = mkdtempSync(join(tmpdir(), 'harness-apm-src-'));
  mkdirSync(join(repo, '.apm', 'skills', skillName), { recursive: true });
  writeFileSync(join(repo, '.apm', 'skills', skillName, 'SKILL.md'), skillContent, 'utf-8');
  writeFileSync(
    join(repo, 'apm.yml'),
    `name: ${packageName}\nversion: 1.0.0\n`,
    'utf-8',
  );

  // Real git repo so APM can stamp lockfile metadata if it ever expands
  // local-path semantics. `init -b main` standardizes the branch name
  // across host git defaults (some are master, some main).
  const git = (...argv: string[]): string =>
    execFileSync('git', argv, {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'fixture',
        GIT_AUTHOR_EMAIL: 'fixture@harness.test',
        GIT_COMMITTER_NAME: 'fixture',
        GIT_COMMITTER_EMAIL: 'fixture@harness.test',
      },
      encoding: 'utf-8',
    });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'init fixture');
  const sha = git('rev-parse', 'HEAD').trim();

  return { repoPath: repo, sha, skillName };
}

/**
 * Set up a project directory with an `apm.yml` that depends on the
 * local APM source repo at `repoPath`. Returns the project path. The
 * project has no `.harness/` yet — callers initialize it as needed.
 *
 * Pre-creates `.claude/` so APM auto-target-detection picks "claude"
 * (otherwise APM falls back to `.github/`, which would skip the
 * `.claude/` deployment paths the reproducer test cares about).
 */
export function setupProjectWithApmDep(repoPath: string): string {
  const proj = mkdtempSync(join(tmpdir(), 'harness-apm-proj-'));
  mkdirSync(join(proj, '.claude'), { recursive: true });
  writeFileSync(
    join(proj, 'apm.yml'),
    `name: test-project\nversion: 1.0.0\ndependencies:\n  apm:\n    - ${repoPath}\n`,
    'utf-8',
  );
  return proj;
}

/**
 * Synchronously run `apm install` in `cwd`. Throws on non-zero exit.
 * Returns the post-install lockfile content.
 */
export function runApmInstall(cwd: string): string {
  const result = execFileSync('apm', ['install'], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  void result; // we only care about side effects + lockfile
  // The lockfile is at apm.lock.yaml in cwd.
  const lockfilePath = join(cwd, 'apm.lock.yaml');
  return execFileSync('cat', [lockfilePath], { encoding: 'utf-8' });
}
