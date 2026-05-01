#!/usr/bin/env bash
# Day 08 — removal case: delete the skill added in day 02.
# Tests: removal is correctly diff'd as -skill.

source "$(dirname "$0")/lib.sh"
require_soak_dir
say "day 08 — remove skill: test-runner (on main only)"

soak_rm ".claude/skills/test-runner"

suggest "$(cat <<EOF
  cd $SOAK_DIR
  claude --model claude-haiku-4-5-20251001
  > what skills do we have left after dropping test-runner?
  /exit

After exiting:
  $HARNESS diff <day-7-id> <day-8-id>
  # Expect: − skill test-runner. Nothing else changed.
  # The experimental branch still has its own test-runner — verify
  # it's untouched:
  $HARNESS log --branch experimental | head -3
  $HARNESS diff <experimental-tip-id> <day-8-main-id>
  # Expect: experimental still has test-runner; main no longer does.
EOF
)"
