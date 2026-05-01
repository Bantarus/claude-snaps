#!/usr/bin/env bash
# Day 06 — branch divergence: fork an experimental branch, modify a
# skill differently than main.
# Tests: branch creation, fork-kind snapshot, divergent lineage.

source "$(dirname "$0")/lib.sh"
require_soak_dir
say "day 06 — fork experimental + diverge"

# Get the v0.1 tag's snapshot id as our fork point.
FORK_FROM="$("$HARNESS" log 2>/dev/null | grep -E '\bv0\.1\b' | head -1 | awk '{print $1}' || true)"
if [ -z "$FORK_FROM" ]; then
  note "warning: couldn't find v0.1 tag; using current HEAD"
  FORK_FROM="$("$HARNESS" log | head -1 | awk '{print $1}')"
fi
note "forking from snapshot $FORK_FROM"

# Create the experimental branch and check out.
"$HARNESS" branch experimental "$FORK_FROM" 2>&1 || note "branch may already exist"
"$HARNESS" checkout experimental 2>&1 | tail -3

# Diverge: replace test-runner with a more aggressive variant only on
# experimental. Same module name, different content (configHash differs
# from main's test-runner).
cat > "$SOAK_DIR/.claude/skills/test-runner/SKILL.md" <<'EOF'
---
name: test-runner
description: EXPERIMENTAL — runs tests with verbose output and bisects on first failure.
---

# test-runner (experimental)

Detect the test runner. Run with maximum verbosity. On first failure,
attempt `git bisect` automatically using the test as the predicate.
Report the bisected commit + a one-line summary of its diff.

Risk: bisecting can be expensive; only do it on suites <2 min.
EOF
note "diverged .claude/skills/test-runner/SKILL.md (experimental variant)"

suggest "$(cat <<EOF
  cd $SOAK_DIR
  claude --model claude-haiku-4-5-20251001
  > what does test-runner do on this branch?
  /exit

After exiting:
  $HARNESS log | head -10
  # Expect: a fork-kind snapshot, then an auto on \`experimental\` branch.
  # The DAG now has two branches — main (with v0.1 tag) and experimental.
  $HARNESS diff <main-day-5-id> <experimental-day-6-id>
  # Expect: ~ skill test-runner. Same name, different configHash.
EOF
)"
