---
description: Per-session or project-wide token cost roll-up via `harness session-cost` (v0.5.0+). With no args, reports the most-recent session; with a session id, reports that session; with --all, project-wide.
allowed-tools: Bash(harness session-cost *), Bash(harness ingest-session *)
argument-hint: "[<session-id>] [--all] [--by-tool] [--by-model] [--branch <name>] [--limit N] [--csv]"
---

Run `harness session-cost $ARGUMENTS` and report the result.

**If the target session hasn't been ingested yet** (the CLI exits
1 with "no rows for session"), suggest one of:

- `harness ingest-session <session-id>` — ingest just that session.
- `harness ingest-session --all` — backfill every session with a
  transcript on disk.

…then re-run `harness session-cost`.

**Output discipline:**

- Pass through `harness session-cost`'s output formatting — it's
  already terse and tabular. Don't re-summarize per-session breakdowns
  into prose unless the user asks.
- For `--all` rankings, surface the top 5 rows in your prose if the
  user asked something like "which sessions cost the most"; for
  larger output the CLI's table is the right artifact.
- For `--by-tool`, **always remind the user** that this is call
  counts only — per-tool TOKEN attribution is not supportable per
  spec/format.md §10.3. Don't paper over it with estimates.
- `--csv` produces machine-readable output; if the user passed
  `--csv`, dump verbatim.

**Privacy reminder.** Both `ingest-session` and `session-cost` read
ONLY whitelisted fields from the JSONL transcript (spec/format.md
§10.2). Prompt text, tool inputs, tool results, system prompts, and
assistant thinking are NEVER copied to harness storage. If the user
asks "what does session-cost actually see," route to the
`harness-fundamentals` skill in main context for the §10.2
breakdown.
