# Workflow W2 — hook firing surface (7 cases).
#
# Asserts the dual-event capture contract from spec/hooks.md:
# session_start vs user_prompt event_kinds, source pass-through,
# composition-based dedup (same composition → 1 snapshot blob, N
# attribution rows), and defense-in-depth on non-harness cwd.

w2_1_session_start_startup() {
  fixture_baseline_no_apm
  fire_session_start "$FIXTURE_DIR" w2-1 startup
  assert_count 1 "$(count_snapshot_blobs "$FIXTURE_DIR")" "exactly 1 snapshot blob"
  assert_count 1 "$(trajectory_count "$FIXTURE_DIR" w2-1)" "1 attribution row for w2-1"
  assert_equal "session_start" "$(trajectory_kinds "$FIXTURE_DIR" w2-1)" "event_kind=session_start"
  assert_equal "startup" "$(trajectory_sources "$FIXTURE_DIR" w2-1)" "source=startup recorded"
}
register_case "W2.1 SessionStart source=startup writes snapshot + attribution" w2_1_session_start_startup

w2_2_resume_dedups() {
  fixture_baseline_no_apm
  fire_session_start "$FIXTURE_DIR" w2-2 startup
  fire_session_start "$FIXTURE_DIR" w2-2 resume
  assert_count 1 "$(count_snapshot_blobs "$FIXTURE_DIR")" "still 1 snapshot blob (composition unchanged)"
  assert_count 2 "$(trajectory_count "$FIXTURE_DIR" w2-2)" "2 attribution rows for w2-2"
  local sources; sources=$(trajectory_sources "$FIXTURE_DIR" w2-2 | tr '\n' ',' | sed 's/,$//')
  assert_equal "startup,resume" "$sources" "sources are startup then resume"
  # Both attributions point at the same snapshot.
  local uniq_ids; uniq_ids=$(trajectory_snapshot_ids_short "$FIXTURE_DIR" w2-2 | sort -u | wc -l | tr -d ' ')
  assert_equal "1" "$uniq_ids" "both events point at the same snapshot id"
}
register_case "W2.2 SessionStart source=resume dedups by composition" w2_2_resume_dedups

w2_3_clear_passes_through() {
  fixture_baseline_no_apm
  fire_session_start "$FIXTURE_DIR" w2-3 startup
  fire_session_start "$FIXTURE_DIR" w2-3 clear
  assert_count 2 "$(trajectory_count "$FIXTURE_DIR" w2-3)" "2 attribution rows"
  local sources; sources=$(trajectory_sources "$FIXTURE_DIR" w2-3 | tr '\n' ',' | sed 's/,$//')
  assert_equal "startup,clear" "$sources" "second source=clear"
}
register_case "W2.3 SessionStart source=clear is recorded verbatim" w2_3_clear_passes_through

w2_4_compact_passes_through() {
  fixture_baseline_no_apm
  fire_session_start "$FIXTURE_DIR" w2-4 startup
  fire_session_start "$FIXTURE_DIR" w2-4 compact
  assert_count 2 "$(trajectory_count "$FIXTURE_DIR" w2-4)" "2 attribution rows"
  local sources; sources=$(trajectory_sources "$FIXTURE_DIR" w2-4 | tr '\n' ',' | sed 's/,$//')
  assert_equal "startup,compact" "$sources" "second source=compact"
}
register_case "W2.4 SessionStart source=compact accepted (forward-compat per spec §2.7)" w2_4_compact_passes_through

w2_5_user_prompt_event() {
  fixture_baseline_no_apm
  fire_session_start "$FIXTURE_DIR" w2-5 startup
  fire_user_prompt "$FIXTURE_DIR" w2-5
  assert_count 2 "$(trajectory_count "$FIXTURE_DIR" w2-5)" "2 attribution rows"
  local kinds; kinds=$(trajectory_kinds "$FIXTURE_DIR" w2-5 | tr '\n' ',' | sed 's/,$//')
  assert_equal "session_start,user_prompt" "$kinds" "second event_kind=user_prompt"
}
register_case "W2.5 UserPromptSubmit appends user_prompt attribution" w2_5_user_prompt_event

# W2.6 — dedup-by-composition. The prompt notes that observed_at is
# now() and we don't mock the clock, so the (session_id, observed_at,
# event_kind) PK in the spec doesn't dedupe two real fires. What we
# CAN assert: re-firing on the same composition produces 1 blob (not
# 2) regardless of how many attribution rows accumulate.
w2_6_dedup_by_composition() {
  fixture_baseline_no_apm
  fire_session_start "$FIXTURE_DIR" w2-6 startup
  fire_user_prompt   "$FIXTURE_DIR" w2-6
  fire_user_prompt   "$FIXTURE_DIR" w2-6
  fire_user_prompt   "$FIXTURE_DIR" w2-6
  assert_count 1 "$(count_snapshot_blobs "$FIXTURE_DIR")" "1 snapshot blob despite 4 fires"
  local count; count=$(trajectory_count "$FIXTURE_DIR" w2-6)
  # Trajectory should record at least the 4 events. (Hot-path cache
  # may collapse repeats; spec/hooks.md §2.4 allows this. Assert
  # >= 1, exactly 1 unique snapshot id.)
  if [ "$count" -lt 1 ]; then
    _assert_fail "expected at least 1 attribution row, got $count"
  fi
  local uniq_ids; uniq_ids=$(trajectory_snapshot_ids_short "$FIXTURE_DIR" w2-6 | sort -u | wc -l | tr -d ' ')
  assert_equal "1" "$uniq_ids" "all events point at the same snapshot id"
}
register_case "W2.6 dedup-by-composition: same composition yields one blob" w2_6_dedup_by_composition

# W2.7 — fire the hook in a tmpdir that has no .harness/ ancestor.
# Hook MUST exit 0 (defense-in-depth, spec §1.5) and MUST NOT create
# .harness/ — only `harness init` ever creates it.
w2_7_no_harness_ancestor() {
  fixture_empty_project   # no .harness, no .git
  set +o pipefail
  fire_session_start "$FIXTURE_DIR" w2-7 startup >/dev/null 2>/tmp/cip-w2-7-stderr
  local rc=$?
  set -o pipefail
  assert_exit 0 "$rc" "hook exits 0 even with no .harness ancestor"
  assert_dir_not_exists "$FIXTURE_DIR/.harness" "no .harness/ created by hook"
  rm -f /tmp/cip-w2-7-stderr
}
register_case "W2.7 hook on no-harness dir exits 0; no side effects" w2_7_no_harness_ancestor

# W2.8 — Claude Code 2.1.128 payload contract drift detector.
#
# Synthesizes the EXACT byte shape Claude Code 2.1.128 sends so the
# contract is asserted deterministically in CI (not just behind the
# real-claude local-observe runner). When the host changes its
# payload (adds `model`, moves `permission_mode` to SessionStart,
# etc.), this case turns red and forces a spec/hooks.md §1.1
# amendment. See spec/hooks.md §1.1 "Per-event payload (verified
# against Claude Code 2.1.128)" for the verified shape.
w2_8_real_cc_2_1_128_payload_shape() {
  fixture_baseline_no_apm
  # Real SessionStart payload shape (5 fields exactly): no model,
  # no permission_mode, transcript_path is a real-looking path.
  local sid="11111111-2222-4333-8444-555555555555"
  local tp="/tmp/cip-fake-transcript-${sid}.jsonl"
  jq -nc \
    --arg sid "$sid" --arg cwd "$FIXTURE_DIR" --arg tp "$tp" \
    '{session_id: $sid, transcript_path: $tp, cwd: $cwd,
      hook_event_name: "SessionStart", source: "startup"}' \
    | "$HARNESS_HOOK"
  # Real UserPromptSubmit payload shape (6 fields): permission_mode
  # only here, plus a `prompt` field harness observes-and-ignores.
  jq -nc \
    --arg sid "$sid" --arg cwd "$FIXTURE_DIR" --arg tp "$tp" \
    '{session_id: $sid, transcript_path: $tp, cwd: $cwd,
      hook_event_name: "UserPromptSubmit",
      permission_mode: "plan",
      prompt: "respond with just OK"}' \
    | "$HARNESS_HOOK"
  # Snapshot was written on SessionStart (composition change) — its
  # model and permissionMode fields reflect that fire's payload,
  # which carries neither.
  local blob; blob=$(read_head_blob "$FIXTURE_DIR")
  assert_json_path "$blob" '.model'          "null" "snapshot.model null (CC 2.1.128 omits model)"
  assert_json_path "$blob" '.permissionMode' "null" "snapshot.permissionMode null (CC 2.1.128 sends permission_mode only on UserPromptSubmit; hot-path doesn't update)"
  # Both events landed as attribution rows (proves the hook
  # tolerated the asymmetric payload shapes).
  assert_count 2 "$(trajectory_count "$FIXTURE_DIR" "$sid")" "both events recorded as attributions"
  local kinds; kinds=$(trajectory_kinds "$FIXTURE_DIR" "$sid" | tr '\n' ',' | sed 's/,$//')
  assert_equal "session_start,user_prompt" "$kinds" "event_kinds in order: session_start, user_prompt"
}
register_case "W2.8 DRIFT-DETECT: Claude Code 2.1.128 asymmetric payload yields null model/permissionMode" w2_8_real_cc_2_1_128_payload_shape

# W2.9 — Claude Code 2.1.131 emits SessionEnd + Stop on every
# `claude -p`. The v0.4 hook silently coerces unknown event names to
# "SessionStart" (see packages/hook/src/args.ts:131-136). This case
# locks current behavior: SessionEnd payload → exit 0, recorded as
# a session_start attribution (technically wrong, but stable).
#
# v0.5 will wire SessionEnd → harness ingest-session and add a
# proper event_kind. When that lands, this case will need updating;
# the test label says CURRENT-V0_4 so future-you knows where to look.
#
# Bonus pins from the same probe (2026-05-08, CC 2.1.131):
#   SessionEnd payload  : session_id, transcript_path, cwd,
#                         hook_event_name, reason
#   Stop payload        : session_id, transcript_path, cwd,
#                         hook_event_name, permission_mode,
#                         stop_hook_active, last_assistant_message
#
# `last_assistant_message` carries Claude's response text — same
# privacy class as `prompt`. v0.5 ingester redaction whitelist (see
# spec/format.md §10.2 once landed) MUST exclude it.
w2_9_session_end_tolerated_as_session_start() {
  fixture_baseline_no_apm
  local sid="22222222-3333-4222-9333-444444444444"
  local tp="/tmp/cip-fake-${sid}.jsonl"
  jq -nc \
    --arg sid "$sid" --arg cwd "$FIXTURE_DIR" --arg tp "$tp" \
    '{session_id: $sid, transcript_path: $tp, cwd: $cwd,
      hook_event_name: "SessionEnd", reason: "other"}' \
    | "$HARNESS_HOOK"
  local rc=$?
  assert_exit 0 "$rc" "hook accepts SessionEnd payload without crashing"
  # Currently coerced to session_start. When v0.5 adds a proper
  # session_end event_kind, flip this assertion AND update the
  # case label to remove CURRENT-V0_4.
  assert_count 1 "$(trajectory_count "$FIXTURE_DIR" "$sid")" "1 attribution row recorded"
  local kinds; kinds=$(trajectory_kinds "$FIXTURE_DIR" "$sid" | tr '\n' ',' | sed 's/,$//')
  assert_equal "session_start" "$kinds" "v0.4 coerces SessionEnd to session_start (CURRENT-V0_4 behavior)"
}
register_case "W2.9 CURRENT-V0_4: hook tolerates SessionEnd payload (coerces to session_start)" w2_9_session_end_tolerated_as_session_start
