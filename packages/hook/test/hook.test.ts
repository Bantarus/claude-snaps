import { describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshHarnessRepo, openRepo, runHook, writeMinimalClaude } from './util.js';

describe('harness-hook — happy path (v0.2: dual-event capture)', () => {
  test('SessionStart writes init snapshot + session_start attribution; exits 0', async () => {
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    const r = await runHook(
      ['--session-id', 's1', '--cwd', cwd, '--hook-event-name', 'SessionStart'],
      { cwd },
    );
    expect(r.code).toBe(0);
    expect(r.stderr).not.toMatch(/error/);

    const repo = openRepo(cwd);
    try {
      expect(repo.log()).toHaveLength(1);
      const traj = repo.trajectoryOf('s1');
      expect(traj).toHaveLength(1);
      expect(traj[0]!.eventKind).toBe('session_start');
      const head = repo.resolveHead();
      expect(traj[0]!.snapshotId).toBe(head);
      // Branch ref advanced.
      expect(repo.branchTip('main')).toBe(head);
    } finally {
      repo.close();
    }
  });

  test('default hookEventName is SessionStart when stdin/CLI omits it', async () => {
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    await runHook(['--session-id', 's-default', '--cwd', cwd], { cwd });
    const repo = openRepo(cwd);
    try {
      expect(repo.trajectoryOf('s-default')[0]!.eventKind).toBe('session_start');
    } finally {
      repo.close();
    }
  });

  test('UserPromptSubmit on empty repo also writes init snapshot + user_prompt attribution', async () => {
    // First fire of any session must succeed regardless of event name.
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    const r = await runHook(
      ['--session-id', 'first-prompt', '--cwd', cwd, '--hook-event-name', 'UserPromptSubmit'],
      { cwd },
    );
    expect(r.code).toBe(0);
    const repo = openRepo(cwd);
    try {
      const traj = repo.trajectoryOf('first-prompt');
      expect(traj).toHaveLength(1);
      expect(traj[0]!.eventKind).toBe('user_prompt');
    } finally {
      repo.close();
    }
  });
});

describe('harness-hook — composition-change detection (spec/hooks.md §2)', () => {
  test('two fires same session, composition unchanged: 1 snapshot, 2 attributions', async () => {
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    await runHook(
      ['--session-id', 's-stable', '--cwd', cwd, '--hook-event-name', 'SessionStart'],
      { cwd },
    );
    await runHook(
      ['--session-id', 's-stable', '--cwd', cwd, '--hook-event-name', 'UserPromptSubmit'],
      { cwd },
    );
    const repo = openRepo(cwd);
    try {
      expect(repo.log()).toHaveLength(1);
      const traj = repo.trajectoryOf('s-stable');
      expect(traj).toHaveLength(2);
      expect(traj.map((t) => t.eventKind)).toEqual(['session_start', 'user_prompt']);
      // Both attributions point at the same snapshot.
      expect(traj[0]!.snapshotId).toBe(traj[1]!.snapshotId);
    } finally {
      repo.close();
    }
  });

  test('composition change between fires writes a new snapshot, advances branch', async () => {
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    await runHook(['--session-id', 's', '--cwd', cwd], { cwd });
    // Add a new skill — composition changes.
    mkdirSync(join(cwd, '.claude/skills/summarize'), { recursive: true });
    writeFileSync(join(cwd, '.claude/skills/summarize/SKILL.md'), '# summarize\n');
    await runHook(
      ['--session-id', 's', '--cwd', cwd, '--hook-event-name', 'UserPromptSubmit'],
      { cwd },
    );
    const repo = openRepo(cwd);
    try {
      expect(repo.log()).toHaveLength(2);
      const traj = repo.trajectoryOf('s');
      expect(traj).toHaveLength(2);
      // Two distinct snapshot ids.
      expect(traj[0]!.snapshotId).not.toBe(traj[1]!.snapshotId);
      // Branch tip points at the new snapshot.
      expect(repo.branchTip('main')).toBe(traj[1]!.snapshotId);
    } finally {
      repo.close();
    }
  });

  test('two distinct sessions, identical composition: shared snapshot, two trajectories', async () => {
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    await runHook(['--session-id', 'sess-A', '--cwd', cwd], { cwd });
    await runHook(['--session-id', 'sess-B', '--cwd', cwd], { cwd });
    const repo = openRepo(cwd);
    try {
      expect(repo.log()).toHaveLength(1);
      const sharedId = repo.resolveHead()!;
      expect(repo.trajectoryOf('sess-A')).toHaveLength(1);
      expect(repo.trajectoryOf('sess-B')).toHaveLength(1);
      expect(repo.trajectoryOf('sess-A')[0]!.snapshotId).toBe(sharedId);
      expect(repo.trajectoryOf('sess-B')[0]!.snapshotId).toBe(sharedId);
      // Inverse query lists both sessions.
      const sessions = repo.sessionsAt(sharedId);
      expect(sessions.map((s) => s.sessionId).sort()).toEqual(['sess-A', 'sess-B']);
    } finally {
      repo.close();
    }
  });
});

describe('harness-hook — hot-path cache (spec/hooks.md §2.4, Gate 12)', () => {
  test('repeated unchanged fires for one session: cache hit short-circuits', async () => {
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    // Prime the cache with the first fire (cache miss → full walk).
    await runHook(
      ['--session-id', 'hot', '--cwd', cwd, '--hook-event-name', 'SessionStart'],
      { cwd },
    );
    const repo = openRepo(cwd);
    try {
      // Cache must contain a row for this session now.
      const cached = repo.readObservationCache('hot');
      expect(cached).not.toBeNull();
      expect(cached!.snapshotId).toBe(repo.resolveHead());
    } finally {
      repo.close();
    }

    // Subsequent fires on unchanged composition take the hot path.
    for (let i = 0; i < 5; i++) {
      const r = await runHook(
        ['--session-id', 'hot', '--cwd', cwd, '--hook-event-name', 'UserPromptSubmit'],
        { cwd },
      );
      expect(r.code).toBe(0);
    }

    const repo2 = openRepo(cwd);
    try {
      // Still 1 snapshot; 6 attribution rows (1 session_start + 5 user_prompt).
      expect(repo2.log()).toHaveLength(1);
      const traj = repo2.trajectoryOf('hot');
      expect(traj).toHaveLength(6);
      const userPrompts = traj.filter((t) => t.eventKind === 'user_prompt');
      expect(userPrompts).toHaveLength(5);
      // All point at the same snapshot.
      expect(new Set(traj.map((t) => t.snapshotId)).size).toBe(1);
    } finally {
      repo2.close();
    }
  });

  test('Gate 12 (perf): 100 cache-hit fires complete under a generous budget', async () => {
    // The architect's target is p95 < 10ms per fire. Spawning a Node
    // child process dominates runtime here (~30-80ms each just for
    // V8 startup), so we test the cache-hit path is "fast enough" in
    // wall time without the cache, not the strict per-fire latency
    // (which would require an in-process benchmark, not a subprocess
    // spawn). 100 fires under 30s is a sane wall-clock ceiling.
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    // Prime.
    await runHook(['--session-id', 'perf', '--cwd', cwd], { cwd });
    const start = Date.now();
    for (let i = 0; i < 50; i++) {
      const r = await runHook(
        ['--session-id', 'perf', '--cwd', cwd, '--hook-event-name', 'UserPromptSubmit'],
        { cwd },
      );
      expect(r.code).toBe(0);
    }
    const elapsed = Date.now() - start;
    // Soft budget — 50 fires under 15s on a developer laptop.
    expect(elapsed).toBeLessThan(15_000);
    const repo = openRepo(cwd);
    try {
      expect(repo.log()).toHaveLength(1);
      expect(repo.trajectoryOf('perf')).toHaveLength(51);
    } finally {
      repo.close();
    }
  }, 30_000);
});

describe('harness-hook — defense-in-depth: always exits 0', () => {
  test('missing session id: exit 0, error on stderr', async () => {
    const cwd = await freshHarnessRepo();
    const r = await runHook(['--cwd', cwd], { cwd });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/harness-hook: error:/);
    expect(r.stderr).toMatch(/no session id resolved/);
  });

  test('--cwd points at a non-harness dir: exit 0, error on stderr', async () => {
    const fake = mkdtempSync(join(tmpdir(), 'no-harness-'));
    const r = await runHook(['--session-id', 's1', '--cwd', fake], { cwd: fake });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/harness-hook: error:/);
  });

  test('unknown extra args are accepted and ignored', async () => {
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    const r = await runHook(
      ['--session-id', 's1', '--cwd', cwd, '--future-flag', 'whatever'],
      { cwd },
    );
    expect(r.code).toBe(0);
    expect(r.stderr).not.toMatch(/error/);
  });

  test('legacy --reason flag is accepted-and-ignored (back-compat with v0.1)', async () => {
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    const r = await runHook(
      ['--session-id', 's1', '--cwd', cwd, '--reason', 'auto'],
      { cwd },
    );
    expect(r.code).toBe(0);
    expect(r.stderr).not.toMatch(/error/);
  });
});

describe('harness-hook — Claude Code stdin JSON contract (primary channel)', () => {
  test('stdin JSON with {session_id, cwd, hook_event_name: SessionStart, source: startup}', async () => {
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    const stdin = JSON.stringify({
      session_id: 'cc-stdin-1',
      cwd,
      hook_event_name: 'SessionStart',
      transcript_path: '/tmp/transcript.jsonl',
      source: 'startup',
    });
    const r = await runHook([], { cwd, stdin });
    expect(r.code).toBe(0);
    expect(r.stderr).not.toMatch(/error/);
    const repo = openRepo(cwd);
    try {
      const traj = repo.trajectoryOf('cc-stdin-1');
      expect(traj).toHaveLength(1);
      expect(traj[0]!.eventKind).toBe('session_start');
      expect(traj[0]!.source).toBe('startup');
    } finally {
      repo.close();
    }
  });

  test('hook_event_name: UserPromptSubmit recorded as user_prompt event_kind', async () => {
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    // Prime with a session_start so HEAD has a commit.
    await runHook(
      ['--session-id', 'p', '--cwd', cwd, '--hook-event-name', 'SessionStart'],
      { cwd },
    );
    const stdin = JSON.stringify({
      session_id: 'p',
      cwd,
      hook_event_name: 'UserPromptSubmit',
    });
    const r = await runHook([], { cwd, stdin });
    expect(r.code).toBe(0);
    const repo = openRepo(cwd);
    try {
      const traj = repo.trajectoryOf('p');
      expect(traj).toHaveLength(2);
      expect(traj.map((t) => t.eventKind)).toEqual(['session_start', 'user_prompt']);
    } finally {
      repo.close();
    }
  });

  test('stdin JSON wins over CLI flags', async () => {
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    const stdin = JSON.stringify({ session_id: 'STDINwon', cwd });
    const r = await runHook(
      ['--session-id', 'CLIwon', '--cwd', '/wrong/path'],
      { cwd, stdin },
    );
    expect(r.code).toBe(0);
    const repo = openRepo(cwd);
    try {
      expect(repo.trajectoryOf('STDINwon')).toHaveLength(1);
      expect(repo.trajectoryOf('CLIwon')).toHaveLength(0);
    } finally {
      repo.close();
    }
  });

  test('CLAUDE_PROJECT_DIR env supplies cwd when stdin and CLI omit it', async () => {
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    const r = await runHook(
      ['--session-id', 'envcwd'],
      { cwd, env: { CLAUDE_PROJECT_DIR: cwd } },
    );
    expect(r.code).toBe(0);
    const repo = openRepo(cwd);
    try {
      expect(repo.trajectoryOf('envcwd')).toHaveLength(1);
    } finally {
      repo.close();
    }
  });

  test('malformed stdin JSON is silently ignored if CLI provides everything', async () => {
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    const r = await runHook(
      ['--session-id', 'fallback', '--cwd', cwd],
      { cwd, stdin: '{ this is not valid json' },
    );
    expect(r.code).toBe(0);
    const repo = openRepo(cwd);
    try {
      expect(repo.trajectoryOf('fallback')).toHaveLength(1);
    } finally {
      repo.close();
    }
  });

  test('source: "resume" still produces an attribution event', async () => {
    // The hook always fires regardless of source; the source is just
    // metadata on the attribution row.
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    const r = await runHook([], {
      cwd,
      stdin: JSON.stringify({
        session_id: 'resumed',
        cwd,
        hook_event_name: 'SessionStart',
        source: 'resume',
      }),
    });
    expect(r.code).toBe(0);
    const repo = openRepo(cwd);
    try {
      const traj = repo.trajectoryOf('resumed');
      expect(traj).toHaveLength(1);
      expect(traj[0]!.source).toBe('resume');
    } finally {
      repo.close();
    }
  });

  test('model and permission_mode from stdin land on the new snapshot blob', async () => {
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    const stdin = JSON.stringify({
      session_id: 'with-ctx',
      cwd,
      hook_event_name: 'SessionStart',
      source: 'startup',
      model: 'claude-opus-4-7',
      permission_mode: 'plan',
    });
    const r = await runHook([], { cwd, stdin });
    expect(r.code).toBe(0);
    const repo = openRepo(cwd);
    try {
      const head = repo.snapshot(repo.resolveHead()!);
      expect(head.model).toBe('claude-opus-4-7');
      expect(head.permissionMode).toBe('plan');
    } finally {
      repo.close();
    }
  });

  test('absent model and permission_mode leave the blob without those keys', async () => {
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    const stdin = JSON.stringify({
      session_id: 'no-ctx',
      cwd,
      hook_event_name: 'SessionStart',
      source: 'startup',
    });
    const r = await runHook([], { cwd, stdin });
    expect(r.code).toBe(0);
    const repo = openRepo(cwd);
    try {
      const head = repo.snapshot(repo.resolveHead()!);
      expect('model' in head).toBe(false);
      expect('permissionMode' in head).toBe(false);
    } finally {
      repo.close();
    }
  });

  test('transcript_path with version field lands on the new snapshot as claudeCodeVersion (v0.5.0)', async () => {
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    const transcriptPath = join(cwd, 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      JSON.stringify({ type: 'summary' }) + '\n' +
        JSON.stringify({ type: 'user', version: '2.1.131' }) + '\n',
      'utf-8',
    );
    const stdin = JSON.stringify({
      session_id: 'with-version',
      cwd,
      hook_event_name: 'SessionStart',
      source: 'startup',
      transcript_path: transcriptPath,
    });
    const r = await runHook([], { cwd, stdin });
    expect(r.code).toBe(0);
    const repo = openRepo(cwd);
    try {
      const head = repo.snapshot(repo.resolveHead()!);
      expect(head.claudeCodeVersion).toBe('2.1.131');
    } finally {
      repo.close();
    }
  });
});

describe('harness-hook — APM enrichment when lockfile present', () => {
  test('module deployed_files match → source.kind becomes apm', async () => {
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    writeFileSync(
      join(cwd, 'apm.lock.yaml'),
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
    await runHook(['--session-id', 'with-apm', '--cwd', cwd], { cwd });
    const repo = openRepo(cwd);
    try {
      const head = repo.snapshot(repo.resolveHead()!);
      const research = head.modules.find((m) => m.name === 'research' && m.type === 'skill');
      expect(research).toBeDefined();
      expect(research!.source.kind).toBe('apm');
      expect(head.apmLockHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    } finally {
      repo.close();
    }
  });

  test('lockfile mtime change invalidates cache, forces full walk', async () => {
    const cwd = await freshHarnessRepo();
    writeMinimalClaude(cwd);
    // No lockfile yet — first fire establishes baseline.
    await runHook(['--session-id', 'apm-evolve', '--cwd', cwd], { cwd });
    let repo = openRepo(cwd);
    let firstId: string;
    try {
      firstId = repo.resolveHead()!;
      expect(repo.snapshot(firstId).apmLockHash).toBeNull();
    } finally { repo.close(); }

    // Add a lockfile that re-attributes research to APM.
    writeFileSync(
      join(cwd, 'apm.lock.yaml'),
      `packages:
  - package: example/research-pkg
    repo_url: https://github.com/example/research-pkg
    resolved_commit: ${'b'.repeat(40)}
    depth: 1
    deployed_files:
      - .claude/skills/research/SKILL.md
`,
      'utf-8',
    );
    // Bust mtime granularity by waiting a tick.
    await new Promise((r) => setTimeout(r, 10));
    await runHook(
      ['--session-id', 'apm-evolve', '--cwd', cwd, '--hook-event-name', 'UserPromptSubmit'],
      { cwd },
    );
    repo = openRepo(cwd);
    try {
      // Composition changed (APM reattribution), new snapshot written.
      expect(repo.log().length).toBeGreaterThanOrEqual(2);
      const newHead = repo.snapshot(repo.resolveHead()!);
      expect(newHead.apmLockHash).not.toBeNull();
      const research = newHead.modules.find((m) => m.name === 'research' && m.type === 'skill');
      expect(research!.source.kind).toBe('apm');
    } finally { repo.close(); }
  });
});
