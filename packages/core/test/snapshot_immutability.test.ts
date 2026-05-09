// W12.7 + W12.8 — immutability gates per spec/format.md §10.7.
//
// Ingestion writes turn_metrics rows. It MUST NEVER touch snapshot
// blobs. The capture-side code (capture.ts → repo.observe) is the
// only writer that stamps claudeCodeVersion onto a snapshot, and it
// does so only at first hook fire (first-observation-wins per §2.1).
//
// Two scenarios cover the matrix:
//   W12.7 — pre-v0.5 snapshot (claudeCodeVersion absent / null) gets
//           ingested. The snapshot bytes MUST be byte-identical to
//           what they were before ingest.
//   W12.8 — v0.5+ snapshot (claudeCodeVersion populated by the hook
//           at first fire). Same invariant: ingestion does not
//           rewrite the field, even if the JSONL reports a different
//           per-turn version (Claude Code auto-update mid-session).

import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Repo } from '../src/repo.js';

const SID = '00000000-0000-4000-8000-000000000001';
const NOW_OBSERVE = '2026-05-09T01:00:00.000Z';
const NOW_INGEST = '2026-05-09T02:00:00.000Z';

function jsonl(...lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

function freshRepo(): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'harness-w12_imm-'));
  return Repo.init(dir, { defaultBranch: 'main' });
}

function harnessDirOf(repo: Repo): string {
  return (repo as unknown as { harnessDir: string }).harnessDir;
}

function snapshotBlobPath(harnessDir: string, id: string): string {
  return join(harnessDir, 'snapshots', id.slice(0, 2), `${id.slice(2)}.json`);
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function transcriptWithVersion(version: string): string {
  return jsonl(
    { type: 'user', isSidechain: false, version, message: { role: 'user', content: [] } },
    {
      type: 'assistant',
      isSidechain: false,
      version,
      message: {
        model: 'claude-opus-4-7',
        usage: { input_tokens: 5, output_tokens: 30 },
        content: [],
      },
    },
  );
}

describe('W12.7 + W12.8 — snapshot blob immutability under ingestion', () => {
  test('W12.7 — pre-v0.5 snapshot (no claudeCodeVersion) is byte-identical after ingest', () => {
    const repo = freshRepo();
    try {
      // Observe a pre-v0.5-shaped snapshot: model + permissionMode set,
      // claudeCodeVersion DELIBERATELY OMITTED (mimicking what a v0.4.x
      // hook against Claude Code 2.1.128 would write).
      const snapId = repo.observe({
        sessionId: SID,
        eventKind: 'session_start',
        source: 'startup',
        model: 'claude-opus-4-7',
        permissionMode: 'plan',
        // claudeCodeVersion intentionally NOT passed
        now: NOW_OBSERVE,
      });
      const harnessDir = harnessDirOf(repo);
      const blobPath = snapshotBlobPath(harnessDir, snapId);
      const before = hashFile(blobPath);
      const sizeBefore = statSync(blobPath).size;

      // Sanity: the snapshot blob has NO claudeCodeVersion key.
      const blob = JSON.parse(readFileSync(blobPath, 'utf-8'));
      expect('claudeCodeVersion' in blob).toBe(false);

      // Now ingest a transcript that DOES carry a version. Per §10.7
      // the ingester must not write back to the snapshot.
      const txDir = mkdtempSync(join(tmpdir(), 'w12_7-tx-'));
      const txPath = join(txDir, 'transcript.jsonl');
      writeFileSync(txPath, transcriptWithVersion('2.1.131'), 'utf-8');
      repo.ingestSession({ sessionId: SID, transcriptPath: txPath, now: NOW_INGEST });

      const after = hashFile(blobPath);
      const sizeAfter = statSync(blobPath).size;
      expect(after).toBe(before);
      expect(sizeAfter).toBe(sizeBefore);

      // Re-read and assert the field is STILL absent (no upgrade,
      // no auto-fill, no whisper of mutation).
      const blobAfter = JSON.parse(readFileSync(blobPath, 'utf-8'));
      expect('claudeCodeVersion' in blobAfter).toBe(false);

      // turn_metrics did get the rows (control: ingestion ran).
      expect(repo.turnsOf(SID)).toHaveLength(2);
    } finally {
      repo.close();
    }
  });

  test('W12.8 — v0.5+ snapshot (claudeCodeVersion populated) is byte-identical after ingest', () => {
    const repo = freshRepo();
    try {
      // Observe a v0.5-shaped snapshot: claudeCodeVersion populated by
      // the hook at first fire.
      const snapId = repo.observe({
        sessionId: SID,
        eventKind: 'session_start',
        source: 'startup',
        model: 'claude-opus-4-7',
        permissionMode: 'plan',
        claudeCodeVersion: '2.1.131',
        now: NOW_OBSERVE,
      });
      const harnessDir = harnessDirOf(repo);
      const blobPath = snapshotBlobPath(harnessDir, snapId);
      const before = hashFile(blobPath);
      const sizeBefore = statSync(blobPath).size;

      const blob = JSON.parse(readFileSync(blobPath, 'utf-8'));
      expect(blob.claudeCodeVersion).toBe('2.1.131');

      // Ingest a transcript that reports a DIFFERENT (newer) version
      // — a real-world scenario after Claude Code auto-updated mid-
      // session. First-observation-wins doctrine: the snapshot must
      // NOT be rewritten to '2.1.140'.
      const txDir = mkdtempSync(join(tmpdir(), 'w12_8-tx-'));
      const txPath = join(txDir, 'transcript.jsonl');
      writeFileSync(txPath, transcriptWithVersion('2.1.140'), 'utf-8');
      repo.ingestSession({ sessionId: SID, transcriptPath: txPath, now: NOW_INGEST });

      const after = hashFile(blobPath);
      const sizeAfter = statSync(blobPath).size;
      expect(after).toBe(before);
      expect(sizeAfter).toBe(sizeBefore);

      const blobAfter = JSON.parse(readFileSync(blobPath, 'utf-8'));
      expect(blobAfter.claudeCodeVersion).toBe('2.1.131');

      expect(repo.turnsOf(SID)).toHaveLength(2);

      // Cross-check: sessionCost reports the snapshot's locked
      // version (2.1.131), NOT the JSONL's per-turn 2.1.140. The
      // snapshot is the immutable auditable source.
      const cost = repo.sessionCost(SID)!;
      expect(cost.claudeCodeVersion).toBe('2.1.131');
    } finally {
      repo.close();
    }
  });

  test('repeated ingest passes do not modify snapshot bytes', () => {
    // Belt-and-suspenders against a hypothetical "lazy-update" bug
    // where the FIRST ingest is a no-op but a SECOND ingest reaches
    // back to fix something.
    const repo = freshRepo();
    try {
      const snapId = repo.observe({
        sessionId: SID,
        eventKind: 'session_start',
        source: 'startup',
        claudeCodeVersion: '2.1.131',
        now: NOW_OBSERVE,
      });
      const blobPath = snapshotBlobPath(harnessDirOf(repo), snapId);
      const before = hashFile(blobPath);

      const txDir = mkdtempSync(join(tmpdir(), 'w12_imm_repeat-'));
      const txPath = join(txDir, 'transcript.jsonl');
      writeFileSync(txPath, transcriptWithVersion('2.1.131'), 'utf-8');
      for (let i = 0; i < 5; i++) {
        repo.ingestSession({ sessionId: SID, transcriptPath: txPath, now: NOW_INGEST });
      }
      expect(hashFile(blobPath)).toBe(before);
    } finally {
      repo.close();
    }
  });
});
