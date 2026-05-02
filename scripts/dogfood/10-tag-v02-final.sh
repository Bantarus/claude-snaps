#!/usr/bin/env bash
# Day 10 — tag v0.2 + final reflection.
# Tests: the "stranger reads the lineage" question end-to-end.
# Run all the inspection tools and capture observations.

source "$(dirname "$0")/lib.sh"
require_soak_dir
say "day 10 — final session + tag v0.2"

# No mutations this day — the goal is a clean snapshot at the end of
# the soak that you can promote to v0.2.

suggest "$(cat <<EOF
  cd $SOAK_DIR
  claude --model claude-haiku-4-5-20251001
  > final reflection: what's in my harness today vs the day-1 baseline?
  /exit

After exiting, tag v0.2:
  $HARNESS log | head -1                      # capture the new snapshot id
  $HARNESS tag v0.2 <that-id>

Then take the architect's three deliverables. The CLI does the
walkthrough — read it like a stranger:

  1. Lineage at a glance:
     $HARNESS log
     # Read top-to-bottom. Do the kinds (init / manual / tag) and
     # branches make sense? Do the (no message) rows feel acceptable
     # because the trajectory will fill them in, or do they feel like
     # missing information? Note the answer.

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
     # if you ran 'harness snap'.

  4. Per-session trajectories — the load-bearing v0.2 view:
     $HARNESS sessions <day-3-session-id>
     # A session that did NOT change composition. Trajectory should
     # show session_start + N user_prompts, all with '=' markers
     # (same snapshot throughout).
     $HARNESS sessions <day-9-session-id>
     # A session that ran across an interesting day. Should be the
     # most readable narrative of the soak. If THIS doesn't tell a
     # story, that's the v0.3 priority signal.

  5. Diffs at the boundary:
     $HARNESS diff v0.1 v0.2
     # The promoted-version delta. Should reflect what you remember
     # adding/removing across days 6-10.
     $HARNESS diff <day-1-init-id> <day-9-tip-id>
     # The full-soak delta. The architect's "stranger reading the
     # lineage" test in one shot.

  6. Audit (capture into a file):
     bash scripts/dogfood/audit.sh > soak-report.txt 2>&1
     cat soak-report.txt
     # The audit script runs harness log, harness sessions, harness
     # diff between key tags, all spec gates (schema agreement,
     # format-version-bump, canonical-501 byte-stability), the
     # gitignore-vs-tree audit, and the test gates. Anything that
     # quietly drifted will surface here.

Bring back to the next conversation:
  1. The "I wish I could…" list, unfiltered.
  2. Surprises in harness log / harness sessions / harness diff
     (good or bad).
  3. soak-report.txt contents.
  4. RESUME GAP STATUS: did resumed sessions accumulate user_prompt
     rows? (v0.2 designed to make this YES; verify empirically.)
  5. DEDUP STATUS: did same-composition sessions share a snapshot?
     (v0.2 designed to make this YES; verify empirically.)
EOF
)"
