-- .harness lineage index — schema v6 migration (v0.4.0 reproducer prereq).
--
-- Apply AFTER 005_drop_tag_kind.sql. The runner skips this file when
-- `_schema.version >= 6`.
--
-- Spec references:
--   - format.md §2.1   — `apmLockfile` optional top-level field
--   - format.md §6.1   — reproducer contract (uses apm_lockfile content)
--   - format.md §9.1   — minor bump from v0.3.1 to v0.4.0
--   - format.md §9.8   — full v0.3.1 → v0.4.0 transition narrative
--
-- Structural changes from schema v5:
--   * ADDED: `snapshots.apm_lockfile` column (TEXT, nullable). Mirrors
--     the optional top-level `apmLockfile` field in the JSON blob.
--     Stores the verbatim text of `apm.lock.yaml` at capture time so
--     `harness reproduce` can drive `apm install --frozen` against the
--     recorded lockfile without depending on the project's git state.
--
-- This is a pure additive change. No existing column shapes change; no
-- rows are rewritten. v0.3.x rows remain valid with `apm_lockfile = NULL`.

BEGIN;

ALTER TABLE snapshots ADD COLUMN apm_lockfile TEXT;

UPDATE _schema SET version = 6;

COMMIT;
