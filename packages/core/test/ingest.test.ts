import { describe, expect, test } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Repo } from '../src/repo.js';
import { parseTranscriptJsonl, parseTranscriptText } from '../src/ingest.js';

const SID = '00000000-0000-4000-8000-000000000001';
const NOW = '2026-05-09T00:00:00.000Z';

function jsonl(...lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

function writeTranscript(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-ingest-'));
  const path = join(dir, `${SID}.jsonl`);
  writeFileSync(path, content, 'utf-8');
  return path;
}

function freshRepo(): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'harness-ingest-repo-'));
  return Repo.init(dir, { defaultBranch: 'main' });
}

describe('parseTranscriptText (pure, in-memory)', () => {
  test('extracts assistant turn fields per §10.1 whitelist', () => {
    const text = jsonl({
      type: 'assistant',
      requestId: 'req_abc',
      isSidechain: false,
      attributionSkill: 'recall',
      version: '2.1.131',
      message: {
        model: 'claude-opus-4-7',
        usage: {
          input_tokens: 5,
          output_tokens: 138,
          cache_creation_input_tokens: 12451,
          cache_read_input_tokens: 14878,
        },
        content: [
          { type: 'thinking', thinking: 'CANARY_THINK' },
          { type: 'text', text: 'CANARY_TEXT' },
          { type: 'tool_use', name: 'Bash', input: { command: 'CANARY_INPUT' } },
        ],
      },
    });
    const records = parseTranscriptText(text, SID, NOW);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      sessionId: SID,
      turnIndex: 0,
      turnType: 'assistant',
      model: 'claude-opus-4-7',
      inputTokens: 5,
      outputTokens: 138,
      cacheCreationInputTokens: 12451,
      cacheReadInputTokens: 14878,
      toolNamesCsv: 'Bash',
      isSidechain: 0,
      attributionSkill: 'recall',
      ingestedAt: NOW,
      requestId: 'req_abc',
    });
  });

  test('user turn carries no tokens, no model, no tools, no requestId', () => {
    const text = jsonl({
      type: 'user',
      version: '2.1.131',
      isSidechain: false,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: 'CANARY_TOOL_RESULT' }],
      },
    });
    const records = parseTranscriptText(text, SID, NOW);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      turnType: 'user',
      model: null,
      inputTokens: null,
      outputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      toolNamesCsv: null,
      attributionSkill: null,
      requestId: null,
    });
  });

  test('skips non-message line types (system, queue-operation, attachment, file-history-snapshot, last-prompt)', () => {
    const text = jsonl(
      { type: 'system', text: 'CANARY_SYS' },
      { type: 'queue-operation', op: 'enqueue' },
      { type: 'attachment', attachment: { content: 'CANARY_ATTACH' } },
      { type: 'file-history-snapshot', isSnapshotUpdate: true, snapshot: 'CANARY' },
      { type: 'last-prompt', lastPrompt: 'CANARY_LP' },
      { type: 'user', isSidechain: false, message: { role: 'user', content: [] } },
      { type: 'assistant', isSidechain: false, message: { model: 'm', usage: {}, content: [] } },
    );
    const records = parseTranscriptText(text, SID, NOW);
    expect(records.map((r) => r.turnType)).toEqual(['user', 'assistant']);
    expect(records[0].turnIndex).toBe(0);
    expect(records[1].turnIndex).toBe(1);
  });

  test('drops trailing partial line (in-progress JSONL)', () => {
    // Two complete records + one unterminated half-line.
    const text =
      JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: [] } }) +
      '\n' +
      JSON.stringify({ type: 'assistant', isSidechain: false, message: { model: 'm', usage: {}, content: [] } }) +
      '\n' +
      '{"type":"assistant","message":';
    const records = parseTranscriptText(text, SID, NOW);
    expect(records).toHaveLength(2);
  });

  test('skips JSON-parse failures and continues', () => {
    const text =
      'not json at all\n' +
      '{ malformed\n' +
      JSON.stringify({ type: 'assistant', isSidechain: false, message: { model: 'm', usage: {}, content: [] } }) +
      '\n';
    const records = parseTranscriptText(text, SID, NOW);
    expect(records).toHaveLength(1);
    expect(records[0].turnType).toBe('assistant');
  });

  test('isSidechain true → 1; false → 0; absent → 0', () => {
    const text = jsonl(
      { type: 'assistant', isSidechain: true, message: { model: 'm', usage: {}, content: [] } },
      { type: 'assistant', isSidechain: false, message: { model: 'm', usage: {}, content: [] } },
      { type: 'assistant', message: { model: 'm', usage: {}, content: [] } },
    );
    const records = parseTranscriptText(text, SID, NOW);
    expect(records.map((r) => r.isSidechain)).toEqual([1, 0, 0]);
  });

  test('mcp__-prefixed tool names are kept verbatim', () => {
    const text = jsonl({
      type: 'assistant',
      isSidechain: false,
      message: {
        model: 'm',
        usage: {},
        content: [
          { type: 'tool_use', name: 'mcp__claude_ai_Gmail__authenticate', input: {} },
          { type: 'tool_use', name: 'Bash', input: {} },
        ],
      },
    });
    const records = parseTranscriptText(text, SID, NOW);
    expect(records[0].toolNamesCsv).toBe('mcp__claude_ai_Gmail__authenticate,Bash');
  });

  test('multiple tool_use blocks comma-join in content order', () => {
    const text = jsonl({
      type: 'assistant',
      isSidechain: false,
      message: {
        model: 'm',
        usage: {},
        content: [
          { type: 'tool_use', name: 'Read', input: {} },
          { type: 'thinking', thinking: 'x' },
          { type: 'tool_use', name: 'Edit', input: {} },
          { type: 'tool_use', name: 'Bash', input: {} },
        ],
      },
    });
    const records = parseTranscriptText(text, SID, NOW);
    expect(records[0].toolNamesCsv).toBe('Read,Edit,Bash');
  });

  test('turn_index counts emitted rows only — non-message lines do not consume an index', () => {
    const text = jsonl(
      { type: 'system', x: 1 },
      { type: 'user', isSidechain: false, message: { role: 'user', content: [] } },
      { type: 'queue-operation', op: 'x' },
      { type: 'assistant', isSidechain: false, message: { model: 'm', usage: {}, content: [] } },
      { type: 'attachment', attachment: {} },
      { type: 'user', isSidechain: false, message: { role: 'user', content: [] } },
    );
    const records = parseTranscriptText(text, SID, NOW);
    expect(records.map((r) => r.turnIndex)).toEqual([0, 1, 2]);
  });
});

describe('parseTranscriptJsonl (file-based)', () => {
  test('returns [] when file is unreadable', () => {
    expect(parseTranscriptJsonl('/no/such/file.jsonl', SID, NOW)).toEqual([]);
  });

  test('reads a real-shape file', () => {
    const path = writeTranscript(jsonl(
      { type: 'user', isSidechain: false, message: { role: 'user', content: [] } },
      { type: 'assistant', isSidechain: false, message: { model: 'claude-opus-4-7', usage: { input_tokens: 1, output_tokens: 1 }, content: [] } },
    ));
    const records = parseTranscriptJsonl(path, SID, NOW);
    expect(records).toHaveLength(2);
    expect(records[0].turnType).toBe('user');
    expect(records[1].turnType).toBe('assistant');
  });
});

// Each test below is gated by a W12.x name from the v0.5.0 spec
// (docs/session-metrics-prompt.md). The unit-level coverage here is
// the contract; step 10's `cases/w12_session_metrics.sh` mirrors
// these gates at the CLI level.
describe('Repo.ingestSession — end-to-end (W12 unit gates)', () => {
  test('W12.1 — first ingest: every record stored, cost summary populated', () => {
    const repo = freshRepo();
    try {
      const path = writeTranscript(jsonl(
        { type: 'user', isSidechain: false, message: { role: 'user', content: [] } },
        { type: 'assistant', isSidechain: false, requestId: 'req_1', message: {
          model: 'claude-opus-4-7',
          usage: { input_tokens: 10, output_tokens: 50, cache_creation_input_tokens: 100, cache_read_input_tokens: 200 },
          content: [{ type: 'tool_use', name: 'Bash', input: {} }],
        }},
        { type: 'assistant', isSidechain: false, requestId: 'req_2', message: {
          model: 'claude-opus-4-7',
          usage: { input_tokens: 5, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000 },
          content: [
            { type: 'tool_use', name: 'Edit', input: {} },
            { type: 'tool_use', name: 'Bash', input: {} },
          ],
        }},
      ));
      const result = repo.ingestSession({ sessionId: SID, transcriptPath: path, now: NOW });
      expect(result.added).toBe(3);
      expect(result.skipped).toBe(0);
      expect(result.cost).toMatchObject({
        sessionId: SID,
        totalTurns: 3,
        userTurns: 1,
        assistantTurns: 2,
        models: ['claude-opus-4-7'],
        inputTokens: 15,
        outputTokens: 80,
        cacheCreationInputTokens: 100,
        cacheReadInputTokens: 1200,
        tools: { Bash: 2, Edit: 1 },
      });
    } finally {
      repo.close();
    }
  });

  test('W12.2 — idempotent: second ingest on unchanged file adds zero rows', () => {
    const repo = freshRepo();
    try {
      const path = writeTranscript(jsonl(
        { type: 'user', isSidechain: false, message: { role: 'user', content: [] } },
        { type: 'assistant', isSidechain: false, message: { model: 'm', usage: {}, content: [] } },
      ));
      const a = repo.ingestSession({ sessionId: SID, transcriptPath: path, now: NOW });
      expect(a.added).toBe(2);
      const b = repo.ingestSession({ sessionId: SID, transcriptPath: path, now: NOW });
      expect(b.added).toBe(0);
      expect(b.skipped).toBe(2);
      expect(b.cost.totalTurns).toBe(2);
    } finally {
      repo.close();
    }
  });

  test('W12.3 — append two new turns; re-ingest adds exactly two rows', () => {
    const repo = freshRepo();
    try {
      const initial = jsonl(
        { type: 'user', isSidechain: false, message: { role: 'user', content: [] } },
        { type: 'assistant', isSidechain: false, message: { model: 'm', usage: {}, content: [] } },
      );
      const path = writeTranscript(initial);
      repo.ingestSession({ sessionId: SID, transcriptPath: path, now: NOW });
      // Append two more rows.
      const appended = initial + jsonl(
        { type: 'user', isSidechain: false, message: { role: 'user', content: [] } },
        { type: 'assistant', isSidechain: false, message: { model: 'm', usage: {}, content: [] } },
      );
      writeFileSync(path, appended, 'utf-8');
      const r = repo.ingestSession({ sessionId: SID, transcriptPath: path, now: NOW });
      expect(r.added).toBe(2);
      expect(r.skipped).toBe(2);
      expect(r.cost.totalTurns).toBe(4);
    } finally {
      repo.close();
    }
  });

  test('W12.6 — isSidechain=true rows persisted with is_sidechain=1', () => {
    const repo = freshRepo();
    try {
      const path = writeTranscript(jsonl(
        { type: 'assistant', isSidechain: true, message: { model: 'm', usage: {}, content: [] } },
        { type: 'assistant', isSidechain: false, message: { model: 'm', usage: {}, content: [] } },
      ));
      repo.ingestSession({ sessionId: SID, transcriptPath: path, now: NOW });
      const turns = repo.turnsOf(SID);
      expect(turns.map((t) => t.isSidechain)).toEqual([1, 0]);
    } finally {
      repo.close();
    }
  });

  test('dry-run does not write rows', () => {
    const repo = freshRepo();
    try {
      const path = writeTranscript(jsonl(
        { type: 'user', isSidechain: false, message: { role: 'user', content: [] } },
      ));
      const r = repo.ingestSession({ sessionId: SID, transcriptPath: path, now: NOW, options: { dryRun: true } });
      expect(r.added).toBe(1);
      expect(r.dryRun).toBe(true);
      expect(repo.turnsOf(SID)).toHaveLength(0);
    } finally {
      repo.close();
    }
  });

  test('sessionCost returns null when no rows ingested', () => {
    const repo = freshRepo();
    try {
      expect(repo.sessionCost(SID)).toBe(null);
    } finally {
      repo.close();
    }
  });

  test('W12.4 — mcp__server__tool name preserved end-to-end through SQL roundtrip', () => {
    const repo = freshRepo();
    try {
      const path = writeTranscript(jsonl(
        { type: 'assistant', isSidechain: false, message: { model: 'm', usage: {}, content: [
          { type: 'tool_use', name: 'mcp__github__create_issue', input: {} },
        ]}},
      ));
      repo.ingestSession({ sessionId: SID, transcriptPath: path, now: NOW });
      const turns = repo.turnsOf(SID);
      expect(turns[0].toolNamesCsv).toBe('mcp__github__create_issue');
    } finally {
      repo.close();
    }
  });
});
