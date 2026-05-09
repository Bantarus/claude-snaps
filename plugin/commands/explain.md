---
description: Plain-prose explanation of a snapshot — when captured, what changed vs parent, who observed it, what notes are attached, whether HEAD is at it.
allowed-tools: Bash(harness log *), Bash(harness diff *), Bash(harness notes *), Bash(harness sessions *)
argument-hint: "<ref>"
---

Resolve `$ARGUMENTS` to a snapshot id, then write a 4–6 sentence
prose narrative covering:

1. **When captured.** Pull `createdAt` from `harness log --limit 50`
   (the CLI prints `code:<git-sha>` per row but not the per-row
   timestamp directly; cross-reference `harness sessions` for the
   ISO timestamp of an event that observed this snapshot, OR read
   `.harness/snapshots/<aa>/<rest>.json`'s `createdAt` if the row's
   timestamp isn't surfaced in the log output). Include the git
   `codePin` (short sha) inline.
2. **What changed vs parent.** Run `harness diff <parent-id>
   <this-id>` and summarize: `+N added`, `-M removed`, `~K changed`,
   with a short list of the most notable item names (max 5; "and N
   more" if longer).
3. **Who observed it.** Run `harness log --with-sessions` and read
   the `[K sessions]` count for this snapshot. If the user wants
   the specific session ids, suggest `harness sessions` (no args)
   for the listing.
4. **Notes attached.** Run `harness notes $ARGUMENTS`. Quote each
   note text with its session id (use `<manual>` literally for CLI-
   captured notes, per §2.7).
5. **HEAD status.** From the log, mark whether this snapshot is
   `(HEAD)`, ahead of HEAD, or behind HEAD. If detached, mention.

Output is **prose**, not raw command output. Subagent-style: the
user asked a question; return the answer.

If `$ARGUMENTS` doesn't resolve to a snapshot (unknown ref or
ambiguous prefix), report the CLI's error verbatim and stop —
don't fabricate.
