#!/usr/bin/env bash
# Day 07 — back to main, no mutations. Inside the session: /clear.
# Then a separate `claude --continue` after exit.
#
# Tests in v0.2 semantics:
#   - empty diff readability ("the boring floor")
#   - /clear behavior: does Claude Code mint a new session_id? (Yes,
#     historically.) v0.2 hook treats them as independent sessions
#     either way; the shared composition means the same snapshot
#     receives attribution from both.
#   - resume behavior: claude --continue resumes the original session;
#     SessionStart does NOT fire on resume, but UserPromptSubmit fires
#     on the first prompt. v0.2 closes the original soak's resume-gap
#     finding here.

source "$(dirname "$0")/lib.sh"
require_soak_dir
say "day 07 — no-op session on main + /clear probe + resume probe"

cd "$SOAK_DIR"
"$HARNESS" checkout main 2>&1 | tail -2
note "checked out main; no .claude/ mutations this day"

suggest "$(cat <<EOF
  cd $SOAK_DIR

Session 1 (with mid-session /clear):
  claude --model claude-haiku-4-5-20251001
  > nothing to do today, just checking in.
  /clear
  > say hi after the clear
  /exit

Session 2 (resume — see PROMPTS.md):
  claude --continue
  > <follow-up>
  /exit

After both sessions exit, verify:

  $HARNESS log | head -5
  # Expect: NO new snapshots vs end of day 06. Composition is unchanged
  # since main was last touched, so all fires take the no-change path
  # (attribution-only).

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
  # CRITICAL: should have NO session_start row (resume skips it) and
  # one or more user_prompt rows. This is the v0.2 resume-gap closure.
  # If you see a session_start here — Claude Code did NOT actually
  # resume; it minted a new session. Note the observation.

  $HARNESS log --with-sessions | head -3
  # Expect: the most-recent snapshot row shows '[3 sessions]' (or
  # however many you actually fired against this composition).
EOF
)"
