# Synthesize Claude-Code-shaped hook fires, piped to $HARNESS_HOOK.
#
# All payloads match the spec/hooks.md §1.1 stdin-JSON contract. The
# hook MUST exit 0 in every case (defense-in-depth, spec §1.5); side
# effects are verified post-fire by reading .harness/ artifacts.
#
# Source after lib.sh (HARNESS_HOOK is exported there).

# fire_session_start <cwd> <session_id> [source]
# source defaults to "startup". Other valid values per spec §1.1:
# resume | clear | compact (and forward-compat unknown values).
fire_session_start() {
  local cwd=$1 sid=$2 source=${3:-startup}
  jq -nc \
    --arg sid "$sid" \
    --arg cwd "$cwd" \
    --arg src "$source" \
    '{session_id: $sid, cwd: $cwd, hook_event_name: "SessionStart",
      transcript_path: "/dev/null", source: $src}' \
    | "$HARNESS_HOOK"
}

# fire_user_prompt <cwd> <session_id>
fire_user_prompt() {
  local cwd=$1 sid=$2
  jq -nc \
    --arg sid "$sid" \
    --arg cwd "$cwd" \
    '{session_id: $sid, cwd: $cwd, hook_event_name: "UserPromptSubmit",
      transcript_path: "/dev/null"}' \
    | "$HARNESS_HOOK"
}

# fire_session_start_with_ctx <cwd> <session_id> <model> <permission_mode> [source]
# Used by W2 / W9 to verify model + permission_mode land on the snapshot.
fire_session_start_with_ctx() {
  local cwd=$1 sid=$2 model=$3 pmode=$4 source=${5:-startup}
  jq -nc \
    --arg sid "$sid" \
    --arg cwd "$cwd" \
    --arg src "$source" \
    --arg m   "$model" \
    --arg pm  "$pmode" \
    '{session_id: $sid, cwd: $cwd, hook_event_name: "SessionStart",
      transcript_path: "/dev/null", source: $src,
      model: $m, permission_mode: $pm}' \
    | "$HARNESS_HOOK"
}

# Corruption-tolerance fixtures. All must result in hook exit 0; the
# difference is whether the hook records anything.
fire_malformed_stdin() {
  local cwd=$1
  printf '{ this is not json' | (cd "$cwd" && "$HARNESS_HOOK")
}

fire_no_stdin() {
  local cwd=$1
  (cd "$cwd" && "$HARNESS_HOOK" </dev/null)
}

# Fall back to CLI flags channel (spec §1.2). Useful when the test
# wants to bypass stdin entirely.
fire_via_cli_flags() {
  local cwd=$1 sid=$2 event_name=${3:-SessionStart}
  "$HARNESS_HOOK" --session-id "$sid" --cwd "$cwd" \
    --hook-event-name "$event_name" </dev/null
}
