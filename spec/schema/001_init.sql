-- .harness lineage index — schema v1.
--
-- This file is the CANONICAL schema definition for `.harness/lineage.sqlite`.
-- Conforming implementations MUST execute these statements verbatim when
-- initializing a new index or migrating from no schema. Paraphrasing in code
-- is non-conforming; load this file as a string and execute it.
--
-- The index is fully derivable from the snapshot blobs in `.harness/snapshots/`
-- via a `harness reindex` operation. Two implementations operating on the same
-- snapshot set MUST produce byte-identical SQLite contents at this schema
-- version, except for the `_meta` table (writer-stamped, non-normative).
--
-- All `id` columns hold the 40-char lowercase-hex content-addressable id
-- defined in format.md §3.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Schema metadata
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE _schema (
  version INTEGER PRIMARY KEY
);
INSERT INTO _schema (version) VALUES (1);

CREATE TABLE _meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Writers stamp _meta on init/reindex. Keys defined by spec:
--   format_version  — matches format.md version, e.g. "0.1"
--   created_by      — writer identifier, e.g. "harness-cli/0.1.0"
--   created_at      — ISO 8601 UTC, when this SQLite file was (re)built
--   reindexed_at    — ISO 8601 UTC, last `harness reindex` time (optional)
-- Non-normative for content equivalence between implementations.

-- ─────────────────────────────────────────────────────────────────────────────
-- Snapshots — the DAG nodes
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE snapshots (
  id              TEXT PRIMARY KEY,            -- 40-char lowercase hex
  branch          TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('init','edit','auto','fork','tag')),
  message         TEXT NOT NULL,
  version         TEXT,                         -- e.g. "v0.4", null when not a tag
  code_pin        TEXT,                         -- 40-char hex git sha, or null
  apm_lock_hash   TEXT,                         -- "sha256:..." or null
  session_id      TEXT,                         -- present on `auto` kind
  author          TEXT,
  created_at      TEXT NOT NULL,                -- ISO 8601 UTC, ms precision
  format_version  TEXT NOT NULL DEFAULT '0.1', -- copy of blob.formatVersion
  -- Session-level context from the SessionStart hook stdin payload (format.md §2.1).
  -- Both are optional; pre-amendment blobs and non-hook writers leave them null.
  model           TEXT,
  permission_mode TEXT
);

CREATE INDEX idx_snapshots_branch       ON snapshots(branch);
CREATE INDEX idx_snapshots_created_at   ON snapshots(created_at);
CREATE INDEX idx_snapshots_kind         ON snapshots(kind);
CREATE INDEX idx_snapshots_session_id   ON snapshots(session_id);
CREATE INDEX idx_snapshots_apm_lock     ON snapshots(apm_lock_hash);

-- Parent edges. A row per (child, parent). Init snapshots have zero rows;
-- normal snapshots have one; merge snapshots (reserved, not produced in v0.1)
-- have two. `parent_index` preserves the order of `parentIds[]` in the blob.
CREATE TABLE snapshot_parents (
  child_id     TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  parent_id    TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  parent_index INTEGER NOT NULL CHECK (parent_index >= 0 AND parent_index < 2),
  PRIMARY KEY (child_id, parent_index)
);

CREATE INDEX idx_snapshot_parents_parent ON snapshot_parents(parent_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Snapshot modules — the captured composition
-- ─────────────────────────────────────────────────────────────────────────────

-- One row per module entry per snapshot. `position` preserves the original
-- order of the `modules[]` array in the blob (significant for diffability).
CREATE TABLE snapshot_modules (
  snapshot_id            TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  position               INTEGER NOT NULL,
  type                   TEXT NOT NULL,        -- canonical type per format.md §2.2
  name                   TEXT NOT NULL,
  version                TEXT,
  enabled                INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  config_hash            TEXT,                  -- "sha256:..." or null
  -- Mirrors the JSON Schema pattern `^x-[A-Za-z0-9._-]+$` for the
  -- forward-compat extension namespace. The two constraints below
  -- (LIKE for "x- followed by ≥1 char", NOT GLOB for "no chars outside
  -- the allowed class anywhere") combine to reject empty (`x-`) and
  -- mis-charactered (`x-foo!bar`, `x-foo bar`) extensions, keeping the
  -- SQL CHECK and JSON Schema in lockstep.
  source_kind            TEXT NOT NULL CHECK (
    source_kind IN ('apm','local','user','builtin')
    OR (
      source_kind LIKE 'x-_%'
      AND source_kind NOT GLOB '*[^A-Za-z0-9._-]*'
    )
  ),
  source_package         TEXT,                  -- apm only
  source_resolved_commit TEXT,                  -- apm only, 40-char hex
  source_depth           INTEGER,               -- apm only
  source_resolved_by     TEXT,                  -- apm only, parent package name
  source_path            TEXT,                  -- local only, repo-relative POSIX path
  PRIMARY KEY (snapshot_id, position)
);

CREATE INDEX idx_snapshot_modules_type           ON snapshot_modules(type, name);
CREATE INDEX idx_snapshot_modules_apm_origin     ON snapshot_modules(source_kind, source_package, source_resolved_commit);
CREATE INDEX idx_snapshot_modules_local_path     ON snapshot_modules(source_kind, source_path);

-- ─────────────────────────────────────────────────────────────────────────────
-- Sessions — recorded runs that pinned a snapshot
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,             -- session id (e.g. "sess-187"); writer-defined
  snapshot_id     TEXT NOT NULL REFERENCES snapshots(id) ON DELETE RESTRICT,
  started_at      TEXT NOT NULL,                -- ISO 8601 UTC
  ended_at        TEXT,                         -- ISO 8601 UTC, null if running
  status          TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','warn','fail')),
  message         TEXT,                         -- one-line summary from session
  files_touched   INTEGER NOT NULL DEFAULT 0,
  pr              TEXT,
  author          TEXT,
  transcript_path TEXT                          -- relative path under .harness/transcripts/, optional
);

CREATE INDEX idx_sessions_snapshot   ON sessions(snapshot_id);
CREATE INDEX idx_sessions_started_at ON sessions(started_at);
CREATE INDEX idx_sessions_status     ON sessions(status);

-- Per-session module usage — which modules were actually touched at runtime.
-- Distinct from snapshot_modules (which is composition); this is observed use.
CREATE TABLE session_usage (
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  name        TEXT NOT NULL,
  invocations INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, type, name)
);

CREATE INDEX idx_session_usage_module ON session_usage(type, name);

-- Tool calls — fine-grained log within a session. Writers MAY populate this
-- from session transcripts; not required at v0.1.
CREATE TABLE tool_calls (
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,               -- 0-based order within session
  at            TEXT NOT NULL,                  -- ISO 8601 UTC
  module_type   TEXT NOT NULL,                  -- canonical type
  module_name   TEXT NOT NULL,
  ok            INTEGER NOT NULL DEFAULT 1 CHECK (ok IN (0,1)),
  duration_ms   INTEGER,
  summary       TEXT,
  PRIMARY KEY (session_id, seq)
);

CREATE INDEX idx_tool_calls_module ON tool_calls(module_type, module_name);
CREATE INDEX idx_tool_calls_at     ON tool_calls(at);
