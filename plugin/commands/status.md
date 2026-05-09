---
description: Aggregate harness state — HEAD, recent lineage, branches, tags, working-tree divergence, backup directory count. Single-screen status report.
disable-model-invocation: true
allowed-tools: Bash(harness log *), Bash(harness checkout *), Bash(ls *)
---

Render a single-screen status report for the current `.harness/`
project. Run these commands and synthesize the output — don't paste
all the raw rows; pick what matters.

1. **HEAD + recent lineage:** `harness log --limit 5 --with-sessions`.
   Each row: `<id8> ▶ <diff-summary> (branch) [(HEAD)] [tag] code:<git-sha> [N sessions]`.
   The row marked `(HEAD)` is current.
2. **Branches and tags:** parse from the log rows above (branch
   labels in `(parens)`, tag labels appear as bare names after the
   branch). If the lineage is short, branches/tags may all surface
   in 5 rows; if the project has more refs, mention "additional refs
   not shown" and suggest `harness log --limit 50` for a deeper view.
3. **Working-tree divergence:** run
   `harness checkout <current-branch-name>` against the same branch
   HEAD is on (so HEAD doesn't move) and parse the divergence
   warning from stderr if it fires. If HEAD is detached, skip this
   step and note "HEAD is detached".
4. **Backup count:** `ls -d .claude.harness-backup-* 2>/dev/null | wc -l`.
   If 0, omit this line. If non-zero, report the count and suggest
   `ls -dh .claude.harness-backup-*` for inspection if the user
   wants details.

Output shape — keep it terse:

```
HEAD: <id8> on <branch>  [(detached)]   [diverged: <message>]
Recent:
  <id8> ▶ <diff-summary>     (HEAD)
  <id8> ▶ <diff-summary>
  ... (3-5 rows)
Refs: branches=<comma-list>, tags=<comma-list>
Backups: <N> at <project-root>/.claude.harness-backup-*
```

If `.harness/` doesn't exist in the cwd, exit early with: "no
`.harness/` here — run `harness init` to start tracking lineage."
