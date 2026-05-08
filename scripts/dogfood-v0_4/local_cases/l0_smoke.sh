# Smoke — verifies the plumbing works without burning many tokens.
# One headless invocation, smallest possible prompt, no tool use.
# Use:  bash scripts/dogfood-v0_4/local-observe.sh --smoke

l0_1_one_headless_invocation_fires_hooks() {
  fixture_baseline_no_apm
  local sid; sid=$(local_uuid)
  # Single headless prompt — should fire SessionStart + UserPromptSubmit.
  set +o pipefail
  local out
  out=$(local_claude "$FIXTURE_DIR" "$sid" "respond with just OK" 2>&1)
  local rc=$?
  set -o pipefail
  assert_exit 0 "$rc" "claude -p exits 0"
  # At least one snapshot blob materialized.
  local blobs; blobs=$(count_snapshot_blobs "$FIXTURE_DIR")
  if [ "$blobs" -lt 1 ]; then
    _assert_fail "no snapshot written by claude -p" \
      "claude rc=$rc" "claude stdout/stderr (head): $(printf '%s' "$out" | head -3)"
    return 1
  fi
  # The pinned session id was recorded.
  local sessions
  sessions=$( ( cd "$FIXTURE_DIR" && "$HARNESS" sessions ) 2>&1 )
  assert_contains "$sessions" "$sid" "session_id pinned by --session-id was recorded"
  # The trajectory has at least one event.
  local count; count=$(trajectory_count "$FIXTURE_DIR" "$sid")
  if [ "$count" -lt 1 ]; then
    _assert_fail "trajectory empty for pinned session_id"
  fi
}
register_case "L0.1 single claude -p fires hooks; pinned session_id recorded" l0_1_one_headless_invocation_fires_hooks
