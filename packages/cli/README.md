# `@harness/cli`

The `harness` command-line interface for the [`.harness/`](../../spec/format.md)
agent-harness snapshot format. Implementation of the v0.5 format
spec; canonical bytes derivation lives in
[`@harness/core`](../core/).

## Commands

```
harness init [--branch=<name>]                  Initialize a new .harness/ in cwd.
harness log [--branch=<name>] [--limit=N]
            [--with-sessions]                   List snapshots, newest first.
harness diff <a> <b>                            Diff two snapshots' modules.
harness snap "<note>"                           Capture + attach a note.
harness sessions [<session-id>]                 List sessions or one trajectory.
harness notes <snapshot-ref>                    All notes attached to a snapshot.
harness tag <name> [<id>] [--force]             Tag a snapshot.
harness branch <name> [<id>] [--force]          Create a branch.
harness checkout <ref>                          Move HEAD; warns on divergence.
harness reproduce <ref> [--dry-run]             Materialize via APM, subtractively.
harness reindex                                 Rebuild lineage.sqlite.
harness install-hook [--force]                  Wire the SessionStart hook.
harness ingest-session [<id>] [--all]
       [--since-turn N] [--dry-run]
       [--transcript-path <path>]               Read the per-session JSONL Claude
                                                Code wrote and store metadata
                                                (model, tokens, tools, CC version)
                                                in turn_metrics. v0.5.0+.
harness session-cost [<id>] [--all]
       [--by-tool] [--by-model]
       [--branch <name>] [--limit N] [--csv]    Query turn_metrics. Per-session
                                                report or project-wide roll-up.
                                                v0.5.0+.
```

Refs accept: 40-hex id, 6+-hex prefix, `HEAD`, branch name, tag name.

## `harness reproduce` and backups

`harness reproduce` is APM-driven and **subtractive within scope**
(spec/format.md §6.1). On every invocation it:

1. Backs up `.claude/` to `.claude.harness-backup-<ISO timestamp>/`.
   The backup is unconditional and not auto-deleted — it is the
   safety net for the subtractive contract.
2. Writes the snapshot's recorded `apmLockfile` to `apm.lock.yaml`
   (or removes the lockfile if the snapshot recorded no APM state).
3. Runs `apm install --force` to materialize APM-managed modules.
4. Removes APM-managed paths under `.claude/` that aren't in the
   target snapshot's scope.
5. Verifies each APM-source module's `configHash`.
6. Advances HEAD on success.

### Backup cleanup

Backups accumulate at `<project-root>/.claude.harness-backup-*/`
across reproduce invocations. The CLI does NOT auto-prune them; that
would defeat the safety guarantee. Clean periodically with:

```bash
# Inspect first — identify backups you no longer need.
ls -dh .claude.harness-backup-*

# When sure, remove the ones you don't need:
rm -rf .claude.harness-backup-2026-05-04T12-*
```

A user-initiated `harness reproduce --cleanup-backups` command is
backlog; for current versions the recommendation is manual file
management with file-system tools.

## Session metrics (v0.5.0+)

Two commands query session economics — model used per turn, token
consumption, tool/MCP calls, Claude Code version — captured by
post-hoc ingestion of the per-session transcript JSONL Claude Code
already writes.

### `harness ingest-session <session-id>`

Reads `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` (per
[spec §10.5](../../spec/format.md#105-project-dir-encoding-rule)) and
inserts one row per assistant or user turn into `turn_metrics`.
Idempotent on `(session_id, turn_index)` — re-running on an unchanged
file produces zero new rows; re-running after appended turns produces
exactly N new rows.

```bash
$ harness ingest-session 1fc2730f-1903-4bbc-8ddf-84ef65e5fe96
Ingested 47 new turns from session 1fc2730f-1903-4bbc-8ddf-84ef65e5fe96
  user turns: 12, assistant turns: 35
  models: claude-opus-4-7
  tokens: 1,290,176 input (1,224,847 cache-read, 41,021 cache-creation, 24,308 live), 24,116 output
  tools: Bash×135, Edit×33, Write×27, Read×23, TodoWrite×22
  Claude Code version observed: 2.1.131

# Backfill every session with a transcript on disk:
$ harness ingest-session --all
```

**Privacy boundary** — load-bearing per
[spec §10.2](../../spec/format.md#102-what-is-not-stored). The
ingester reads ONLY whitelisted fields. Prompt text, tool inputs,
tool results, system prompts, and assistant thinking are NEVER
copied to harness storage. The W12.5 fuzz gate (canary-laced JSONL
+ raw-bytes grep of `lineage.sqlite`) verifies this on every CI run.

### `harness session-cost [<id>] [--all]`

Roll up `turn_metrics`. Without flags, reports a per-session
breakdown identical in shape to `ingest-session`'s post-write
summary. Flags:

- `--by-tool` — call counts per tool. Per-tool TOKEN attribution is
  NOT supported (per [spec §10.3](../../spec/format.md#103-per-tool-token-attribution-impossibility)
  — JSONL usage blocks are per-turn, not per-tool-call). The CLI
  surfaces this limitation in its rendered output.
- `--by-model` — per-model session counts and total tokens. Sessions
  that touched multiple models count in each bucket.
- `--all [--branch <name>] [--limit N]` — project-wide ranking
  ordered by total tokens DESC. Default limit: unlimited.
- `--csv` — machine-readable header + one row per session.

## Exit codes

- `0` — success.
- `1` — recoverable user error (apm not installed, install failed,
  configHash mismatch, ref unknown, divergence detected, transcript
  missing for `ingest-session`, no rows for `session-cost`).
- `2` — internal error.
