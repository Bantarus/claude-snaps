# Workflow W4 — read-only queries (10 cases).
#
# Verifies log / diff / sessions surfaces.

w4_1_log_on_empty() {
  fixture_baseline_no_apm   # init + install-hook, no fires/snaps
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" log ) 2>&1 )
  local rc=$?
  assert_exit 1 "$rc" "log on empty repo exits 1"
  assert_contains "$out" "no commits yet" "error names empty repo"
}
register_case "W4.1 log on empty repo exits 1 with 'no commits yet'" w4_1_log_on_empty

w4_2_log_lineage_with_head() {
  fixture_lineage_3_snapshots
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" log ) 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "log exits 0"
  local rows; rows=$(echo "$out" | grep -cE '^[0-9a-f]{6,}')
  assert_count 3 "$rows" "log shows 3 rows"
  # HEAD annotation marks the newest row.
  local head_row; head_row=$(echo "$out" | head -1)
  assert_contains "$head_row" "(HEAD)" "newest row carries (HEAD) annotation"
}
register_case "W4.2 log lineage_3 shows 3 rows newest-first with HEAD annotation" w4_2_log_lineage_with_head

w4_3_log_limit() {
  fixture_lineage_3_snapshots
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" log --limit=1 ) 2>&1 )
  local rows; rows=$(echo "$out" | grep -cE '^[0-9a-f]{6,}')
  assert_count 1 "$rows" "log --limit=1 returns 1 row"
}
register_case "W4.3 log --limit=1 returns one row" w4_3_log_limit

w4_4_log_branch_filter() {
  fixture_branched   # baseline + 1 snap + branch experimental at same id
  # Diverge experimental from main.
  ( cd "$FIXTURE_DIR" && "$HARNESS" checkout experimental >/dev/null )
  mkdir -p "$FIXTURE_DIR/.claude/skills/exp"
  cat > "$FIXTURE_DIR/.claude/skills/exp/SKILL.md" <<'SKILL'
---
name: exp
description: experimental skill
---
# exp
SKILL
  ( cd "$FIXTURE_DIR" && "$HARNESS" snap "exp-only" >/dev/null )
  local out_main out_exp
  out_main=$( ( cd "$FIXTURE_DIR" && "$HARNESS" log --branch=main ) 2>&1 )
  out_exp=$( ( cd "$FIXTURE_DIR" && "$HARNESS" log --branch=experimental ) 2>&1 )
  local rows_main; rows_main=$(echo "$out_main" | grep -cE '^[0-9a-f]{6,}')
  local rows_exp;  rows_exp=$(echo "$out_exp"  | grep -cE '^[0-9a-f]{6,}')
  assert_count 1 "$rows_main" "log --branch=main shows 1 row (main-only)"
  assert_count 1 "$rows_exp" "log --branch=experimental shows 1 row (exp-only)"
  assert_contains "$out_exp" "(experimental)" "experimental row marked"
  assert_not_contains "$out_main" "(experimental)" "main filter excludes experimental row"
}
register_case "W4.4 log --branch filters by snapshot.branch field" w4_4_log_branch_filter

w4_5_log_with_sessions() {
  fixture_lineage_3_snapshots
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" log --with-sessions ) 2>&1 )
  # Each row should end with [N session(s)].
  local rows_with; rows_with=$(echo "$out" | grep -cE '\[[0-9]+ session')
  assert_count 3 "$rows_with" "all 3 rows annotated with session counts"
}
register_case "W4.5 log --with-sessions annotates each row" w4_5_log_with_sessions

w4_6_diff_non_empty() {
  fixture_lineage_3_snapshots
  local ids; ids=$( ( cd "$FIXTURE_DIR" && "$HARNESS" log ) | awk '{print $1}' )
  local newest; newest=$(echo "$ids" | head -1)
  local oldest; oldest=$(echo "$ids" | tail -1)
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" diff "$oldest" "$newest" ) 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "diff exits 0"
  assert_contains "$out" "$oldest..$newest" "diff header lists both ids"
  # lineage_3 mutates by adding skills extra1 + extra2 → diff should
  # report them.
  assert_contains "$out" "extra" "diff lists added skills"
}
register_case "W4.6 diff between distinct ids returns non-empty op list" w4_6_diff_non_empty

w4_7_diff_same_id() {
  fixture_lineage_3_snapshots
  local id; id=$( ( cd "$FIXTURE_DIR" && "$HARNESS" log ) | head -1 | awk '{print $1}' )
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" diff "$id" "$id" ) 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "diff <id> <id> exits 0"
  assert_contains "$out" "+0 added" "empty diff: 0 added"
  assert_contains "$out" "−0 removed" "empty diff: 0 removed"
  assert_contains "$out" "~0 changed" "empty diff: 0 changed"
}
register_case "W4.7 diff <id> <id> is empty" w4_7_diff_same_id

w4_8_diff_resolves_tag_and_HEAD() {
  fixture_tagged
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" diff v0.1 HEAD ) 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "diff v0.1 HEAD exits 0"
  # Tagged fixture: v0.1 is at the only snapshot which is also HEAD.
  # Diff resolves both refs (the header should show "<id>..<id>").
  assert_matches "$out" '[0-9a-f]+\.\.[0-9a-f]+' "diff header shows both resolved ids"
}
register_case "W4.8 diff v0.1 HEAD resolves both refs" w4_8_diff_resolves_tag_and_HEAD

w4_9_sessions_lists_all() {
  fixture_lineage_3_snapshots
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" sessions ) 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "sessions exits 0"
  assert_contains "$out" "cip-l1" "lists cip-l1"
  assert_contains "$out" "cip-l2" "lists cip-l2"
  assert_contains "$out" "cip-l3" "lists cip-l3"
}
register_case "W4.9 sessions lists every observed session id" w4_9_sessions_lists_all

# W4.10 — prompt expects "empty trajectory; exit 0" but current CLI
# exits 1 with "(no events recorded for session ...)". Lock in the
# observed behavior.
w4_10_sessions_unknown_id() {
  fixture_lineage_3_snapshots
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" sessions zzzznotreal ) 2>&1 )
  local rc=$?
  assert_exit 1 "$rc" "sessions <unknown> exits 1 (current v0.4.x behavior; prompt expected 0)"
  assert_contains "$out" "no events" "message names the missing session"
}
register_case "W4.10 sessions <unknown> exits 1 with 'no events recorded'" w4_10_sessions_unknown_id
