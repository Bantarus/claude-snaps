# Workflow L3 — v0.5 plugin contract pre-flight (real claude -p drift detectors).
#
# These cases lock the empirical answers from the prospective plugin probe
# pass run on 2026-05-09 against Claude Code 2.1.128 and APM 0.8.11. The
# kickoff at docs/plugin-kickoff-prompt.md gates step 1 (build the plugin
# shell) on probes 1–7 having green drift detectors. When CC 2.1.x or APM
# 0.8.x ships a behavior change, these cases turn red BEFORE someone burns
# days authoring against a stale loader contract.
#
# See docs/plugin-kickoff-prompt.md "Verified pins (plugin)" for rationale.

# Build a minimal probe plugin under $CIP_SCRATCH and echo its absolute
# path. Idempotent — re-creates from scratch every call.
_l3_build_probe_plugin() {
  local pdir="$CIP_SCRATCH/l3-probe-plugin-$1"
  rm -rf "$pdir"
  mkdir -p "$pdir/.claude-plugin" "$pdir/skills/probe-skill" "$pdir/commands" "$pdir/agents" "$pdir/hooks"
  cat > "$pdir/.claude-plugin/plugin.json" <<JSON
{ "name": "l3-probe", "version": "$2", "description": "L3 probe scaffold." }
JSON
  cat > "$pdir/skills/probe-skill/SKILL.md" <<'MD'
---
name: probe-skill
description: "L3 probe canary skill. Use when the user says 'l3 canary'."
---

When triggered, output the literal string `L3_CANARY_SKILL_BODY`.
MD
  cat > "$pdir/commands/status.md" <<'MD'
---
description: L3 probe filename-mapping check (status.md).
---

Run `echo L3_CANARY_CMD_STATUS` and output the result verbatim.
MD
  cat > "$pdir/commands/probe-status.md" <<'MD'
---
description: L3 probe multi-word filename (probe-status.md).
---

Run `echo L3_CANARY_CMD_PROBE_STATUS` and output the result verbatim.
MD
  cat > "$pdir/commands/noinvoke.md" <<'MD'
---
description: L3 probe disable-model-invocation.
disable-model-invocation: true
---

Run `echo L3_CANARY_CMD_NOINVOKE` and output the result verbatim.
MD
  cat > "$pdir/agents/probe-agent.md" <<'MD'
---
name: probe-agent
description: "L3 probe canary subagent."
tools: Bash
model: haiku
---

You are the L3 probe subagent.
MD
  cat > "$pdir/hooks/hooks.json" <<JSON
{
  "hooks": {
    "SessionStart": [{"matcher": "*", "hooks": [{"type": "command", "command": "sh -c 'echo SS_\$(date -u +%FT%T.%3NZ) >> \"$pdir/hook.log\"'"}]}],
    "UserPromptSubmit": [{"matcher": "*", "hooks": [{"type": "command", "command": "sh -c 'echo UPS_\$(date -u +%FT%T.%3NZ) >> \"$pdir/hook.log\"'"}]}],
    "SessionEnd": [{"matcher": "*", "hooks": [{"type": "command", "command": "sh -c 'echo SE_\$(date -u +%FT%T.%3NZ) >> \"$pdir/hook.log\"'"}]}]
  }
}
JSON
  printf '%s\n' "$pdir"
}

# Run claude -p loaded against $1=plugin-dir, $2=cwd, $3=prompt. Stdout
# is captured by caller; non-persistent so we don't leak JSONLs into
# ~/.claude/projects/.
_l3_claude_p_plugin() {
  ( cd "$2" && claude --plugin-dir "$1" -p \
      --no-session-persistence \
      --model "$LOCAL_MODEL" \
      --permission-mode "$LOCAL_PERM_MODE" \
      --output-format text \
      "$3" </dev/null )
}

# L3.1 — `--plugin-dir` loads a plugin in `-p` mode without `/plugin
# install` first. Hook log records all 3 events (SessionStart,
# UserPromptSubmit, SessionEnd) for a single one-shot. This is the
# foundational answer; if it fails, plugin work cannot proceed.
l3_1_plugin_dir_loads_in_p_mode() {
  local pdir; pdir=$(_l3_build_probe_plugin l31 0.0.1)
  local cwd; cwd=$(mktemp -d "$CIP_SCRATCH/l31-cwd.XXXXXX")
  _l3_claude_p_plugin "$pdir" "$cwd" "Reply only with L3_LOADED." > "$cwd/out.txt" 2>&1
  assert_exit 0 $? "claude -p --plugin-dir exits 0"
  assert_file_contains "$cwd/out.txt" "L3_LOADED" "model produced canary string"
  assert_file_exists "$pdir/hook.log" "plugin hook log written"
  local hook_events; hook_events=$(grep -oE '^(SS|UPS|SE)' "$pdir/hook.log" | tr '\n' ',' | sed 's/,$//')
  assert_equal "SS,UPS,SE" "$hook_events" "all 3 hook events fire in order on a single -p run"
}
register_case "L3.1 DRIFT-DETECT: --plugin-dir loads plugin in -p mode; SessionStart+UserPromptSubmit+SessionEnd fire" l3_1_plugin_dir_loads_in_p_mode

# L3.2 — Slash-command namespace mapping. Plugin name `l3-probe` and
# command file `commands/status.md` resolve to `/l3-probe:status`.
# Multi-word filename `probe-status.md` resolves to
# `/l3-probe:probe-status` (filename stem becomes command name; plugin
# name is the prefix, NOT concatenated).
l3_2_command_namespace_mapping() {
  local pdir; pdir=$(_l3_build_probe_plugin l32 0.0.1)
  local cwd; cwd=$(mktemp -d "$CIP_SCRATCH/l32-cwd.XXXXXX")
  _l3_claude_p_plugin "$pdir" "$cwd" "/l3-probe:status" > "$cwd/out.txt" 2>&1
  assert_exit 0 $? "/l3-probe:status invokes status.md"
  assert_file_contains "$cwd/out.txt" "L3_CANARY_CMD_STATUS" "status.md body fired (filename stem = command name)"
  _l3_claude_p_plugin "$pdir" "$cwd" "/l3-probe:probe-status" > "$cwd/out2.txt" 2>&1
  assert_exit 0 $? "/l3-probe:probe-status invokes probe-status.md"
  assert_file_contains "$cwd/out2.txt" "L3_CANARY_CMD_PROBE_STATUS" "multi-word filename maps verbatim"
}
register_case "L3.2 DRIFT-DETECT: command namespace = /<plugin-name>:<filename-stem>" l3_2_command_namespace_mapping

# L3.3 — SessionEnd timing. The hook fires AFTER the last assistant
# turn lands in the JSONL transcript (delta observed: ~60 ms on
# 2.1.128). The kickoff's open question on auto-ingest via SessionEnd
# depends on this; if SessionEnd starts firing BEFORE the JSONL is
# flushed, harness ingest-session would miss the last turn.
l3_3_session_end_after_jsonl_flush() {
  local pdir; pdir=$(_l3_build_probe_plugin l33 0.0.1)
  local cwd; cwd=$(mktemp -d "$CIP_SCRATCH/l33-cwd.XXXXXX")
  local sid; sid=$(local_uuid)
  ( cd "$cwd" && claude --plugin-dir "$pdir" -p \
      --session-id "$sid" \
      --model "$LOCAL_MODEL" \
      --permission-mode "$LOCAL_PERM_MODE" \
      --tools "" \
      --output-format text \
      "Reply only with L3_FLUSH_OK." </dev/null >/dev/null 2>&1 )
  assert_exit 0 $? "persistent claude -p exits 0"
  local predicted; predicted=$(echo -n "$cwd" | sed 's/[^a-zA-Z0-9]/-/g')
  local jsonl="$HOME/.claude/projects/$predicted/$sid.jsonl"
  assert_file_exists "$jsonl" "session JSONL persisted"
  # Last assistant timestamp in JSONL.
  local last_assist_ms
  last_assist_ms=$( jq -r 'select(.type=="assistant") | .timestamp' "$jsonl" 2>/dev/null \
    | tail -1 | python3 -c "import sys,datetime; t=sys.stdin.read().strip(); print(int(datetime.datetime.fromisoformat(t.replace('Z','+00:00')).timestamp()*1000))" )
  # SessionEnd hook timestamp from log.
  local se_line; se_line=$(grep -E '^SE_' "$pdir/hook.log" | tail -1 | sed 's/^SE_//')
  local se_ms
  se_ms=$(python3 -c "import sys,datetime; t='$se_line'; print(int(datetime.datetime.fromisoformat(t.replace('Z','+00:00')).timestamp()*1000))")
  # SessionEnd must be >= last assistant turn (allow ms equality).
  if [ "$se_ms" -lt "$last_assist_ms" ]; then
    _assert_fail "SessionEnd ms ($se_ms) < last-assistant ms ($last_assist_ms) — hook fired before flush"
  fi
  rm -rf "$HOME/.claude/projects/$predicted"
}
register_case "L3.3 DRIFT-DETECT: SessionEnd hook fires AFTER last assistant turn lands in JSONL" l3_3_session_end_after_jsonl_flush

# L3.4 — Plugin hooks merge with project-level .claude/settings.json
# hooks. Both fire on SessionStart; the merge is additive, not
# replacing. Order observed on 2.1.128: project hook fires first,
# plugin hook second. The kickoff's open question on harness
# install-hook migration depends on this — without merge, plugin
# users would lose their project-level hook config on every install.
l3_4_hooks_merge_project_and_plugin() {
  local pdir; pdir=$(_l3_build_probe_plugin l34 0.0.1)
  local cwd; cwd=$(mktemp -d "$CIP_SCRATCH/l34-cwd.XXXXXX")
  mkdir -p "$cwd/.claude"
  cat > "$cwd/.claude/settings.json" <<JSON
{
  "hooks": {
    "SessionStart": [
      {"matcher": "*", "hooks": [{"type": "command", "command": "sh -c 'echo PROJECT_SS >> \"$pdir/hook.log\"'"}]}
    ]
  }
}
JSON
  _l3_claude_p_plugin "$pdir" "$cwd" "Reply only with OK." >/dev/null 2>&1
  assert_exit 0 $? "merged-hooks claude -p exits 0"
  local sources; sources=$(grep -oE '^(PROJECT_SS|SS_)' "$pdir/hook.log" | tr '\n' ',' | sed 's/,$//')
  assert_contains "$sources" "PROJECT_SS" "project-level hook fired"
  assert_contains "$sources" "SS_"        "plugin-level hook fired"
}
register_case "L3.4 DRIFT-DETECT: plugin hooks merge with project .claude/settings.json (both fire)" l3_4_hooks_merge_project_and_plugin

# L3.5 — `disable-model-invocation: true` on a slash command. User
# can still type the slash command directly. The model cannot
# auto-invoke it (the command is hidden from the model's slash list).
# /harness:snap and /harness:restore in the planned plugin set this
# flag — they're user-only by design.
l3_5_disable_model_invocation_user_typed() {
  local pdir; pdir=$(_l3_build_probe_plugin l35 0.0.1)
  local cwd; cwd=$(mktemp -d "$CIP_SCRATCH/l35-cwd.XXXXXX")
  _l3_claude_p_plugin "$pdir" "$cwd" "/l3-probe:noinvoke" > "$cwd/out.txt" 2>&1
  assert_exit 0 $? "user-typed slash with disable-model-invocation exits 0"
  assert_file_contains "$cwd/out.txt" "L3_CANARY_CMD_NOINVOKE" "user-typed /noinvoke executes"
}
register_case "L3.5 DRIFT-DETECT: disable-model-invocation=true allows user-typed slash invocation" l3_5_disable_model_invocation_user_typed

# L3.6 — Plugin loader does NOT enforce semver compatibility against
# the host CLI. A `version: 999.0.0-mismatched` plugin loads fine,
# hooks fire, commands work. The kickoff's open question 10
# (plugin↔CLI version mismatch) is therefore a NON-issue at the
# loader layer — the failure mode is a user-visible behavior mismatch
# at runtime when harness-hook semantics change, not a load error.
l3_6_loader_ignores_version_mismatch() {
  local pdir; pdir=$(_l3_build_probe_plugin l36 999.0.0-mismatched)
  local cwd; cwd=$(mktemp -d "$CIP_SCRATCH/l36-cwd.XXXXXX")
  _l3_claude_p_plugin "$pdir" "$cwd" "Reply only with L3_VER_OK." > "$cwd/out.txt" 2>&1
  assert_exit 0 $? "plugin with weird version loads"
  assert_file_contains "$cwd/out.txt" "L3_VER_OK" "model output unaffected by version string"
  assert_file_exists "$pdir/hook.log" "hook fired despite version mismatch"
}
register_case "L3.6 DRIFT-DETECT: plugin loader accepts arbitrary version strings (no semver enforcement)" l3_6_loader_ignores_version_mismatch

# L3.7 — APM 0.8.11 hybrid mode against a Claude Code plugin layout.
# `apm install <local-plugin-dir>` merges the plugin's hooks into
# .claude/settings.json BUT does NOT deploy skills/, commands/,
# agents/ to .claude/. Plugin primitives stay in
# apm_modules/_local/. This is a documented limitation today; if APM
# 0.9+ starts deploying primitives, this case turns red and the
# kickoff's "APM hybrid distribution" path becomes viable as
# originally specified.
l3_7_apm_hybrid_only_merges_hooks() {
  command -v apm >/dev/null 2>&1 || { _assert_fail "apm CLI not on PATH"; return; }
  local pdir; pdir=$(_l3_build_probe_plugin l37 0.0.1)
  cat > "$pdir/apm.yml" <<YAML
name: l3-probe
version: 0.0.1
target: claude
type: hybrid
YAML
  local cdir; cdir=$(mktemp -d "$CIP_SCRATCH/l37-consumer.XXXXXX")
  cat > "$cdir/apm.yml" <<YAML
name: l3-consumer
version: 0.0.1
target: claude
dependencies:
  apm:
    - $pdir
YAML
  ( cd "$cdir" && apm install --target claude >/dev/null 2>&1 )
  assert_exit 0 $? "apm install local-plugin-dir succeeds"
  assert_file_exists  "$cdir/.claude/settings.json"   "hooks merged into .claude/settings.json"
  assert_dir_not_exists "$cdir/.claude/skills"        "skills NOT deployed to .claude/skills (APM 0.8.11 hybrid limitation)"
  assert_dir_not_exists "$cdir/.claude/commands"      "commands NOT deployed to .claude/commands"
  assert_dir_not_exists "$cdir/.claude/agents"        "agents NOT deployed to .claude/agents"
  assert_dir_exists "$cdir/apm_modules/_local/$(basename "$pdir")" "plugin staged in apm_modules/_local/"
}
register_case "L3.7 DRIFT-DETECT: APM 0.8.11 hybrid install merges only hooks; primitives NOT deployed (limitation)" l3_7_apm_hybrid_only_merges_hooks
