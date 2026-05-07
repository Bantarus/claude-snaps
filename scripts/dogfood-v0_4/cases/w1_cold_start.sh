# Workflow W1 — cold start → first capture (5 cases).
#
# Verifies the v0.4.x init contract and the codePin populate-from-git
# rule on the first hook fire after init.
#
# NOTE: case functions run with `set -e` already disabled by the
# runner (see lib-tap.sh run_case). Do NOT re-enable `set -e` inside
# a case body — let assertions return 1 to record failures without
# killing the runner.

w1_1_init_in_empty_dir() {
  fixture_empty_git_project
  ( cd "$FIXTURE_DIR" && "$HARNESS" init >/dev/null 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "init exits 0"
  assert_file_exists "$FIXTURE_DIR/.harness/HEAD"           ".harness/HEAD present"
  assert_file_exists "$FIXTURE_DIR/.harness/config"         ".harness/config present"
  assert_file_exists "$FIXTURE_DIR/.harness/lineage.sqlite" ".harness/lineage.sqlite present"
  assert_dir_exists  "$FIXTURE_DIR/.harness/snapshots"      ".harness/snapshots/ scaffold present"
  local head; head=$(read_head_pointer "$FIXTURE_DIR")
  assert_equal "ref: refs/heads/main" "$head" "HEAD points at main branch ref"
}
register_case "W1.1 init in empty git dir" w1_1_init_in_empty_dir

# W1.2 — second `harness init` on an existing .harness/. Prompt says
# "idempotent; no error", but current v0.4.x CLI exits 1 with the
# "already exists" guidance. Assert current behavior; flag as v0.4.x
# backlog (init should either be idempotent or the prompt should be
# amended to match the current contract).
w1_2_init_refuses_existing() {
  fixture_empty_git_project
  ( cd "$FIXTURE_DIR" && "$HARNESS" init >/dev/null 2>&1 )
  local rc1=$?
  local head1; head1=$(read_head_pointer "$FIXTURE_DIR")
  local out2
  out2=$( ( cd "$FIXTURE_DIR" && "$HARNESS" init 2>&1 ) || true )
  local rc2
  ( cd "$FIXTURE_DIR" && "$HARNESS" init >/dev/null 2>&1 )
  rc2=$?
  local head2; head2=$(read_head_pointer "$FIXTURE_DIR")
  assert_exit 0 "$rc1" "first init exits 0"
  assert_exit 1 "$rc2" "second init exits 1 (already-exists; current v0.4.x behavior)"
  assert_contains "$out2" "already exists" "second init prints already-exists guidance"
  assert_contains "$out2" "harness reindex" "second init suggests reindex"
  assert_equal "$head1" "$head2" "HEAD unchanged across refused re-init"
}
register_case "W1.2 init on existing .harness exits 1 with reindex hint" w1_2_init_refuses_existing

w1_3_codepin_null_in_non_git_dir() {
  fixture_empty_project   # no .git initialized
  ( cd "$FIXTURE_DIR" && "$HARNESS" init >/dev/null 2>&1 )
  mkdir -p "$FIXTURE_DIR/.claude/skills/x"
  cat > "$FIXTURE_DIR/.claude/skills/x/SKILL.md" <<'SKILL'
---
name: x
description: x
---
# x
SKILL
  fire_session_start "$FIXTURE_DIR" w1-3 startup
  local blob; blob=$(read_head_blob "$FIXTURE_DIR")
  assert_json_path "$blob" '.codePin' "null" "codePin is null when project has no git repo"
}
register_case "W1.3 codePin null when project has no git" w1_3_codepin_null_in_non_git_dir

w1_4_codepin_populated_in_git_dir() {
  fixture_empty_git_project
  ( cd "$FIXTURE_DIR" && "$HARNESS" init >/dev/null 2>&1 )
  mkdir -p "$FIXTURE_DIR/.claude/skills/x"
  cat > "$FIXTURE_DIR/.claude/skills/x/SKILL.md" <<'SKILL'
---
name: x
description: x
---
# x
SKILL
  local git_head
  git_head=$(cd "$FIXTURE_DIR" && git rev-parse HEAD)
  fire_session_start "$FIXTURE_DIR" w1-4 startup
  local blob; blob=$(read_head_blob "$FIXTURE_DIR")
  assert_json_path "$blob" '.codePin' "$git_head" "codePin matches current git HEAD sha"
}
register_case "W1.4 codePin populated in git project" w1_4_codepin_populated_in_git_dir

w1_5_init_with_branch_flag() {
  fixture_empty_git_project
  ( cd "$FIXTURE_DIR" && "$HARNESS" init --branch dev >/dev/null 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "init --branch dev exits 0"
  local head; head=$(read_head_pointer "$FIXTURE_DIR")
  assert_equal "ref: refs/heads/dev" "$head" "HEAD points at refs/heads/dev"
}
register_case "W1.5 init with --branch flag" w1_5_init_with_branch_flag
