# Workflow W8 — `harness install-hook` (5 cases).
#
# Verifies the hook-config-merging behavior across .claude/settings.json
# pre-conditions (none, exists+model, exists+conflicting hook), git
# vs non-git projects, and dirty-tree refusal.

w8_1_no_claude_dir() {
  fixture_empty_git_project
  ( cd "$FIXTURE_DIR" && "$HARNESS" init >/dev/null )
  # Remove the .claude/ scaffold the baseline fixture would create.
  rm -rf "$FIXTURE_DIR/.claude"
  local out
  out=$( ( cd "$FIXTURE_DIR" && echo y | "$HARNESS" install-hook ) 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "install-hook exits 0"
  assert_file_exists "$FIXTURE_DIR/.claude/settings.json" "settings.json created"
  local s; s=$(cat "$FIXTURE_DIR/.claude/settings.json")
  assert_contains "$s" '"SessionStart"'    "SessionStart entry present"
  assert_contains "$s" '"UserPromptSubmit"' "UserPromptSubmit entry present"
  assert_contains "$s" '"harness-hook"' "command points at harness-hook"
}
register_case "W8.1 install-hook on git project, no .claude/" w8_1_no_claude_dir

w8_2_existing_settings_with_model() {
  fixture_empty_git_project
  ( cd "$FIXTURE_DIR" && "$HARNESS" init >/dev/null )
  mkdir -p "$FIXTURE_DIR/.claude"
  echo '{"model": "claude-haiku-4-5-20251001"}' > "$FIXTURE_DIR/.claude/settings.json"
  local out
  out=$( ( cd "$FIXTURE_DIR" && echo y | "$HARNESS" install-hook ) 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "install-hook exits 0"
  local s; s=$(cat "$FIXTURE_DIR/.claude/settings.json")
  assert_contains "$s" "claude-haiku-4-5-20251001" "model field preserved"
  assert_contains "$s" '"SessionStart"' "SessionStart added"
  assert_contains "$s" '"UserPromptSubmit"' "UserPromptSubmit added"
}
register_case "W8.2 install-hook merges into existing settings.json" w8_2_existing_settings_with_model

# W8.3 — conflicting hook entry already present. Current v0.4.x
# behavior: install-hook MERGES alongside (appends harness-hook to the
# existing SessionStart array; user-side hook untouched). Exits 0.
w8_3_conflicting_hook_merges() {
  fixture_empty_git_project
  ( cd "$FIXTURE_DIR" && "$HARNESS" init >/dev/null )
  mkdir -p "$FIXTURE_DIR/.claude"
  cat > "$FIXTURE_DIR/.claude/settings.json" <<'JSON'
{
  "hooks": {
    "SessionStart": [
      {"hooks": [{"type": "command", "command": "/some/other/script"}]}
    ]
  }
}
JSON
  local out
  out=$( ( cd "$FIXTURE_DIR" && echo y | "$HARNESS" install-hook ) 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "install-hook exits 0 (current: merge alongside)"
  local s; s=$(cat "$FIXTURE_DIR/.claude/settings.json")
  assert_contains "$s" "/some/other/script" "user's existing hook entry preserved"
  assert_contains "$s" "harness-hook"       "harness-hook appended to SessionStart"
  assert_contains "$s" "UserPromptSubmit"   "UserPromptSubmit added even when SessionStart had a foreign entry"
}
register_case "W8.3 install-hook merges alongside conflicting hook entry" w8_3_conflicting_hook_merges

w8_4_non_git_project() {
  fixture_empty_project   # no .git
  ( cd "$FIXTURE_DIR" && "$HARNESS" init >/dev/null )
  local out
  out=$( ( cd "$FIXTURE_DIR" && echo y | "$HARNESS" install-hook ) 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "install-hook exits 0 in non-git project"
  assert_file_exists "$FIXTURE_DIR/.claude/settings.json" "settings.json created"
}
register_case "W8.4 install-hook works in non-git project" w8_4_non_git_project

# W8.5 — committed but dirty settings.json. install-hook MUST refuse
# unless --force.
w8_5_dirty_refused_without_force() {
  fixture_empty_git_project
  ( cd "$FIXTURE_DIR" && "$HARNESS" init >/dev/null )
  mkdir -p "$FIXTURE_DIR/.claude"
  echo '{}' > "$FIXTURE_DIR/.claude/settings.json"
  ( cd "$FIXTURE_DIR" && git add .claude/settings.json && git -c commit.gpgsign=false commit -q -m "init settings" )
  # Mutate the now-tracked file → dirty tree.
  echo '{"model": "x"}' > "$FIXTURE_DIR/.claude/settings.json"
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" install-hook ) 2>&1 )
  local rc=$?
  assert_exit 1 "$rc" "install-hook on dirty tree exits 1"
  assert_contains "$out" "unstaged" "error names unstaged changes"
  assert_contains "$out" "--force" "error mentions --force"
  # --force resolves it.
  out=$( ( cd "$FIXTURE_DIR" && echo y | "$HARNESS" install-hook --force ) 2>&1 )
  local rc2=$?
  assert_exit 0 "$rc2" "install-hook --force on dirty tree exits 0"
  local s; s=$(cat "$FIXTURE_DIR/.claude/settings.json")
  assert_contains "$s" "harness-hook" "hook now installed after --force"
}
register_case "W8.5 install-hook on dirty settings.json refused without --force" w8_5_dirty_refused_without_force
