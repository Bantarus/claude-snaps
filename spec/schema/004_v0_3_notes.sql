-- .harness lineage index — schema v4 migration (v0.3.0 notes-as-events).
--
-- Apply AFTER 003_session_observation_cache.sql. The runner skips this
-- file when `_schema.version >= 4`.
--
-- Spec references:
--   - format.md §2.1  — Snapshot blob shape (message removed)
--   - format.md §2.2  — kind enum renamed manual → auto
--   - format.md §2.7  — attribution events with note_text
--   - format.md §5.4  — attribution semantics (note_text invariant)
--   - format.md §9.1  — major bump from 0.2.x to 0.3.0
--   - format.md §9.6  — no automated v0.2.x → v0.3.0 data migration
--
-- Structural changes from schema v3:
--   * REMOVED: `snapshots.message` column. v0.3 snapshots have no
--     free-form text; user annotations are first-class attribution
--     events (`note` kind below). Any data in this column is dropped
--     by the migration — see §9.6 for the deliberate choice not to
--     synthesize note events from prior message values.
--   * CHANGED: `snapshots.kind` CHECK constraint — `init|auto|tag`
--     (was `init|manual|tag`). Existing rows are mapped: `manual` →
--     `auto`; `init` and `tag` unchanged. (Note: v0.2 stored these
--     as 'manual'; v0.3 uses 'auto' for the same semantic, see §2.2.)
--   * CHANGED: `snapshots.format_version` default → '0.3'; existing
--     rows are rewritten to '0.3'. Snapshot blob ids on disk DO NOT
--     match the rewritten rows because the canonical bytes differ
--     (no message field). The blobs themselves are not re-canonicalized
--     by this migration — that's outside the SQL layer's responsibility,
--     and per §9.6 there is no automated TS migrator either. A v0.2
--     `.harness/` that runs only this SQL ends up internally
--     inconsistent and SHOULD be discarded; the supported path is
--     `harness init` from scratch.
--   * NEW: `attributions.note_text` column (TEXT, nullable). Non-null
--     iff `event_kind = 'note'`. Enforced by CHECK; writers MUST also
--     enforce in code (§2.7).
--   * CHANGED: `attributions.event_kind` CHECK — accepts
--     `('session_start','user_prompt','manual_capture','note','migrated')`.
--     Renamed `manual_snap` → `manual_capture` (existing rows mapped).
--     Added `note`. `migrated` retained for forward-compat in the enum
--     but no v0.3 writer emits it.

PRAGMA foreign_keys = OFF;

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- Rebuild `snapshots` to drop `message` and update kind CHECK.
-- SQLite has no ALTER TABLE for CHECK changes or column drops; the
-- canonical recipe is the rebuild-and-rename per
-- https://sqlite.org/lang_altertable.html#otheralter.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE snapshots_new (
  id              TEXT PRIMARY KEY,
  branch          TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('init','auto','tag')),
  version         TEXT,
  code_pin        TEXT,
  apm_lock_hash   TEXT,
  author          TEXT,
  created_at      TEXT NOT NULL,
  format_version  TEXT NOT NULL DEFAULT '0.3',
  model           TEXT,
  permission_mode TEXT
);

INSERT INTO snapshots_new
  (id, branch, kind, version, code_pin, apm_lock_hash,
   author, created_at, format_version, model, permission_mode)
SELECT
   id,
   branch,
   CASE kind WHEN 'manual' THEN 'auto' ELSE kind END,
   version,
   code_pin,
   apm_lock_hash,
   author,
   created_at,
   '0.3',
   model,
   permission_mode
FROM snapshots;

DROP INDEX IF EXISTS idx_snapshots_branch;
DROP INDEX IF EXISTS idx_snapshots_created_at;
DROP INDEX IF EXISTS idx_snapshots_kind;
DROP INDEX IF EXISTS idx_snapshots_apm_lock;

DROP TABLE snapshots;
ALTER TABLE snapshots_new RENAME TO snapshots;

CREATE INDEX idx_snapshots_branch     ON snapshots(branch);
CREATE INDEX idx_snapshots_created_at ON snapshots(created_at);
CREATE INDEX idx_snapshots_kind       ON snapshots(kind);
CREATE INDEX idx_snapshots_apm_lock   ON snapshots(apm_lock_hash);

-- ─────────────────────────────────────────────────────────────────────
-- Rebuild `attributions` to add note_text + invariant + new event_kind
-- enum. Same SQLite rebuild dance.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE attributions_new (
  session_id  TEXT NOT NULL,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE RESTRICT,
  observed_at TEXT NOT NULL,
  event_kind  TEXT NOT NULL CHECK (event_kind IN
    ('session_start','user_prompt','manual_capture','note','migrated')),
  source      TEXT,
  note_text   TEXT,
  PRIMARY KEY (session_id, observed_at, event_kind),
  CHECK (
    (event_kind = 'note' AND note_text IS NOT NULL)
    OR (event_kind != 'note' AND note_text IS NULL)
  )
);

INSERT INTO attributions_new
  (session_id, snapshot_id, observed_at, event_kind, source, note_text)
SELECT
   session_id,
   snapshot_id,
   observed_at,
   CASE event_kind WHEN 'manual_snap' THEN 'manual_capture' ELSE event_kind END,
   source,
   NULL
FROM attributions;

DROP INDEX IF EXISTS idx_attributions_session;
DROP INDEX IF EXISTS idx_attributions_snapshot;

DROP TABLE attributions;
ALTER TABLE attributions_new RENAME TO attributions;

CREATE INDEX idx_attributions_session  ON attributions(session_id, observed_at);
CREATE INDEX idx_attributions_snapshot ON attributions(snapshot_id);

-- ─────────────────────────────────────────────────────────────────────
-- Bump schema version. Verify FK integrity before commit.
-- ─────────────────────────────────────────────────────────────────────

UPDATE _schema SET version = 4;

PRAGMA foreign_key_check;

COMMIT;

PRAGMA foreign_keys = ON;
