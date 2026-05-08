-- .harness lineage index — schema v7 migration (v0.5.0 session metrics).
--
-- Apply AFTER 006_apm_lockfile.sql. The runner skips this file when
-- `_schema.version >= 7`.
--
-- Spec references:
--   - format.md §2.1   — `claudeCodeVersion` optional top-level field
--   - format.md §3.1   — `claudeCodeVersion` excluded from canonical bytes
--   - format.md §9.9   — full v0.4.x → v0.5.0 transition narrative
--   - format.md §10    — Session metrics (turn_metrics shape, normative
--                        redaction whitelist, idempotency, snapshot
--                        immutability invariant)
--
-- Structural changes from schema v6:
--   1. ADDED: `snapshots.claude_code_version` column (TEXT, nullable).
--      Mirrors the optional top-level `claudeCodeVersion` field in
--      the JSON blob. First-observation-wins per format.md §2.1 —
--      Claude Code auto-updates between turns, so a long session can
--      span multiple versions; the snapshot pins the value at first
--      hook fire.
--   2. ADDED: `turn_metrics` table (without rowid). Per format.md §10.1.
--      One row per JSONL transcript line of type 'user' or 'assistant'.
--      Populated post-hoc by `harness ingest-session`; the hot-path hook
--      does NOT write here. Idempotent on (session_id, turn_index).
--   3. ADDED: indices on turn_metrics.session_id (point-lookup) and
--      turn_metrics.model (partial index, NULL skipped — user turns).
--
-- This is a pure additive change. No existing column shapes change; no
-- rows are rewritten. v0.4.x rows remain valid with
-- `claude_code_version = NULL`. The turn_metrics table starts empty and
-- is only populated by explicit `harness ingest-session` invocations.

BEGIN;

ALTER TABLE snapshots ADD COLUMN claude_code_version TEXT;

CREATE TABLE turn_metrics (
  session_id                  TEXT    NOT NULL,
  turn_index                  INTEGER NOT NULL,
  turn_type                   TEXT    NOT NULL CHECK (turn_type IN ('user', 'assistant')),
  model                       TEXT,
  input_tokens                INTEGER,
  output_tokens               INTEGER,
  cache_creation_input_tokens INTEGER,
  cache_read_input_tokens     INTEGER,
  tool_names_csv              TEXT,
  is_sidechain                INTEGER NOT NULL CHECK (is_sidechain IN (0, 1)),
  attribution_skill           TEXT,
  ingested_at                 TEXT    NOT NULL,
  request_id                  TEXT,
  PRIMARY KEY (session_id, turn_index)
) WITHOUT ROWID;

CREATE INDEX idx_turn_metrics_session ON turn_metrics(session_id);
CREATE INDEX idx_turn_metrics_model   ON turn_metrics(model)
  WHERE model IS NOT NULL;

UPDATE _schema SET version = 7;

COMMIT;
