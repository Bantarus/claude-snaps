-- .harness lineage index — schema v3 (session observation cache).
--
-- Apply AFTER 002_v0_2_decoupling.sql. The runner skips this file when
-- _schema.version >= 3.
--
-- Adds the session_observation_cache table — implementation-internal
-- state used by harness-hook's hot-path optimization. NOT a normative
-- spec artifact: a conforming reader/writer is not required to
-- maintain this table, and a future implementation MAY use a different
-- mechanism. The table is fully reconstructible (drop it, no data
-- loss; the next hook fire repopulates).
--
-- Stored: per-session (last fast-hash, last snapshot id observed).
-- The hook reads this on each fire to decide whether the .claude/
-- composition has changed since the previous fire in this session.
-- A cache hit skips the full filesystem walk + canonicalization; a
-- miss falls through to repo.observe() which writes the canonical
-- attribution row and updates the cache.

PRAGMA foreign_keys = OFF;

BEGIN;

CREATE TABLE session_observation_cache (
  session_id  TEXT PRIMARY KEY,
  fast_hash   TEXT NOT NULL,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  written_at  TEXT NOT NULL
);
-- No additional indexes; PK on session_id covers the only query pattern.

UPDATE _schema SET version = 3;

COMMIT;

PRAGMA foreign_keys = ON;
