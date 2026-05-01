#!/usr/bin/env bash
# Day 02 — additive case: a brand-new skill appears.
# Tests: capture picks it up, diff vs baseline shows +skill.

source "$(dirname "$0")/lib.sh"
require_soak_dir
say "day 02 — add skill: test-runner"

mkdir -p "$SOAK_DIR/.claude/skills/test-runner"
cat > "$SOAK_DIR/.claude/skills/test-runner/SKILL.md" <<'EOF'
---
name: test-runner
description: Run the project's test suite and report failures concisely.
---

# test-runner

Detect the test runner from package.json or pyproject.toml. Run the
suite. On failure, summarize each failing test in one line: file
path, test name, the assertion that failed.
EOF
note "added .claude/skills/test-runner/SKILL.md"

suggest "$(cat <<EOF
  cd $SOAK_DIR
  claude --model claude-haiku-4-5-20251001
  > what skills are configured here? what does test-runner do?
  /exit

After exiting:
  $HARNESS log | head -3
  # Expect: a new auto snapshot, parented on the day-1 baseline.
  $HARNESS diff <day-1-id> <day-2-id>
  # Expect: + skill test-runner. Nothing else changed.
EOF
)"
