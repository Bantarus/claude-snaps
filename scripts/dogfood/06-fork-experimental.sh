#!/usr/bin/env bash
# Day 06 — branch divergence: branch off main into experimental,
# modify a skill differently than main.
# Tests: branch creation (no 'fork' kind in v0.2 — just a manual
# snapshot whose `branch` field is the new branch name) and divergent
# lineage.

source "$(dirname "$0")/lib.sh"
require_soak_dir
say "day 06 — fork experimental + diverge"

# Run harness commands from the soak directory.
cd "$SOAK_DIR"

# Get the v0.1 tag's snapshot id as our fork point.
if [ -f "$SOAK_DIR/.harness/refs/tags/v0.1" ]; then
  FORK_FROM="$(cat "$SOAK_DIR/.harness/refs/tags/v0.1")"
  note "found v0.1 tag: $FORK_FROM"
else
  note "warning: v0.1 tag not found; using current HEAD"
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
  # Expect: a manual snapshot on the \`experimental\` branch
  # (parentIds=[<v0.1 tag id>]). The DAG now has two branches — main
  # (with v0.1 tag) and experimental.
  $HARNESS log --branch experimental
  # Expect: just the experimental tip snapshot.
  $HARNESS diff <main-day-5-id> <experimental-day-6-id>
  # Expect: ~ skill test-runner. Same name, different configHash.
EOF
)"
