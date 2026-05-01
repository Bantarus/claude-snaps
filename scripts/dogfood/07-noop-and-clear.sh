#!/usr/bin/env bash
# Day 07 — back to main, no mutations. Inside the session, /clear.
# Tests: empty-diff readability ("the boring floor"), session_id
# behavior across /clear (does Claude Code generate a new id?).

source "$(dirname "$0")/lib.sh"
require_soak_dir
say "day 07 — no-op session on main + /clear probe"

"$HARNESS" checkout main 2>&1 | tail -2
note "checked out main; no .claude/ mutations this day"

suggest "$(cat <<EOF
  cd $SOAK_DIR
  claude --model claude-haiku-4-5-20251001
  > nothing to do today, just checking in.
  /clear
  > say hi after the clear
  /exit

After exiting:
  $HARNESS log | head -5
  # Expect (if Claude Code generated a NEW session_id on /clear):
  #   two new auto snapshots back-to-back, both with empty module diffs
  # Expect (if Claude Code REUSED the same session_id across /clear):
  #   ONE new auto snapshot (idempotency suppresses the second fire)
  # This day is the empirical answer to the session_id question the
  # architect flagged. Note which case you observe — it's a real
  # data point.

  $HARNESS diff <day-5-tag-id> <day-7-id>
  # Expect: nothing. The "boring floor" — does the output gracefully
  # say "no module differences" or does it produce noise?

  # Also check the JSONL hook attachment trail (CONTRIBUTING.md):
  ls -t ~/.claude/projects/\$(pwd | tr / -)/*.jsonl | head -3
  # Read the most recent — count attachment.hookEvent entries.
  # That's the ground truth for how many times the hook fired.
EOF
)"
