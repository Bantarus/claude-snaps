#!/usr/bin/env bash
# Day 10 — tag v0.2 + final reflection.
# Tests: the "stranger reads the lineage" question. Run all the
# inspection tools end-to-end and capture observations.

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
  $HARNESS log | head -1                      # capture the new id
  $HARNESS tag v0.2 <that-id>

Now do the architect's three deliverables (capture into a file):

  bash scripts/dogfood/audit.sh > soak-report.txt 2>&1
  cat soak-report.txt
  # The audit script runs harness log, harness diff between key tags,
  # all spec gates, and reports anything that drifted from clean.

Then exercise the TUI:

  cd $MONOREPO_ROOT
  pnpm --filter @harness/tui dev
  # (the cli walks up to find the soak's .harness/, but it's safer to
  # run from inside SOAK_DIR — it walks up from cwd):
  cd $SOAK_DIR && pnpm --filter @harness/tui run dev
  # Navigate Lineage / Sessions / Diff / Editor / Module.
  # Take notes on:
  #   - Does the lineage tell a coherent story?
  #   - Does \`harness diff <day-2-id> <day-9-id>\` (small vs big diff)
  #     stay readable in the Diff screen?
  #   - Anything you reach for that doesn't exist?
  # Hit \`q\` to quit.

Bring back to the next conversation:
  1. The "I wish I could…" list, unfiltered.
  2. Surprises in harness log / harness diff (good or bad).
  3. soak-report.txt contents.
EOF
)"
