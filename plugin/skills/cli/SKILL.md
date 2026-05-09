---
name: harness-cli
description: "Map of the harness CLI: every command (init, log, diff, snap, sessions, notes, tag, branch, checkout, reproduce, reindex, install-hook, ingest-session, session-cost), its purpose, key flags, and when to suggest it. Use when the user asks to run a harness command, asks what `harness X` does, asks 'how do I check the cost of yesterday's session', 'how do I see what changed in .claude/', 'how do I tag this state', 'how do I roll back', or any 'how do I' that maps to a harness verb."
---

# harness CLI

The `harness` command-line interface for the
[`.harness/`](../../../spec/format.md) snapshot format. Implementation
of v0.5; canonical bytes and format rules live in
[`@harness/core`](../../../packages/core/), command surface in
[`@harness/cli`](../../../packages/cli/).

This skill is the per-command guide. Reach for it whenever a user
question maps to a harness verb.

## Ref resolution rules

Every ref-accepting command (`diff`, `notes`, `tag`, `branch`,
`checkout`, `reproduce`, `ingest-session`, `session-cost`) accepts:

- 40-hex full id
- 6+-hex prefix (must be unambiguous)
- `HEAD`
- branch name (under `refs/heads/`)
- tag name (under `refs/tags/`)

If a prefix is ambiguous, the CLI exits 1 with an "ambiguous prefix"
message — extend the prefix and retry.

## Exit codes

- `0` — success
- `1` — recoverable user error (apm not installed, ref unknown,
  divergence detected, configHash mismatch, missing transcript,
  no rows to summarize, etc.)
- `2` — internal error (treat as a CLI bug)

## Init / wiring

### `harness init [--branch=<name>]`

Initialize `.harness/` in `cwd`. Creates `HEAD`, `config`,
`snapshots/`, `refs/heads/`. The first snapshot lands when the next
hook fires (or `harness snap "<note>"` is run). Default branch name
is `main`. **Suggest when** the user is in a project without a
`.harness/` directory and wants lineage tracking.

### `harness install-hook [--force]`

Wire `harness-hook` into `.claude/settings.json` for SessionStart +
UserPromptSubmit. Strict by default: refuses on a dirty git tree,
backs up the existing settings, and confirms before writing.
**Legacy path** for non-plugin users — if this plugin is loaded,
hooks fire via `plugin/hooks/hooks.json` and `install-hook` is not
needed. Both can coexist (they merge additively per
spec/hooks.md §1.1) but produce duplicate attribution rows; see
the harness-fundamentals skill.

## Inspection

### `harness log [--branch=<name>] [--limit=N] [--with-sessions]`

List snapshots newest first, with a per-row diff summary computed at
read time (modules added/removed/changed since the parent). `(HEAD)`
annotates the current HEAD; tags appear inline; `code:<short-sha>`
is the git codePin. `--with-sessions` adds `[N sessions]` per row.
**Suggest when** the user asks "what changed", "what's the current
state", "show recent activity in this project."

### `harness diff <a> <b>`

Module-level diff between two snapshots. Output: `+` added,
`-` removed, `~` changed (configHash differs). **Suggest when** the
user asks "what's different between these two snapshots" or wants
to verify a reproduce result against the source snapshot.

### `harness sessions [<session-id>]`

No arg: list all sessions seen by this harness. With an id: render
the session's trajectory (every snapshot it observed, in order, with
`@`-marked notes inline). **Suggest when** the user asks "what
happened in session X" or "which sessions touched this snapshot."

### `harness notes <snapshot-ref>`

List every `note` attribution event ever attached to a snapshot,
across all sessions. Notes are first-class events (§2.7) — they
don't create new snapshots, just rows in `lineage.sqlite`.
**Suggest when** the user asks "do I have notes on this state"
or "why did I tag this."

## Mutation

### `harness snap "<note>"`

Capture current composition and attach a note. The note is
**required** — there is no anonymous CLI capture path. If
composition is unchanged, no new blob; just an extra `note`
attribution row pointing at the existing snapshot. **Suggest when**
the user wants to mark a state ("this is the v0.5 surface", "before
I refactor the skills") or annotate an unchanged composition.

### `harness tag <name> [<id>] [--force]`

Tag a snapshot — defaults to HEAD. A tag is `refs/tags/<name>`
containing a snapshot id; tags do NOT create new snapshots (§4.2).
`--force` overwrites an existing tag. **Suggest when** the user
wants to label a state for later retrieval (e.g. `harness tag v0.5`).

### `harness branch <name> [<id>] [--force]`

Create a branch — defaults to HEAD. Same shape as a tag but lives
under `refs/heads/`. The hook updates the branch's tip on every
composition change while on that branch. **Suggest when** the user
wants to fork lineage (e.g. trying an experimental skill setup
without polluting `main`).

### `harness checkout <ref>`

Move HEAD to `<ref>`. Does NOT touch `.claude/` — this is a pointer
move only. Warns if the working tree's composition has diverged
from HEAD. **Suggest when** the user wants to navigate the lineage
graph without applying anything; pair with `harness reproduce` to
actually materialize the composition.

## Reproduce + index

### `harness reproduce <ref> [--dry-run]`

Materialize `<ref>`'s composition into `.claude/` via APM, with the
**subtractive contract** (spec/format.md §6.1). Each invocation:

1. Backs up `.claude/` to `.claude.harness-backup-<ISO>/`
   (unconditional, never auto-pruned — the safety net).
2. Writes the snapshot's `apmLockfile` to `apm.lock.yaml`
   (or removes it if the snapshot recorded no APM state).
3. Runs `apm install --force`.
4. Removes APM-managed paths NOT in the target snapshot's scope.
5. Verifies each APM-source module's `configHash`.
6. Advances HEAD on success.

**Local-source paths are never touched.** Always run with
`--dry-run` first when the situation is non-trivial. The
`harness-reproducer` skill (and the reproducer-pilot subagent
behind `/harness:restore`) cover the contract details. **Suggest
when** the user asks to "go back to v0.X" or "restore that state"
— but route through the pilot subagent for the safety wrap.

### `harness reindex`

Rebuild `lineage.sqlite` from `snapshots/`. Source of truth is the
blobs; the SQLite index is derivable. **Suggest when** the user
suspects DB corruption or has hand-edited `lineage.sqlite`.

## v0.5 session metrics

### `harness ingest-session [<id>] [--all] [--since-turn N] [--dry-run] [--transcript-path <path>]`

Read the per-session `transcript_path` JSONL Claude Code already
writes (under `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`
per spec §10.5) and store per-turn metrics — model, token usage,
tool names, Claude Code version, sidechain flag, attribution skill
— in `turn_metrics`. Idempotent on `(session_id, turn_index)`:
re-running on an unchanged file produces zero new rows; appended
turns produce exactly N new rows.

**Privacy whitelist (§10.2, NORMATIVE).** Reads ONLY whitelisted
fields. Prompt text, tool inputs, tool results, system prompts, and
assistant thinking blocks are NEVER copied. Locked by the W12.5 fuzz
gate. (Full surface in the harness-fundamentals skill.)

`--all` backfills every session with a transcript on disk.
`--since-turn N` only ingests turns at index ≥ N (useful for
resuming after a partial ingest). `--dry-run` reports counts without
writing. `--transcript-path <path>` overrides the auto-derived path.

**Suggest when** the user asks about a specific session's cost,
runs a long session, or wants to see token usage. Often used as
a precursor to `harness session-cost`.

### `harness session-cost [<id>] [--all] [--by-tool] [--by-model] [--branch <name>] [--limit N] [--csv]`

Query `turn_metrics`. Without flags: per-session breakdown
(user/assistant turn counts, models touched, total tokens by class,
top tools by call count). Flags:

- `--by-tool` — call counts per tool only. Per-tool TOKEN
  attribution is **not supportable** (§10.3 — JSONL `usage` blocks
  are per-turn, not per-tool-call). The CLI surfaces this limitation
  in output; don't paper over it with estimates.
- `--by-model` — per-model session counts and total tokens. Sessions
  that touched multiple models count in each bucket.
- `--all [--branch <name>] [--limit N]` — project-wide ranking
  ordered by total tokens DESC.
- `--csv` — header + one row per session, machine-readable.

**Suggest when** the user asks "how much did this session cost",
"which sessions burned the most tokens this week", "what did I
spend on Opus", or "did I use the Bash tool yesterday." Run
`ingest-session` first if the target session hasn't been ingested.

## Permission grant note

This skill **does not** declare `allowed-tools` in its frontmatter.
The original v0.5 plan called for `allowed-tools: Bash(harness *)
Bash(harness-hook *)`, but Probe 6 (2026-05-09, Claude Code 2.1.128)
found that **any** `allowed-tools` value — including bare `Bash`,
`Bash(<pattern>)`, and YAML-list forms — causes Claude Code to
fail loading the skill body entirely (the description still
surfaces, but the body is unreachable). The skill is therefore
authored without the grant.

**Practical implication.** When the user runs harness commands at
this skill's suggestion, Claude Code may prompt for Bash permission
or deny it under restrictive permission modes. To eliminate prompts:

- One-shot: `claude --allowed-tools Bash --plugin-dir <plugin-path>`
  (the bare `Bash` grant works at the CLI flag layer per Probe 6).
- Persistent: add `Bash(harness *)` and `Bash(harness-hook *)` to
  `.claude/settings.json`'s `permissions.allow` list.

Re-verify the skill-frontmatter `allowed-tools` behavior under each
new Claude Code minor (2.1.x → 2.2.x). The drift detector at
[scripts/dogfood-v0_4/local_cases/l3_plugin_pre_flight.sh](../../../scripts/dogfood-v0_4/local_cases/l3_plugin_pre_flight.sh)
will turn red when the host changes the frontmatter parser; restore
the `allowed-tools` line at that point.
