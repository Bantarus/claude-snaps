#!/usr/bin/env bash
# Day 07 — back to main, no mutations. Inside the session: /clear.
# Then a separate `claude --continue` after exit.
#
# Tests in v0.3 semantics:
#   - empty diff readability ("the boring floor")
#   - /clear behavior: does Claude Code mint a new session_id? (Yes,
#     historically.) v0.3 hook treats them as independent sessions
#     either way; the shared composition means the same snapshot
#     receives attribution from both.
#   - resume behavior: claude --continue resumes the original session.
#     Per spec/format.md §4.6, the host fires SessionStart on resume
#     too (with source=resume). UserPromptSubmit fires on every prompt
#     regardless — that's the load-bearing assertion.
#
# FOOTGUN WORKAROUND: harness checkout does NOT revert the working
# tree in v0.3 (rolled-forward v0.2 finding; v0.4 candidate is
# `harness checkout --apply`). Day 6 left the working tree on
# experimental's test-runner content. We restore main's content
# manually below so the no-op probe sees actual no-op composition
# (otherwise the day-7 hook fire would write a new auto snapshot
# capturing experimental's content under branch=main).

source "$(dirname "$0")/lib.sh"
require_soak_dir
say "day 07 — no-op session on main + /clear probe + resume probe"

cd "$SOAK_DIR"
"$HARNESS" checkout main 2>&1 | tail -2
note "checked out main; restoring main's working-tree content (FOOTGUN workaround)"

# Restore main's test-runner content (mirrors what 02-add-skill.sh wrote).
# Without this, working tree still carries day-6's experimental variant
# and the next hook fire would produce a spurious snapshot.
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
note "restored main's test-runner SKILL.md; working tree now matches main lineage"

suggest "$(cat <<EOF
  cd $SOAK_DIR

Session 1 (with mid-session /clear):
  claude --model claude-haiku-4-5-20251001
  > nothing to do today, just checking in.
  /clear
  > say hi after the clear
  /exit

Session 2 (resume after clear):
  claude --continue
  > What's the difference between sync and async request handlers?
  /exit
  # Note: --continue resumes the most-recent session, which is the
  # POST-clear session_id (not the original pre-clear one). Verify in
  # the trajectory output below.

After both sessions exit, verify:

  $HARNESS log | head -5
  # Expect: NO new snapshots vs end of day 06 (after the FOOTGUN
  # restore). Composition matches main's last snapshot, so all fires
  # take the no-change path (attribution-only). If you DO see a new
  # snapshot, the FOOTGUN workaround above didn't fully match —
  # diff against the expected main composition to see what drifted.

  $HARNESS diff <day-5-tag-id> <day-7-tip-id>
  # Expect: '0 added, 0 removed, 0 changed' — the boring-floor diff.
  # Does the output gracefully say no-difference, or produce noise?

  $HARNESS sessions
  # Expect: 3 session ids visible after this day:
  #   - the original Session 1 id (the one before /clear)
  #   - a NEW id minted at /clear (if Claude Code mints a new id on
  #     /clear; this is empirically what happens — verify here)
  #   - whatever id Session 2 (--continue) reports (typically the
  #     post-clear id, since --continue resumes the most recent).

  # Trajectory checks:
  $HARNESS sessions <session-1-pre-clear-id>
  # Expect: session_start + at least one user_prompt, all pointing at
  # the same snapshot (= markers throughout).

  $HARNESS sessions <session-1-post-clear-id>
  # Expect: a fresh trajectory starting with session_start (since /clear
  # minted a new session) — but pointing at the SAME snapshot id as
  # pre-clear (composition unchanged → attribution-only).

  $HARNESS sessions <session-2-resumed-id>
  # v0.3 expectation per §4.6: at least one user_prompt row from the
  # resumed session. May ALSO have a session_start with source=resume
  # if your Claude Code install fires it on resume (the §4.6 narrative
  # says it does — verify empirically). Either way, user_prompt rows
  # are the load-bearing assertion.

  $HARNESS log --with-sessions | head -3
  # Expect: the most-recent snapshot row shows '[3 sessions]' (or
  # however many you actually fired against this composition).
EOF
)"
