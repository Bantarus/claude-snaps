#!/usr/bin/env bash
# Day 10 — tag v0.3 + final reflection.
# Tests: the "stranger reads the lineage" question end-to-end.
# Run all the inspection tools and capture observations.
#
# The script filename keeps the historical "v02" name from the v0.2
# soak; the tag itself is named v0.3 to match the current spec
# version. Don't rename the file — the tag inside is what matters.

source "$(dirname "$0")/lib.sh"
require_soak_dir
say "day 10 — final session + tag v0.3"

# No mutations this day — the goal is a clean snapshot at the end of
# the soak that you can promote to v0.3.

suggest "$(cat <<EOF
  cd $SOAK_DIR
  claude --model claude-haiku-4-5-20251001
  > final reflection: what's in my harness today vs the day-1 baseline?
  /exit

After exiting, tag v0.3:
  $HARNESS log | head -1                      # capture the new snapshot id
  $HARNESS tag v0.3 <that-id>

Then take the architect's three deliverables. The CLI does the
walkthrough — read it like a stranger:

  1. Lineage at a glance:
     $HARNESS log
     # Read top-to-bottom. Do the kinds (init / auto) and branches
     # make sense? Tags appear as inverted-yellow annotations after
     # the branch column (lightweight refs, not snapshots — v0.3.1
     # §4.2). In v0.3 each row's per-row summary is
     # computed at read time by summarizeDiff (e.g. "init",
     # "+1 skill", "~1 skill (notes)", "+2 skills, +1 prompt, +1 style").
     # The v0.2 soak's "(no message)" gap is closed — but does the
     # auto-summary feel sufficient standalone, or do you still reach
     # for trajectory output? Note the answer.

  2. Lineage with attribution counts:
     $HARNESS log --with-sessions
     # The [N sessions] suffix on each row tells you how many runtime
     # sessions observed that composition. Same-composition sessions
     # SHOULD share a row. If you see snapshot inflation (every
     # session producing its own row when you ran some on unchanged
     # composition), that's a §3.1-strip bug.

  3. Sessions overview:
     $HARNESS sessions
     # Lists every session_id observed. Should match your mental model
     # of how many claude invocations you did. Includes <manual> rows
     # for each direct CLI 'harness snap' note (you ran one on day 5).

  4. Per-session trajectories — the load-bearing v0.3 view:
     $HARNESS sessions <day-3-session-id>
     # A session that did NOT change composition. Trajectory should
     # show session_start + N user_prompts, all with '=' markers
     # (same snapshot throughout).
     $HARNESS sessions <day-9-session-id>
     # A session that ran across an interesting day. Should be the
     # most readable narrative of the soak — '@' markers for any notes,
     # '→' markers for snapshot transitions, '=' for unchanged. If
     # THIS doesn't tell a story, that's the v0.4 priority signal.
     $HARNESS sessions '<manual>'
     # The pseudo-session for direct CLI annotations. Should show one
     # row per 'harness snap "<text>"' you ran across the soak.

  5. Cross-session notes (Q2 — spec/format.md §2.7):
     $HARNESS notes v0.1
     # Should surface the day-5 'promoting baseline composition to v0.1'
     # note. If you also annotated v0.3 just now (or any other ref),
     # those notes appear here too — across sessions, ordered by time.

  6. Diffs at the boundary:
     $HARNESS diff v0.1 v0.3
     # The promoted-version delta. Should reflect what you remember
     # adding/removing across days 6-10.
     $HARNESS diff <day-1-init-id> <day-9-tip-id>
     # The full-soak delta. The architect's "stranger reading the
     # lineage" test in one shot.

  7. Audit (capture into a file):
     bash scripts/dogfood/audit.sh > soak-report.txt 2>&1
     cat soak-report.txt
     # The audit script runs harness log, harness sessions, harness
     # diff between key tags, all spec gates (schema agreement,
     # format-version-bump, canonical-501 byte-stability), the
     # gitignore-vs-tree audit, and the test gates. Anything that
     # quietly drifted will surface here.

Bring back to the next conversation:
  1. The "I wish I could…" list, unfiltered.
  2. Surprises in harness log / harness sessions / harness diff /
     harness notes (good or bad).
  3. soak-report.txt contents.
  4. RESUME FIRING STATUS: did Claude Code's host fire SessionStart on
     --continue with source=resume (matching v0.3 §4.6)? Did
     user_prompt rows land regardless? Empirical observation against
     the spec narrative.
  5. DEDUP STATUS: did same-composition sessions share a snapshot?
     (v0.3 designed to make this YES; verify empirically.)
  6. AUTO-SUMMARY VERDICT: did 'harness log' per-row summaries
     close the v0.2 "(no message)" readability gap? Or do you still
     reach for 'harness sessions <id>' to make the lineage make sense?
EOF
)"
