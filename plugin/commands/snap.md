---
description: Capture current .claude/ composition and attach a note (auto-snapshot if composition changed; note-only attribution if unchanged).
disable-model-invocation: true
allowed-tools: Bash(harness snap *)
argument-hint: "<note>"
---

Run `harness snap "$ARGUMENTS"` and report the result tightly:

- The captured snapshot id (6-8-hex prefix).
- Whether a new snapshot blob was written (composition changed) or
  the note attached to the existing HEAD snapshot (composition
  unchanged) — read this from the `harness snap` output.
- The exit code if non-zero.

Do NOT paste the raw `harness snap` output unless it errored. One
short paragraph max. The note text was the user's, so don't
re-quote it back.
