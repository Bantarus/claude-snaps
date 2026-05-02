-- .harness lineage index — schema v2 migration (v0.2.0 decoupling).
--
-- Apply AFTER 001_init.sql. Conforming implementations MUST execute
-- these statements verbatim against a v1 database; the runner is
-- responsible for skipping this script when `_schema.version >= 2`.
--
-- Spec references:
--   - format.md §2.7  — attribution events
--   - format.md §5.4  — attribution table semantics
--   - format.md §9.5  — migration from v0.1.x → v0.2.0
--
-- Structural changes from schema v1:
--   * NEW: `attributions` table (append-only event log) plus indexes.
--   * REMOVED: `snapshots.session_id` column and its index.
--   * CHANGED: `snapshots.kind` CHECK constraint — `init|manual|tag`
--     (was `init|edit|auto|fork|tag`). Existing rows are mapped:
--     `auto` / `edit` / `fork` → `manual`; `init` and `tag` unchanged.
--   * CHANGED: `snapshots.message` becomes nullable.
--   * CHANGED: `snapshots.format_version` default → '0.2'; existing
--     rows are rewritten to '0.2' (the migration is one-way per §9.5).
--
-- The accompanying TS migration tool (`harness migrate`) performs the
-- snapshot-blob re-canonicalization and deduplication described in
-- §9.5. This SQL file is responsible only for schema reshape and
-- attribution-event backfill.

PRAGMA foreign_keys = OFF;

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- New table: attribution events
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE attributions (
  session_id  TEXT NOT NULL,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE RESTRICT,
  observed_at TEXT NOT NULL,                -- ISO 8601 UTC, ms precision
  event_kind  TEXT NOT NULL CHECK (event_kind IN
    ('session_start','user_prompt','manual_snap','migrated')),
  source      TEXT,                          -- 'startup'/'resume'/'clear'/'compact' for session_start; null otherwise
  PRIMARY KEY (session_id, observed_at, event_kind)
);

CREATE INDEX idx_attributions_session  ON attributions(session_id, observed_at);
CREATE INDEX idx_attributions_snapshot ON attributions(snapshot_id);

-- Backfill: every v0.1.x snapshot that carried a session_id becomes
-- one `migrated` attribution row. `observed_at` uses the snapshot's
-- `created_at` because that's the only timestamp we have. Sessions
-- with no v0.1.x snapshot (i.e. that were not captured at all) are
-- not recoverable — see §9.5 lossiness clause.
INSERT INTO attributions (session_id, snapshot_id, observed_at, event_kind, source)
  SELECT session_id, id, created_at, 'migrated', NULL
    FROM snapshots
   WHERE session_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────
-- Rebuild `snapshots` to drop session_id and update kind CHECK.
-- SQLite has no ALTER TABLE for CHECK changes; the canonical recipe is
-- the 12-step rebuild-and-rename per
-- https://sqlite.org/lang_altertable.html#otheralter.
--
-- ON DELETE RESTRICT for attributions.snapshot_id intentionally rejects
-- accidental snapshot deletes — attributions outlive their snapshot's
-- v0.1.x lifecycle and reattaching them on dedup is the migrator's job
-- (see harness migrate, step 6).
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE snapshots_new (
  id              TEXT PRIMARY KEY,
  branch          TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('init','manual','tag')),
  message         TEXT,                          -- nullable in v0.2.0
  version         TEXT,
  code_pin        TEXT,
  apm_lock_hash   TEXT,
  author          TEXT,
  created_at      TEXT NOT NULL,
  format_version  TEXT NOT NULL DEFAULT '0.2',
  model           TEXT,
  permission_mode TEXT
);

INSERT INTO snapshots_new
  (id, branch, kind, message, version, code_pin, apm_lock_hash,
   author, created_at, format_version, model, permission_mode)
SELECT
   id,
   branch,
   CASE kind
     WHEN 'auto' THEN 'manual'
     WHEN 'edit' THEN 'manual'
     WHEN 'fork' THEN 'manual'
     ELSE kind
   END,
   message,
   version,
   code_pin,
   apm_lock_hash,
   author,
   created_at,
   '0.2',
   model,
   permission_mode
FROM snapshots;

DROP INDEX IF EXISTS idx_snapshots_branch;
DROP INDEX IF EXISTS idx_snapshots_created_at;
DROP INDEX IF EXISTS idx_snapshots_kind;
DROP INDEX IF EXISTS idx_snapshots_session_id;
DROP INDEX IF EXISTS idx_snapshots_apm_lock;

DROP TABLE snapshots;
ALTER TABLE snapshots_new RENAME TO snapshots;

CREATE INDEX idx_snapshots_branch     ON snapshots(branch);
CREATE INDEX idx_snapshots_created_at ON snapshots(created_at);
CREATE INDEX idx_snapshots_kind       ON snapshots(kind);
CREATE INDEX idx_snapshots_apm_lock   ON snapshots(apm_lock_hash);

-- ─────────────────────────────────────────────────────────────────────
-- Bump schema version. Verify FK integrity before commit.
-- ─────────────────────────────────────────────────────────────────────

UPDATE _schema SET version = 2;

-- foreign_key_check raises if any FK is violated. With the rebuild,
-- snapshot_parents and snapshot_modules still reference snapshots(id)
-- — those rows survived because we copied id verbatim.
PRAGMA foreign_key_check;

COMMIT;

PRAGMA foreign_keys = ON;
