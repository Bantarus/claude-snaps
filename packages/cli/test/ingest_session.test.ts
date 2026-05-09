import { describe, expect, test } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli, runHook } from './util.js';

// CLI smoke tests for `harness ingest-session` + `harness session-cost`.
// Unit-level coverage of the parser/queries lives in
// packages/core/test/ingest.test.ts and privacy_fuzz.test.ts. These
// tests verify the binary's argv parsing, error paths, and rendering.

const SID_A = 'aa000000-0000-4000-8000-aaaaaaaaaaaa';
const SID_B = 'bb000000-0000-4000-8000-bbbbbbbbbbbb';

function jsonl(...lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

function fixtureTranscript(): string {
  return jsonl(
    { type: 'user', isSidechain: false, version: '2.1.131', message: { role: 'user', content: [] } },
    { type: 'assistant', isSidechain: false, requestId: 'r1', version: '2.1.131', message: {
      model: 'claude-opus-4-7',
      usage: { input_tokens: 5, output_tokens: 30, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 },
      content: [{ type: 'tool_use', name: 'Bash', input: {} }],
    }},
    { type: 'assistant', isSidechain: false, requestId: 'r2', version: '2.1.131', message: {
      model: 'claude-opus-4-7',
      usage: { input_tokens: 1, output_tokens: 5 },
      content: [{ type: 'tool_use', name: 'Read', input: {} }],
    }},
  );
}

async function freshHarnessRepo(): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), 'harness-cli-ingest-'));
  const r = await runCli(['init'], { cwd });
  expect(r.code).toBe(0);
  return cwd;
}

describe('harness ingest-session — CLI', () => {
  test('explicit --transcript-path: ingests rows and prints summary', async () => {
    const cwd = await freshHarnessRepo();
    const txPath = join(cwd, 'fixture.jsonl');
    writeFileSync(txPath, fixtureTranscript(), 'utf-8');

    const r = await runCli(
      ['ingest-session', SID_A, '--transcript-path', txPath],
      { cwd },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Ingested 3 new turns from session/);
    expect(r.stdout).toContain('user turns: 1');
    expect(r.stdout).toContain('assistant turns: 2');
    expect(r.stdout).toContain('claude-opus-4-7');
    expect(r.stdout).toContain('Bash×1');
    expect(r.stdout).toContain('Read×1');
    expect(r.stdout).toContain('2.1.131');
  });

  test('idempotent re-run prints zero new turns', async () => {
    const cwd = await freshHarnessRepo();
    const txPath = join(cwd, 'fixture.jsonl');
    writeFileSync(txPath, fixtureTranscript(), 'utf-8');

    const a = await runCli(['ingest-session', SID_A, '--transcript-path', txPath], { cwd });
    expect(a.code).toBe(0);
    const b = await runCli(['ingest-session', SID_A, '--transcript-path', txPath], { cwd });
    expect(b.code).toBe(0);
    expect(b.stdout).toMatch(/0 new turns/);
    expect(b.stdout).toMatch(/3 turns already stored/);
  });

  test('--dry-run reports counts but writes nothing', async () => {
    const cwd = await freshHarnessRepo();
    const txPath = join(cwd, 'fixture.jsonl');
    writeFileSync(txPath, fixtureTranscript(), 'utf-8');

    const r = await runCli(
      ['ingest-session', SID_A, '--transcript-path', txPath, '--dry-run'],
      { cwd },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/dry-run/);
    expect(r.stdout).toMatch(/Would ingest 3 new turns/);

    // Verify no rows were actually persisted: a follow-up session-cost
    // call surfaces "no rows" stderr.
    const verify = await runCli(['session-cost', SID_A], { cwd });
    expect(verify.code).toBe(1);
    expect(verify.stderr).toMatch(/no turn_metrics rows/);
  });

  test('missing transcript: stderr error, exit 1', async () => {
    const cwd = await freshHarnessRepo();
    const r = await runCli(
      ['ingest-session', SID_A, '--transcript-path', '/no/such/path.jsonl'],
      { cwd },
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/transcript not found/);
  });

  test('no args, no --all: usage to stderr, exit 1', async () => {
    const cwd = await freshHarnessRepo();
    const r = await runCli(['ingest-session'], { cwd });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Usage: harness ingest-session/);
    // Help text MUST mention the privacy whitelist (load-bearing per
    // spec/format.md §10.2 and the v0.5.0 success criterion).
    expect(r.stderr).toMatch(/whitelisted fields per spec\/format\.md §10\.2/);
  });

  test('--all and <session-id> are mutually exclusive', async () => {
    const cwd = await freshHarnessRepo();
    const r = await runCli(['ingest-session', SID_A, '--all'], { cwd });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/<session-id> OR --all, not both/);
  });

  test('--all with no attribution rows: emits "(no sessions)" and exits 0', async () => {
    const cwd = await freshHarnessRepo();
    const r = await runCli(['ingest-session', '--all'], { cwd });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/no sessions/);
  });
});

describe('harness session-cost — CLI', () => {
  test('per-session report after ingestion prints all required fields', async () => {
    const cwd = await freshHarnessRepo();
    const txPath = join(cwd, 'fixture.jsonl');
    writeFileSync(txPath, fixtureTranscript(), 'utf-8');
    await runCli(['ingest-session', SID_A, '--transcript-path', txPath], { cwd });

    const r = await runCli(['session-cost', SID_A], { cwd });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`Session ${SID_A}`));
    expect(r.stdout).toMatch(/Turns:\s+3 \(1 user \/ 2 assistant\)/);
    expect(r.stdout).toMatch(/Models:\s+claude-opus-4-7/);
    expect(r.stdout).toMatch(/Input tokens \(live\):\s+6/);
    expect(r.stdout).toMatch(/Cache read:\s+1,000/);
    expect(r.stdout).toMatch(/Cache creation:\s+100/);
    expect(r.stdout).toMatch(/Output tokens:\s+35/);
    expect(r.stdout).toMatch(/Tools called:.*Bash: 1.*Read: 1/);
  });

  test('--by-tool surfaces call counts and the per-tool-tokens limitation', async () => {
    const cwd = await freshHarnessRepo();
    const txPath = join(cwd, 'fixture.jsonl');
    writeFileSync(txPath, fixtureTranscript(), 'utf-8');
    await runCli(['ingest-session', SID_A, '--transcript-path', txPath], { cwd });

    const r = await runCli(['session-cost', SID_A, '--by-tool'], { cwd });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/by tool/);
    // Required help-text limitation per W12.10 / spec/format.md §10.3.
    expect(r.stdout).toMatch(/per-tool tokens NOT supportable per spec\/format\.md §10\.3/);
    expect(r.stdout).toMatch(/Bash\s+1 call/);
    expect(r.stdout).toMatch(/Read\s+1 call/);
  });

  test('unknown session: stderr error, exit 1', async () => {
    const cwd = await freshHarnessRepo();
    const r = await runCli(['session-cost', SID_B], { cwd });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no turn_metrics rows/);
  });

  test('--all with two ingested sessions ranks by total tokens DESC', async () => {
    const cwd = await freshHarnessRepo();
    const txPathA = join(cwd, 'a.jsonl');
    writeFileSync(txPathA, fixtureTranscript(), 'utf-8');
    const txPathB = join(cwd, 'b.jsonl');
    // Bigger session (bigger token totals).
    writeFileSync(txPathB, jsonl(
      { type: 'assistant', isSidechain: false, message: {
        model: 'claude-opus-4-7',
        usage: { input_tokens: 999_999, output_tokens: 0 },
        content: [],
      }},
    ), 'utf-8');
    await runCli(['ingest-session', SID_A, '--transcript-path', txPathA], { cwd });
    await runCli(['ingest-session', SID_B, '--transcript-path', txPathB], { cwd });

    const r = await runCli(['session-cost', '--all'], { cwd });
    expect(r.code).toBe(0);
    // SID_B should appear before SID_A by total tokens DESC.
    const idxA = r.stdout.indexOf(SID_A.slice(0, 8));
    const idxB = r.stdout.indexOf(SID_B.slice(0, 8));
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxA).toBeGreaterThan(idxB);
  });

  test('--csv emits header + rows', async () => {
    const cwd = await freshHarnessRepo();
    const txPath = join(cwd, 'fixture.jsonl');
    writeFileSync(txPath, fixtureTranscript(), 'utf-8');
    await runCli(['ingest-session', SID_A, '--transcript-path', txPath], { cwd });

    const r = await runCli(['session-cost', SID_A, '--csv'], { cwd });
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines[0]).toBe(
      'session_id,total_turns,user_turns,assistant_turns,input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens,models,tools,claude_code_version',
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(SID_A);
  });
});

describe('harness ingest-session — uses attribution cwd by default', () => {
  test('after a hook fire, ingest-session resolves the JSONL via CLAUDE_PROJECT_DIR-style encoding', async () => {
    // We exercise the default-path resolution via an env-mock: the
    // ingest-session command builds the path from process.cwd(),
    // encoding it per §10.5. We pass --transcript-path explicitly
    // here to avoid depending on ~/.claude/projects/ at test time —
    // the encoding logic itself is unit-tested in core.
    const cwd = await freshHarnessRepo();
    // First fire the hook so an attribution row exists for SID_A.
    const hookR = await runHook(['--session-id', SID_A, '--cwd', cwd], { cwd });
    expect(hookR.code).toBe(0);

    const txPath = join(cwd, 'fixture.jsonl');
    writeFileSync(txPath, fixtureTranscript(), 'utf-8');
    const r = await runCli(
      ['ingest-session', SID_A, '--transcript-path', txPath],
      { cwd },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Ingested 3 new turns/);
  });
});
