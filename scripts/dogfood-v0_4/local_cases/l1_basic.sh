# Workflow L1 — basic claude -p coverage (real headless sessions).
#
# Each case fires one or two `claude -p` invocations with --tools ""
# against a tiny model (haiku-4-5 by default) so the cost stays
# minimal. Prompts are deliberately trivial — the test doesn't care
# what Claude says, only that hooks fired and recorded the right
# metadata.

# L1.1 — first claude -p in a fresh harness project. Verify
# SessionStart fires with source=startup, session_id matches the
# UUID we pinned, and event_kinds include both session_start and
# user_prompt.
#
# Drift note (Claude Code 2.1.128): the host does NOT send `model`
# in the hook payload, so snapshot.model is `null` despite our
# --model flag. Asserted as null deliberately — when a future host
# version starts emitting `model`, this case turns red and we update
# spec/hooks.md §1.1's verified-against pin.
l1_1_first_session_records_metadata() {
  fixture_baseline_no_apm
  local sid; sid=$(local_uuid)
  local out
  out=$(local_claude "$FIXTURE_DIR" "$sid" "respond with just OK" 2>&1)
  local rc=$?
  assert_exit 0 "$rc" "claude -p exits 0"
  # Trajectory should include at least session_start + user_prompt.
  local kinds; kinds=$(trajectory_kinds "$FIXTURE_DIR" "$sid" | sort -u | tr '\n' ',' | sed 's/,$//')
  assert_contains "$kinds" "session_start" "trajectory has session_start"
  assert_contains "$kinds" "user_prompt"   "trajectory has user_prompt"
  # First SessionStart should carry source=startup (real value from
  # Claude Code, not a synthesized literal).
  local first_source
  first_source=$(trajectory_sources "$FIXTURE_DIR" "$sid" | head -1)
  assert_equal "startup" "$first_source" "first SessionStart source=startup"
  # Drift detector: model is null on Claude Code 2.1.128 snapshots
  # because the host does not send `model` in either hook event.
  local blob; blob=$(read_head_blob "$FIXTURE_DIR")
  assert_json_path "$blob" '.model' "null" "snapshot.model is null (Claude Code 2.1.128 omits model from hook payload)"
}
register_case "L1.1 fresh claude -p: session_id + source=startup + DRIFT-DETECT model=null" l1_1_first_session_records_metadata

# L1.2 — --resume <id> picks up the existing session and fires
# SessionStart again with source=resume. Verifies the v0.2 dual-event
# capture's resume path works against the real Claude Code
# implementation (not the synthesizer).
l1_2_resume_fires_source_resume() {
  fixture_baseline_no_apm
  local sid; sid=$(local_uuid)
  # First invocation establishes the session.
  local_claude "$FIXTURE_DIR" "$sid" "respond with just OK" >/dev/null 2>&1
  local before_count; before_count=$(trajectory_count "$FIXTURE_DIR" "$sid")
  if [ "$before_count" -lt 1 ]; then
    _assert_fail "first claude -p did not record any attribution"
    return 1
  fi
  # Resume same session.
  local rc
  set +e
  local_claude_resume "$FIXTURE_DIR" "$sid" "say OK again" >/dev/null 2>&1
  rc=$?
  set -e
  assert_exit 0 "$rc" "claude -p --resume exits 0"
  # Trajectory grew.
  local after_count; after_count=$(trajectory_count "$FIXTURE_DIR" "$sid")
  if [ "$after_count" -le "$before_count" ]; then
    _assert_fail "trajectory did not grow on resume" \
      "before=$before_count after=$after_count"
  fi
  # At least one source value beyond the first event should be
  # "resume". (Real Claude may or may not emit additional source
  # values on resume; the spec §1.1 names startup|resume|clear|compact.)
  local sources; sources=$(trajectory_sources "$FIXTURE_DIR" "$sid")
  if ! echo "$sources" | grep -qx "resume"; then
    _assert_fail "no source=resume in trajectory after --resume" \
      "sources observed: $(echo "$sources" | tr '\n' ',' | sed 's/,$//')"
  fi
}
register_case "L1.2 --resume <id> fires SessionStart with source=resume" l1_2_resume_fires_source_resume

# L1.3 — model + permission_mode drift detection.
#
# Earlier drafts of spec/hooks.md §1.1 listed `model` and
# `permission_mode` as available on every hook event; reality
# (Claude Code 2.1.128) is asymmetric: `model` is never sent, and
# `permission_mode` is sent only on UserPromptSubmit. The §2.4 hot-
# path skips re-walking on the second fire (composition unchanged),
# so neither field reaches the snapshot.
#
# This case locks the observed reality: even with --model and
# --permission-mode plan flags, the resulting snapshot has both
# fields null. When Claude Code starts emitting these on
# SessionStart (or harness changes its hot-path semantics), the
# case turns red and forces a spec re-amendment.
l1_3_permission_mode_passthrough() {
  fixture_baseline_no_apm
  local sid; sid=$(local_uuid)
  ( cd "$FIXTURE_DIR" && claude -p \
      --session-id "$sid" \
      --model "$LOCAL_MODEL" \
      --permission-mode plan \
      --tools "" \
      --output-format text \
      "respond with just OK" >/dev/null 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "claude -p --permission-mode plan exits 0"
  local blob; blob=$(read_head_blob "$FIXTURE_DIR")
  assert_json_path "$blob" '.model' "null" \
    "snapshot.model is null (Claude Code 2.1.128 omits model from hook payload)"
  assert_json_path "$blob" '.permissionMode' "null" \
    "snapshot.permissionMode is null (UserPromptSubmit-only field never reaches snapshot via hot-path)"
}
register_case "L1.3 DRIFT-DETECT: model + permissionMode null despite --flags (CC 2.1.128)" l1_3_permission_mode_passthrough

# L1.4 — session-id determinism: re-launching with the same UUID
# against the same composition produces no new snapshot blob. This
# exercises the dedup-by-composition path against real Claude Code
# session_ids (UUIDs) instead of our synthetic short strings.
l1_4_dedup_by_composition_real_session() {
  fixture_baseline_no_apm
  local sid_a; sid_a=$(local_uuid)
  local sid_b; sid_b=$(local_uuid)
  local_claude "$FIXTURE_DIR" "$sid_a" "respond with just OK" >/dev/null 2>&1
  local blobs_after_a; blobs_after_a=$(count_snapshot_blobs "$FIXTURE_DIR")
  local_claude "$FIXTURE_DIR" "$sid_b" "respond with just OK" >/dev/null 2>&1
  local blobs_after_b; blobs_after_b=$(count_snapshot_blobs "$FIXTURE_DIR")
  assert_equal "$blobs_after_a" "$blobs_after_b" \
    "two distinct sessions same composition: still $blobs_after_a blob(s)"
  # Each session should have its own attribution row(s).
  local count_a; count_a=$(trajectory_count "$FIXTURE_DIR" "$sid_a")
  local count_b; count_b=$(trajectory_count "$FIXTURE_DIR" "$sid_b")
  if [ "$count_a" -lt 1 ] || [ "$count_b" -lt 1 ]; then
    _assert_fail "missing attribution rows" \
      "session_a=$count_a session_b=$count_b"
  fi
}
register_case "L1.4 two distinct real sessions, same composition: 1 blob" l1_4_dedup_by_composition_real_session
