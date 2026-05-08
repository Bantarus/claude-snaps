# Workflow L2 — v0.5 contract pre-flight (real claude -p drift detectors).
#
# These cases lock the answers to v0.5 open questions probed
# prospectively on 2026-05-08 against Claude Code 2.1.131. Each case
# is a drift detector against the host's behavior — when CC 2.2+ ships
# and changes its hook-event surface, project-dir encoding, or
# attributionSkill semantics, these cases turn red BEFORE someone
# burns 6 days on the v0.5 implementation against a stale contract.
#
# See docs/session-metrics-prompt.md "Verified pins" for the rationale.

# L2.1 — Claude Code emits exactly four hook events in order:
# SessionStart → UserPromptSubmit → Stop → SessionEnd. The v0.5
# ingester relies on SessionEnd as the auto-trigger; if CC removes
# or renames it, ingestion can't be wired automatically.
l2_1_hook_event_inventory() {
  fixture_baseline_no_apm
  local sid; sid=$(local_uuid)
  local log; log="$FIXTURE_DIR/l2-1-events.log"
  : > "$log"
  # Wire all 9 candidate event names. Each fire appends just the
  # event name to the log, in order. Keep the harness-hook entries
  # too so the rest of the harness state is realistic.
  cat > "$FIXTURE_DIR/.claude/settings.json" <<JSON
{
  "model": "claude-haiku-4-5-20251001",
  "hooks": {
    "SessionStart":     [{"matcher": "*", "hooks": [{"type": "command", "command": "jq -r '.hook_event_name' >> '$log' && harness-hook"}]}],
    "UserPromptSubmit": [{"matcher": "*", "hooks": [{"type": "command", "command": "jq -r '.hook_event_name' >> '$log' && harness-hook"}]}],
    "SessionEnd":       [{"matcher": "*", "hooks": [{"type": "command", "command": "jq -r '.hook_event_name' >> '$log'"}]}],
    "Stop":             [{"matcher": "*", "hooks": [{"type": "command", "command": "jq -r '.hook_event_name' >> '$log'"}]}],
    "PreToolUse":       [{"matcher": "*", "hooks": [{"type": "command", "command": "jq -r '.hook_event_name' >> '$log'"}]}],
    "PostToolUse":      [{"matcher": "*", "hooks": [{"type": "command", "command": "jq -r '.hook_event_name' >> '$log'"}]}],
    "SubagentStop":     [{"matcher": "*", "hooks": [{"type": "command", "command": "jq -r '.hook_event_name' >> '$log'"}]}],
    "Notification":     [{"matcher": "*", "hooks": [{"type": "command", "command": "jq -r '.hook_event_name' >> '$log'"}]}],
    "PreCompact":       [{"matcher": "*", "hooks": [{"type": "command", "command": "jq -r '.hook_event_name' >> '$log'"}]}]
  }
}
JSON
  ( cd "$FIXTURE_DIR" && claude -p \
      --session-id "$sid" \
      --model "$LOCAL_MODEL" \
      --permission-mode "$LOCAL_PERM_MODE" \
      --tools "" \
      --output-format text \
      "OK" </dev/null >/dev/null 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "claude -p exits 0"
  local observed; observed=$(cat "$log" | tr '\n' ',' | sed 's/,$//')
  assert_equal "SessionStart,UserPromptSubmit,Stop,SessionEnd" "$observed" \
    "exactly these 4 events fire in order on a single claude -p (CC 2.1.131)"
}
register_case "L2.1 DRIFT-DETECT: hook event inventory = [SessionStart, UserPromptSubmit, Stop, SessionEnd]" l2_1_hook_event_inventory

# L2.2 — Project-dir encoding rule: Claude Code maps cwd to
# ~/.claude/projects/<encoded>/ by replacing every char that isn't
# [a-zA-Z0-9] with a single dash, no collapsing. The v0.5 ingester
# uses this rule to locate the JSONL for a given session.
l2_2_project_dir_encoding() {
  # Test four cwds with different special-char classes. Each must
  # produce the predicted encoded directory. Use unique slugs per
  # case to avoid collisions if local-observe is re-run.
  local stamp; stamp=$(date +%s%N)
  local cases=(
    "$CIP_SCRATCH/l22-simple-$stamp:l22-simple-$stamp"
    "$CIP_SCRATCH/l22-with spaces-$stamp:l22-with-spaces-$stamp"
    "$CIP_SCRATCH/l22-with.dots-$stamp:l22-with-dots-$stamp"
  )
  local sid; sid=$(local_uuid)
  for entry in "${cases[@]}"; do
    local cwd="${entry%%:*}"
    local expected_basename="${entry##*:}"
    mkdir -p "$cwd"
    ( cd "$cwd" && claude -p \
        --session-id "$(local_uuid)" \
        --model "$LOCAL_MODEL" \
        --permission-mode "$LOCAL_PERM_MODE" \
        --tools "" \
        --output-format text \
        "OK" </dev/null >/dev/null 2>&1 )
    # Predicted encoded form: every non-alnum char in the absolute
    # path becomes a dash. Compute and compare.
    local predicted; predicted=$(echo -n "$cwd" | sed 's/[^a-zA-Z0-9]/-/g')
    local actual_dir="$HOME/.claude/projects/$predicted"
    assert_dir_exists "$actual_dir" "encoded dir created for $cwd"
  done
  # Cleanup
  for entry in "${cases[@]}"; do
    local cwd="${entry%%:*}"
    rm -rf "$cwd"
    local predicted; predicted=$(echo -n "$cwd" | sed 's/[^a-zA-Z0-9]/-/g')
    rm -rf "$HOME/.claude/projects/$predicted"
  done
}
register_case "L2.2 DRIFT-DETECT: project-dir encoding = non-alnum-to-single-dash, no collapsing" l2_2_project_dir_encoding

# L2.3 — attributionSkill semantics. Per-turn JSONL field; null when
# no skill is active for the assistant turn. The v0.5 ingester
# captures this into turn_metrics. If the host changes how it
# populates this (e.g., always-set, or sets it on user turns too),
# the ingester's null-handling needs review.
l2_3_attribution_skill_null_without_skill() {
  fixture_baseline_no_apm
  local sid; sid=$(local_uuid)
  local_claude "$FIXTURE_DIR" "$sid" "OK" >/dev/null 2>&1
  local rc=$?
  assert_exit 0 "$rc" "claude -p exits 0"
  # Locate the JSONL for this session. Claude Code maps cwd via the
  # encoding rule from L2.2.
  local predicted; predicted=$(echo -n "$FIXTURE_DIR" | sed 's/[^a-zA-Z0-9]/-/g')
  local jsonl="$HOME/.claude/projects/$predicted/$sid.jsonl"
  assert_file_exists "$jsonl" "session JSONL written at predicted path"
  # All assistant turns should have attributionSkill null (we ran
  # with --tools "" and no skill triggered).
  local non_null
  non_null=$( jq -c 'select(.type == "assistant" and .attributionSkill != null) | .attributionSkill' "$jsonl" 2>/dev/null | wc -l )
  assert_equal "0" "$non_null" "all assistant turns have attributionSkill=null when no skill active"
  # Cleanup the project dir we created.
  rm -rf "$HOME/.claude/projects/$predicted"
}
register_case "L2.3 DRIFT-DETECT: attributionSkill is null on assistant turns when no skill active" l2_3_attribution_skill_null_without_skill
