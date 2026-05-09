---
description: Reproduce wrapper — runs --dry-run first via the harness-reproducer-pilot subagent, summarizes implications, asks for confirmation, then executes.
disable-model-invocation: true
allowed-tools: Bash(harness reproduce *), Bash(harness diff *), Bash(harness log *)
argument-hint: "<ref>"
---

Route this request to the **harness-reproducer-pilot** subagent.
Do NOT run `harness reproduce` directly from main context — the
pilot exists to wrap the operation in a dry-run + confirm flow that
keeps `.claude/` safe (per spec/format.md §6.1).

Pass to the pilot: "Plan and execute a reproduce of `$ARGUMENTS`,
including the §6.1 dry-run/confirm/execute flow."

The pilot will:

1. Run `harness reproduce $ARGUMENTS --dry-run` and parse the output.
2. Return a 4–6 line implications summary (APM phase status,
   subtractive cleanup count, `apm.lock.yaml` change, local-source
   modules NOT being reproduced, backup path).
3. Wait for the user's confirmation (auto-skipping confirmation
   only when the operation is trivially safe — see the pilot's
   workflow).
4. On confirmation, run `harness reproduce $ARGUMENTS` (no
   `--dry-run`) and report HEAD status, success/failure, backup
   path, and recovery command if it failed.

After the pilot returns, surface its final report verbatim — don't
re-summarize. The pilot already kept its output terse on purpose.

If `$ARGUMENTS` is empty or unparseable, redirect: "Usage:
`/harness:restore <ref>` — `<ref>` is a 40-hex id, 6+-hex prefix,
HEAD, branch name, or tag name."
