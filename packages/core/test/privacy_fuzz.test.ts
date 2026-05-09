// Privacy fuzz gate (W12.5) — load-bearing per spec/format.md §10.2.
//
// The ingester reads JSONL bytes that contain user prompts, tool inputs,
// tool results, system prompts, and assistant thinking. NONE of that
// may land in harness storage. This gate verifies that empirically:
//
//   1. Build a fixture JSONL with canary tokens in every forbidden
//      field (one canary per field type, distinct so a positive hit
//      tells us which field leaked).
//   2. Run `Repo.ingestSession` against the fixture.
//   3. Read the entire `lineage.sqlite` file as raw bytes and grep
//      for any canary substring. Zero matches required.
//   4. Also assert against the parsed turn_metrics rows — same answer
//      from a different angle (catches a hypothetical bug where the
//      bytes are stored but in a way grep misses, e.g. encoded).
//
// If a canary leaks, halt and audit `parseLine` in ingest.ts. The
// whitelist discipline says: do NOT reach into JSON for fields not
// in §10.1. This gate is the fuse.

import { describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Repo } from '../src/repo.js';
import type { TurnRecord } from '../src/types.js';

const SID = '00000000-0000-4000-8000-deadbeefcafe';
const NOW = '2026-05-09T00:00:00.000Z';

const CANARIES = {
  prompt:        'SECRET_CANARY_PROMPT_aae28b1f',
  toolInput:     'SECRET_CANARY_INPUT_5f1c93a2',
  toolResult:    'SECRET_CANARY_RESULT_d29b04ee',
  think:         'SECRET_CANARY_THINK_eb70c1c5',
  thinkSig:      'SECRET_CANARY_SIG_3b1aa28d',
  sysPrompt:     'SECRET_CANARY_SYS_92c40f8e',
  appendSys:     'SECRET_CANARY_APPSYS_be17daa9',
  attachment:    'SECRET_CANARY_ATTACH_71d885b3',
  assistantText: 'SECRET_CANARY_ASSIST_0a44a7c2',
  lastAsst:      'SECRET_CANARY_LASTASST_4ecbf06d',
  toolUseId:     'SECRET_CANARY_TUID_8a06ca9f',
};

function fuzzedJsonl(): string {
  // The fixture mirrors a real Claude Code session:
  // user prompt → assistant (thinking + text + tool_use) → user
  // (tool_result) → assistant (text). System prompt + last-prompt
  // bookkeeping included to exercise those forbidden surfaces.
  const lines = [
    // System line — entire forbidden territory.
    {
      type: 'system',
      sessionId: SID,
      version: '2.1.131',
      system_prompt: CANARIES.sysPrompt,
      append_system_prompt: CANARIES.appendSys,
    },

    // First user prompt.
    {
      type: 'user',
      sessionId: SID,
      version: '2.1.131',
      isSidechain: false,
      message: {
        role: 'user',
        content: [{ type: 'text', text: CANARIES.prompt }],
      },
    },

    // Assistant: thinking + text + tool_use (input forbidden).
    {
      type: 'assistant',
      sessionId: SID,
      version: '2.1.131',
      isSidechain: false,
      requestId: 'req_canary',
      attributionSkill: 'recall',
      message: {
        model: 'claude-opus-4-7',
        usage: {
          input_tokens: 11,
          output_tokens: 22,
          cache_creation_input_tokens: 33,
          cache_read_input_tokens: 44,
        },
        content: [
          { type: 'thinking', thinking: CANARIES.think, signature: CANARIES.thinkSig },
          { type: 'text', text: CANARIES.assistantText },
          {
            type: 'tool_use',
            id: CANARIES.toolUseId,
            name: 'Bash',
            input: { command: CANARIES.toolInput, env: { LEAK: CANARIES.toolInput } },
          },
        ],
      },
    },

    // User-side tool_result block — pure forbidden territory.
    {
      type: 'user',
      sessionId: SID,
      version: '2.1.131',
      isSidechain: false,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: CANARIES.toolUseId,
            content: CANARIES.toolResult,
          },
        ],
      },
      // toolUseResult is also observed in real transcripts; keep it forbidden.
      toolUseResult: { stdout: CANARIES.toolResult },
    },

    // Attachment — entire data field forbidden.
    {
      type: 'attachment',
      sessionId: SID,
      version: '2.1.131',
      attachment: { mime: 'text/plain', content: CANARIES.attachment },
    },

    // last-prompt bookkeeping line — has lastPrompt content forbidden too.
    {
      type: 'last-prompt',
      sessionId: SID,
      lastPrompt: CANARIES.prompt,
      leafUuid: 'whatever',
    },

    // Final assistant turn with stop-event-style last_assistant_message.
    {
      type: 'assistant',
      sessionId: SID,
      version: '2.1.131',
      isSidechain: false,
      requestId: 'req_canary_2',
      message: {
        model: 'claude-opus-4-7',
        usage: { input_tokens: 5, output_tokens: 10 },
        content: [{ type: 'text', text: CANARIES.assistantText }],
      },
      // Reality-check: the Stop event payload's last_assistant_message
      // field doesn't actually appear in the JSONL — it's in the hook
      // payload. Including it here verifies the parser doesn't
      // accidentally pick it up if a future host adds it.
      last_assistant_message: CANARIES.lastAsst,
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

function freshRepo(): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'harness-w12_5-'));
  return Repo.init(dir, { defaultBranch: 'main' });
}

function harnessDirOf(repo: Repo): string {
  // The Repo constructor stores harnessDir; expose via a path-derivation
  // assumption: lineage.sqlite lives at <harnessDir>/lineage.sqlite.
  // This is the load-bearing convention used everywhere in the codebase.
  return (repo as unknown as { harnessDir: string }).harnessDir;
}

describe('W12.5 — privacy whitelist (load-bearing)', () => {
  test('zero canaries in any turn_metrics row column', () => {
    const repo = freshRepo();
    try {
      const dir = mkdtempSync(join(tmpdir(), 'w12_5-tx-'));
      const path = join(dir, `${SID}.jsonl`);
      writeFileSync(path, fuzzedJsonl(), 'utf-8');
      repo.ingestSession({ sessionId: SID, transcriptPath: path, now: NOW });

      const turns = repo.turnsOf(SID);
      // We expect: 2 user rows (prompt, tool_result) + 2 assistant rows.
      // System, attachment, and last-prompt lines are skipped by the parser.
      expect(turns).toHaveLength(4);

      // Stringify every row and grep for any canary substring.
      const dump = JSON.stringify(turns);
      for (const [field, canary] of Object.entries(CANARIES)) {
        expect(
          dump.includes(canary),
          `${field} canary "${canary}" leaked into turn_metrics rows`,
        ).toBe(false);
      }
    } finally {
      repo.close();
    }
  });

  test('zero canaries in raw lineage.sqlite bytes', () => {
    const repo = freshRepo();
    try {
      const dir = mkdtempSync(join(tmpdir(), 'w12_5-tx2-'));
      const path = join(dir, `${SID}.jsonl`);
      writeFileSync(path, fuzzedJsonl(), 'utf-8');
      repo.ingestSession({ sessionId: SID, transcriptPath: path, now: NOW });
      const harnessDir = harnessDirOf(repo);
      const dbPath = join(harnessDir, 'lineage.sqlite');
      // Close so SQLite flushes WAL bytes into the main file before we
      // grep them. The PRAGMA journal_mode=WAL setting in IndexDb.open
      // means recent writes might still be in the -wal sidecar.
      repo.close();

      // Read the main DB file. Also concatenate any -wal or -shm
      // sidecars if present (defense in depth — a canary could in
      // principle hide there).
      const buffers: Buffer[] = [];
      try { buffers.push(readFileSync(dbPath)); } catch { /* primary missing? */ }
      try { buffers.push(readFileSync(`${dbPath}-wal`)); } catch { /* normal — closed cleanly */ }
      try { buffers.push(readFileSync(`${dbPath}-shm`)); } catch { /* normal — closed cleanly */ }

      const all = Buffer.concat(buffers).toString('binary');
      for (const [field, canary] of Object.entries(CANARIES)) {
        expect(
          all.includes(canary),
          `${field} canary "${canary}" leaked into raw lineage.sqlite bytes`,
        ).toBe(false);
      }
    } finally {
      // Repo already closed inside the try block; double-close is a no-op.
      try { repo.close(); } catch { /* idempotent */ }
    }
  });

  test('parser correctly extracts non-forbidden fields from the fuzzed fixture', () => {
    // Belt-and-suspenders: the gate above proves NO canaries leak.
    // This sub-test proves the GOOD fields (model, usage, tool name)
    // ARE captured — so a regression that just disables the parser
    // silently doesn't sneak past the privacy gate.
    const repo = freshRepo();
    try {
      const dir = mkdtempSync(join(tmpdir(), 'w12_5-good-'));
      const path = join(dir, `${SID}.jsonl`);
      writeFileSync(path, fuzzedJsonl(), 'utf-8');
      repo.ingestSession({ sessionId: SID, transcriptPath: path, now: NOW });

      const turns = repo.turnsOf(SID);
      const assistantTurns = turns.filter((t: TurnRecord) => t.turnType === 'assistant');
      expect(assistantTurns).toHaveLength(2);
      // First assistant turn carried a Bash tool_use; tool_names_csv
      // pulls .name only, NOT .input (the forbidden territory).
      expect(assistantTurns[0].toolNamesCsv).toBe('Bash');
      expect(assistantTurns[0].model).toBe('claude-opus-4-7');
      expect(assistantTurns[0].inputTokens).toBe(11);
      expect(assistantTurns[0].outputTokens).toBe(22);
      expect(assistantTurns[0].requestId).toBe('req_canary');
      expect(assistantTurns[0].attributionSkill).toBe('recall');
      // Second assistant turn: text only, no tool_use.
      expect(assistantTurns[1].toolNamesCsv).toBe(null);
    } finally {
      repo.close();
    }
  });
});
