# Implementation prompt: session metrics + transcript ingestion (v0.5.0)

> Hand this to a fresh Claude Code session against this monorepo. The
> session has no prior context; everything load-bearing is captured
> here or referenced inline.

## Goal

Capture per-session economics — model used per turn, token consumption,
tool/MCP calls, Claude Code version — by ingesting the per-session
JSONL transcript Claude Code already writes. Surface these as
queryable harness data without violating snapshot immutability,
without storing prompt content, and without bolting work onto the
hot-path hook.

This is v0.5.0 — minor bump. New data model fields, one new
SQLite table, one new CLI command, one snapshot blob field
(`claudeCodeVersion`). Forward-compatible with v0.4.x snapshots
(missing fields → null; ingestion is opt-in and post-hoc).

## Hard pins (do NOT relitigate)

These were settled in the design conversation that produced this
prompt. They shape implementation; they're not up for discussion.

1. **Snapshots stay composition-only.** Per the conversation
   discipline (see `memory/feedback_snapshots_compose_not_events.md`
   in CLAUDE_PROJECT_DIR), snapshots represent composition, not
   events. Tokens, tool calls, and per-turn dynamics do NOT go on
   snapshot blobs. They go on attribution rows or a new
   `turn_metrics` table. The single new snapshot field
   (`claudeCodeVersion`) is justified ONLY because it's host
   identity — first-observation-wins, like `model` and
   `permissionMode` in v0.4.2.

2. **Snapshot immutability is sacred.** First-observation-wins per
   spec/format.md §2.1. The ingester does NOT update existing
   snapshot fields. If a session's first hook fire wrote
   `claudeCodeVersion = "2.1.131"` and the user upgrades mid-session,
   the snapshot stays at 2.1.131. Period.

3. **Prompt content is NEVER stored.** Per the v0.4.2
   conversation: `prompt` field on UserPromptSubmit is
   observed-and-ignored. Reading `transcript_path` for metadata is
   permitted; copying ANY prompt text, tool input, tool result,
   thinking content, or system prompt to harness storage is forbidden.
   The ingester's redaction whitelist is normative (see §"Privacy
   boundary").

4. **Ingestion is post-hoc and async.** The hot-path hook stays as-is
   (spec/hooks.md §2.4). Transcript ingestion runs as a separate
   command (`harness ingest-session`) invoked manually OR by an
   optional SessionEnd hook (if Claude Code emits one — verify in
   step 1; if not, defer auto-ingestion to v0.5.x). Hook latency
   budget is unaffected.

5. **No automated v0.4 → v0.5 migration.** Per the project's standing
   rule (`memory/feedback_no_v2_to_v3_migration.md`): default to
   "no migrator". v0.4.x snapshots remain readable; the new fields
   are null on them. A schema migration adds the `turn_metrics`
   table and the new attribution columns, but produces no data for
   pre-v0.5 sessions.

6. **Per-tool token attribution is impossible.** Tokens are recorded
   per assistant turn in the JSONL. A single turn can invoke multiple
   tools; the `usage` block sums across them. The data model records
   tool names per turn alongside per-turn tokens — queries can do
   "sessions that touched tool X" and "tokens for those sessions" but
   NOT "tokens spent on tool X." Document this limitation explicitly
   in the spec; do not invent estimation heuristics.

7. **APM remains a hard prereq for `harness reproduce` content.** No
   change to the v0.4.0 contract. This work is orthogonal.

8. **Reading transcript_path is a NEW capability.** Until v0.5.0 the
   hook ignores it (spec/hooks.md §1.1 v0.4.2 amendment). v0.5.0
   adds a deliberate, narrowly-scoped reader. Update spec/hooks.md
   §1.1 to note the new consumer.

## The success criterion

After this work lands, the following must work end-to-end:

```bash
# A session has run; transcript exists at ~/.claude/projects/<dir>/<sid>.jsonl
$ harness ingest-session <session-id-uuid>
Ingested 47 turns from session 1fc2730f-1903-4bbc-8ddf-84ef65e5fe96
  user turns: 12, assistant turns: 35
  models: claude-opus-4-7 (35)
  total tokens: 1.2M input (cache-read), 24K output, 41K cache-creation
  tools: Bash×135, Edit×33, Write×27, Read×23, TodoWrite×22, ToolSearch×1, Agent×1
  Claude Code version observed: 2.1.131

$ harness session-cost <session-id-uuid>
Session 1fc2730f-1903-4bbc-8ddf-84ef65e5fe96
  Turns:                47 (12 user / 35 assistant)
  Models:               claude-opus-4-7
  Input tokens (live):  24,308
  Cache read:           1,224,847
  Cache creation:       41,221
  Output tokens:        24,116
  Tools called:         {Bash: 135, Edit: 33, Write: 27, Read: 23, TodoWrite: 22, ToolSearch: 1, Agent: 1}
  Claude Code version:  2.1.131

$ harness session-cost <session-id> --by-tool
Bash       135 calls across 23 turns (24% of turns)
Edit        33 calls across 18 turns (51% of assistant turns hit Edit)
Write       27 calls across 19 turns
[...]
# (No per-tool token columns — see hard pin #6.)

$ harness session-cost --all --by-model
claude-opus-4-7    47 sessions   23.4M tokens total
claude-haiku-4-5    3 sessions   180K tokens total

$ harness ingest-session --all
Ingested 12 sessions from /home/.../-home-bantarus-DEV-claude-snaps/
  Skipped: 4 sessions already at latest turn_index (idempotent)
  Updated: 8 sessions with new turns since last ingest
```

The ingester is **idempotent**: re-running on the same JSONL after
new turns appended produces only the new rows. Re-running on an
unchanged JSONL produces zero new rows.

## File layout

```
spec/
├── format.md                         ← amend §2.1 + new §10 "Session metrics"
├── hooks.md                          ← amend §1.1 (note transcript_path now read)
└── schema/007_session_metrics.sql    ← NEW: turn_metrics + attribution columns

packages/core/src/
├── ingest.ts                         ← NEW: JSONL parser + redaction
├── types.ts                          ← + TurnMetric, SessionCostSummary
├── repo.ts                           ← + ingestSession, sessionCost queries
├── canonical.ts                      ← (unchanged: claudeCodeVersion is in EXCLUDED list)
├── capture.ts                        ← read claudeCodeVersion at first hook fire
└── index_db.ts                       ← + turn_metrics table + indices

packages/cli/src/commands/
├── ingest_session.ts                 ← NEW: harness ingest-session
└── session_cost.ts                   ← NEW: harness session-cost

packages/core/test/
├── ingest.test.ts                    ← NEW: parser, redaction fuzz, idempotence
└── session_cost.test.ts              ← NEW: query shape

scripts/dogfood-v0_4/cases/
└── w12_session_metrics.sh            ← NEW: synthesized JSONL ingestion cases

scripts/dogfood-v0_4/local_cases/
└── l2_session_metrics.sh             ← NEW: real claude -p + ingest end-to-end
```

## Spec amendments

### `spec/format.md` §2.1 — add `claudeCodeVersion`

Add a new optional snapshot field next to `model` / `permissionMode`:

| Field | Type | Notes |
|---|---|---|
| `claudeCodeVersion` | string \| `null` | Claude Code CLI version observed at the snapshot's first hook fire (e.g. `"2.1.131"`). Source: `version` field in `transcript_path` JSONL (canonical, per-turn) OR shelled out from `claude --version` if no transcript is readable. First-observation-wins per the same doctrine as `model` / `permissionMode`. Optional; pre-v0.5 snapshots and non-hook writers omit it. |

Update the EXCLUDED_FIELDS list in `canonical.ts` to include
`claudeCodeVersion` (host context, not composition; doesn't
participate in `id` derivation).

### `spec/format.md` new §10 — Session metrics

```
## 10. Session metrics (v0.5.0+)

Per-session economic data captured by `harness ingest-session` from
the host's `transcript_path` JSONL. Stored in `lineage.sqlite` only;
NOT in snapshot blobs (per §2 immutability + §2.1 composition-only).

### 10.1 turn_metrics table

PRIMARY KEY (session_id, turn_index). Each row is one JSONL turn.

  session_id                  TEXT NOT NULL    UUID matching attribution.session_id
  turn_index                  INTEGER NOT NULL 0-based, in JSONL line order
  turn_type                   TEXT NOT NULL    'user' | 'assistant'
  model                       TEXT             NULL on user turns
  input_tokens                INTEGER          assistant turns only
  output_tokens               INTEGER          assistant turns only
  cache_creation_input_tokens INTEGER          assistant turns only
  cache_read_input_tokens     INTEGER          assistant turns only
  tool_names_csv              TEXT             comma-separated; assistant turns only
  is_sidechain                INTEGER (0|1)    1 if subagent (Task tool); 0 if main
  attribution_skill           TEXT             active skill name if any; else NULL
  ingested_at                 TEXT NOT NULL    ISO 8601 UTC
  request_id                  TEXT             Anthropic request_id for cross-ref

A turn_metrics row's session_id MAY reference a session that has no
attribution rows (sessions captured before harness was wired). Conforming
queries MUST tolerate this.

### 10.2 What is NOT stored

The ingester's redaction whitelist is NORMATIVE. The following JSONL
fields MUST NEVER be copied to harness storage:

- `message.content[*].text` (assistant text response)
- `message.content[*].input` (tool call arguments)
- `message.content[*].tool_use_id` (only the .name is kept)
- Any `tool_result` block (.content)
- User message body of any shape
- `system_prompt`, `append_system_prompt`
- `thinking` blocks (.thinking, .signature)
- Any `attachment` data field

A test gate (Gate W12.5) MUST verify the whitelist holds against a
fuzzed transcript: insert random byte sequences into all forbidden
fields, ingest, then assert NONE of those bytes appear anywhere in
turn_metrics.

### 10.3 Per-tool token attribution

The JSONL `usage` block is per-assistant-turn, not per-tool-call. A
single turn invokes one or more tools; the usage block sums across.
The data model preserves the relationship (`tool_names_csv`) but
CANNOT attribute tokens to individual tool calls. Queries that try
to compute "tokens spent on tool X" are not supportable; document
this limitation in CLI help and the spec.
```

### `spec/hooks.md` §1.1 — note new transcript_path reader

Append to the "Notable absences and asymmetries" subsection:

> v0.5.0 update: `transcript_path` was observed-and-unused through
> v0.4.x. The v0.5.0 `harness ingest-session` command reads the file
> at this path under a strict redaction whitelist (see
> [format.md §10.2](format.md#102-what-is-not-stored)). The hook
> itself still does not read transcript bytes; ingestion is post-hoc
> and asynchronous.

## Schema migration

`spec/schema/007_session_metrics.sql`:

```sql
-- Migration 007: v0.5.0 session metrics
--
-- Adds turn_metrics table for per-turn JSONL ingestion + adds optional
-- claudeCodeVersion column to snapshots. Forward-compatible: existing
-- v0.4.x rows have NULL for the new column; turn_metrics is empty until
-- the first `harness ingest-session` runs.

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
```

Update `scripts/check_schema_agreement.py` to recognize the new column.

## Privacy boundary (load-bearing — read this twice)

The ingester reads JSONL bytes that contain user prompts, tool inputs,
tool results, system prompts, and assistant thinking. ALL of that is
forbidden territory. The implementation discipline:

1. **Whitelist, not blacklist.** The parser extracts ONLY the fields
   in §10.1's table. It does NOT walk the full JSONL object and
   exclude fields; it builds the row from named accesses on a
   parsed dict. If a future JSONL gains new sensitive fields, they're
   automatically excluded by virtue of not being in the whitelist.

2. **Type-tighten at the boundary.** Define a `TurnRecord` type with
   exactly the whitelisted fields. The parser returns
   `TurnRecord | null` (null on parse failure). No `any`, no `unknown`,
   no spread of arbitrary input.

3. **Tool name canonicalization.** Tool names like `mcp__server__tool`
   are kept as-is; they are not user content, they are tool registry
   identifiers. No `tool_use.input` is read or stored.

4. **Required test gate (W12.5).** Generate a JSONL with:
   - User messages containing `SECRET_CANARY_PROMPT_<n>`
   - Tool inputs containing `SECRET_CANARY_INPUT_<n>`
   - Tool results containing `SECRET_CANARY_RESULT_<n>`
   - Thinking blocks containing `SECRET_CANARY_THINK_<n>`
   - System prompts containing `SECRET_CANARY_SYS_<n>`

   Run `harness ingest-session` on it. Then `sqlite3 lineage.sqlite
   "SELECT * FROM turn_metrics"` and grep the entire output for
   any `SECRET_CANARY_`. Zero matches required.

5. **Documentation.** `harness ingest-session --help` MUST state in
   plain English what is and isn't read.

## New CLI surface

### `harness ingest-session`

```
harness ingest-session [<session-id>]
                       [--all]
                       [--since-turn <N>]
                       [--dry-run]

Read the per-session transcript JSONL from
~/.claude/projects/<encoded-cwd>/<session-id>.jsonl and extract
metadata (model, token usage, tool names, Claude Code version) into
.harness/lineage.sqlite. Idempotent: re-running on the same JSONL
produces no new rows.

Privacy: only the whitelisted fields per spec/format.md §10.2 are
read. Prompt text, tool inputs, tool results, system prompts, and
thinking content are never copied.

Args:
  <session-id>    Resolve via the host's session directory or via
                  attribution.session_id. Required unless --all.

Flags:
  --all           Ingest every session referenced by attribution rows
                  in lineage.sqlite for which a transcript exists.
  --since-turn N  Force re-ingestion starting from turn N (default:
                  resume from highest turn_index already stored).
  --dry-run       Parse the JSONL, report counts, write nothing.

Exit codes: 0 success, 1 user error (unknown session, transcript
missing), 2 internal (parse error, schema migration needed).
```

### `harness session-cost`

```
harness session-cost [<session-id>] [--all]
                     [--by-tool] [--by-model]
                     [--branch <name>]

Query turn_metrics. Without a session-id, reports a project-wide
roll-up.

Flags:
  --by-tool       Group by tool name. Lists call counts per tool;
                  does NOT report per-tool tokens (see hard pin #6).
  --by-model      Group by model id. Lists per-model session counts
                  and total tokens.
  --branch        Restrict to sessions whose attribution snapshots
                  are on the given branch.
```

## Test gates

| Gate | What |
|---|---|
| **W12.1** | Ingest a fixture JSONL (5 turns: 2 user, 3 assistant). Verify exactly 5 rows in turn_metrics with correct turn_type, model, usage. |
| **W12.2** | Ingest the same fixture twice. Verify zero new rows on the second pass (idempotent). |
| **W12.3** | Append 2 new turns to the fixture; re-ingest. Verify exactly 2 new rows; existing rows unchanged. |
| **W12.4** | Ingest a fixture with mcp__-prefixed tool calls. Verify tool_names_csv contains `mcp__server__tool` literally. |
| **W12.5** | Privacy whitelist (load-bearing). Generate a fuzzed JSONL with SECRET_CANARY_* in every forbidden field. Ingest. grep ALL of lineage.sqlite for SECRET_CANARY — zero matches. |
| **W12.6** | Ingest a JSONL with `isSidechain: true` rows (subagent). Verify those rows have `is_sidechain = 1`. |
| **W12.7** | Snapshot blob for a session captured pre-v0.5: `claudeCodeVersion = null`. Ingest the session. Snapshot still has `claudeCodeVersion = null` (NOT updated by ingestion — immutability). |
| **W12.8** | Snapshot blob for a session captured at v0.5+: `claudeCodeVersion` populated by capture.ts at first hook fire. Ingestion does not modify it. |
| **W12.9** | `harness session-cost <id>` reports correct totals for a known fixture. |
| **W12.10** | `harness session-cost --by-tool` reports call counts; help text states the per-tool-token limitation. |
| **W12.11** | `harness ingest-session --all` skips sessions without transcript files; reports counts cleanly. |
| **W12.12** | Format-version bump check: snapshots written by v0.5+ writers carry `formatVersion: "0.5"`; readers tolerate v0.4.x snapshots without `claudeCodeVersion`. |

Plus an **L2** local-observe case (real `claude -p` end-to-end):

| L2.1 | Drive a real `claude -p`, locate the resulting JSONL via attribution, ingest it, verify token counts roughly match `claude --output-format json`'s usage report. |

## Order of operations

Each step ends in a verifiable state. Pause and commit between steps.

1. **Verify open questions** (~1 hour). Empirically check:
   - Does Claude Code 2.1.131 emit a `SessionEnd` hook event?
   - What's the canonical path layout for `~/.claude/projects/<encoded>`?
   - Does the JSONL `version` field match `claude --version` exactly,
     or is it a different shape?
   - Are there any other interesting fields in the transcript we
     should surface (e.g., `entrypoint`, `gitBranch`)?

   File findings inline before writing any spec text. Per
   `memory/feedback_spec_vs_reality.md` (4th confirmation, established
   discipline): probe before pinning.

2. **Spec amendments** (~half day). Author §10, amend §2.1 + §1.1.
   Run schema-agreement gate; expect it to fail with the new column;
   fix `check_schema_agreement.py`. Commit.

3. **Schema migration** (~2 hours). Write
   `spec/schema/007_session_metrics.sql`. Update `index_db.ts` to
   apply it. Verify migration runs cleanly on a v0.4.x repo. Commit.

4. **Capture-side: claudeCodeVersion** (~3 hours). Update
   `capture.ts` to read `version` from a recent JSONL turn (cheap;
   one-line read) OR fall back to shelling out to `claude --version`
   (cache result for the lifetime of `.harness/`). Per
   first-observation-wins, this only writes on snapshots that change
   composition; the existing hot-path doesn't update existing
   snapshots. Add unit tests. Commit.

5. **Ingester core** (~1 day). Author `ingest.ts` with the strict
   whitelist parser. Define `TurnRecord` type; parse line-by-line;
   skip non-message lines (queue-operation, attachment, etc.); emit
   one row per `assistant` and `user` line. Idempotency via
   `MAX(turn_index)` lookup before insert. Commit per
   compilation-clean checkpoint.

6. **Privacy fuzz gate** (~half day; CRITICAL). W12.5 first. Generate
   the fuzzed JSONL programmatically; run ingestion; grep the SQLite
   bytes. ZERO tolerance. If any canary leaks, halt and audit the
   parser. Commit only after green.

7. **Other ingestion gates** (~half day). W12.1, W12.2, W12.3, W12.4,
   W12.6 — fixture-driven. Commit.

8. **CLI commands** (~half day). `harness ingest-session` +
   `harness session-cost` with --by-tool, --by-model, --all flags.
   Help text MUST mention privacy whitelist. Commit per command.

9. **Snapshot interaction gates** (~3 hours). W12.7, W12.8 verify
   immutability holds: ingestion never modifies snapshot blobs.
   Commit.

10. **CI playbook integration** (~3 hours). New
    `cases/w12_session_metrics.sh` registers W12.1–W12.12. Run
    `bash scripts/dogfood-v0_4/ci-playbook.sh` and confirm green.
    Update `cip-self-test.sh`'s expected count if it pins one.
    Commit.

11. **Local-observe case** (~3 hours). Author `local_cases/l2_*.sh`
    that drives a real `claude -p`, locates the JSONL via
    attribution + the host's project-dir convention, ingests, and
    asserts the token counts. Confirm via
    `bash scripts/dogfood-v0_4/local-observe.sh --filter '^L2'`.
    Commit.

12. **Format version bump** (~2 hours). v0.4 → v0.5. Update
    `formatVersion` default in writers; update gate scripts; verify
    spec/test-vectors/canonical-501.bin still byte-stable for v0.4
    fixtures, and add a v0.5 test vector. Commit.

13. **Documentation** (~3 hours). README in `packages/cli/` with the
    new commands. Update `scripts/dogfood-v0_4/README.md` to add the
    W12 + L2 entries. Update memory pin with the v0.5.0 milestone
    and the "transcript-reading is now permitted (whitelist-only)"
    architectural decision. Commit.

## Open questions to surface, NOT settle

1. **SessionEnd hook.** Does Claude Code 2.1.131 emit one? If yes,
   wiring auto-ingest is trivial. If no, defer auto-ingest to v0.5.x
   and ship v0.5.0 with manual `harness ingest-session` only. Surface
   the answer empirically (try wiring a tee hook on `SessionEnd` and
   check if it fires).

2. **In-progress sessions.** A JSONL is being written WHILE the
   session is live. Should `harness ingest-session` refuse to ingest
   the currently-active session, or read whatever's there? Refusal
   is safer (no race) but less useful. Recommendation: read; the
   ingest is idempotent so re-running picks up new turns. Verify no
   crash on truncated final line.

3. **Encoded project dir name.** `~/.claude/projects/<encoded>` uses
   path encoding (slashes → dashes). Document the exact rule the
   ingester relies on. Current observation: `~/DEV/claude-snaps`
   becomes `-home-bantarus-DEV-claude-snaps`. Verify against multi-arg
   paths and unicode paths before pinning.

4. **`attributionSkill` correlation with attribution events.** The
   JSONL records which skill was active per turn. We could correlate
   this with our attribution events (event_kind=user_prompt rows
   that triggered skill resolution). v0.5.x candidate; not in
   v0.5.0 scope.

5. **`sessions <id>` augmentation.** If turn_metrics exists for a
   session, should `harness sessions <id>` show economic data
   inline? Recommendation: yes, after the trajectory list, with a
   one-line "Cost summary" footer. v0.5.0 nice-to-have; defer to
   v0.5.x if it complicates the diff.

6. **Multi-attempt query semantics.** `harness session-cost --all` on
   a project with 1000 sessions could return a lot. Add `--limit`
   from day one. Default to top-N-by-cost? Surface the question.

## What's NOT in scope

- **Per-tool token attribution.** Hard pin #6 says no. The data
  model records call counts, not token costs per tool.
- **Capturing prompt text or tool inputs.** Hard pin #3.
- **Live tail / streaming ingest.** v0.5.x candidate. v0.5.0 is
  batch only.
- **Cross-session aggregation across MULTIPLE harness repos.** A
  user with 5 projects has 5 `.harness/` directories; this command
  operates on the local one. Cross-project rollups are a separate
  v0.5+ design.
- **Cost in USD.** Token-to-cost translation requires per-model
  pricing (which changes). Out of scope; queries return token
  counts only.
- **Anthropic API users (no transcript).** `harness ingest-session`
  ONLY works against Claude Code's local JSONL. API users don't
  have one. Document this limitation.
- **Backfill of historical sessions before harness was wired.** If
  `.harness/` was added partway through, only sessions whose hooks
  fired into harness have attribution rows. Sessions without
  attribution rows can still be ingested via `--all` (the ingester
  walks the host's project dir directly), but they won't link to
  any snapshot.

## Estimated effort

Per the order of operations: ~6 days of focused work. Bulk is in
steps 5 (ingester core) and 6 (privacy fuzz). The CLI and CI
integration are mechanical once the data model is right.

## What success looks like

A user types `harness ingest-session <id>` after a long Claude Code
session and gets back a precise economic readout: model used, total
tokens, tool call breakdown, Claude Code version. They cross-reference
that with `harness log` to see which snapshot composition was active
during the burn. They run `harness session-cost --all --by-model`
across their project and see "I spent 28M tokens on Opus this month;
3M on Haiku" — actionable economic data they couldn't get any other
way.

The privacy whitelist holds: not one byte of any user prompt, tool
input, or tool result lives in the harness store. The fuzz gate
proves it on every CI run. The spec documents the whitelist as
normative, so any third-party harness reader knows what they may and
may NOT do.

---

When this prompt is complete, harness has crossed from "captures
composition" to "captures composition AND session economics". The
framing shift — from pure composition to composition-plus-economics —
is documented in the spec (§10) and reflected in the new commands.
v0.6+ candidates (live streaming, prompt capture with explicit
opt-in, USD cost translation, cross-project rollups) are clearly
out of scope and clearly tracked.
