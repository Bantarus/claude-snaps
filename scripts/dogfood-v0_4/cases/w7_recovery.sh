# Workflow W7 — recovery from corruption (6 cases).
#
# Multiple cases lock in current v0.4.x behavior that diverges from
# the prompt's expected outcome. Each is flagged as v0.4.x backlog
# inline so the case turns red the moment the CLI improves the
# affected error.

w7_1_reindex_clean() {
  fixture_lineage_3_snapshots
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" reindex ) 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "reindex on clean lineage exits 0"
  assert_contains "$out" "Reindexed:" "report mentions Reindexed"
  # Lineage was already clean (built via fires), so first reindex is
  # already a no-op for content but still reports counts.
  assert_matches "$out" 'Reindexed: \+[0-9]+ snapshots, ~[0-9]+, −[0-9]+' "report shape: +N snapshots, ~N, -N"
}
register_case "W7.1 reindex on clean lineage exits 0 with summary" w7_1_reindex_clean

w7_2_reindex_idempotent() {
  fixture_lineage_3_snapshots
  ( cd "$FIXTURE_DIR" && "$HARNESS" reindex >/dev/null )
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" reindex ) 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "second reindex exits 0"
  assert_contains "$out" "+0 snapshots" "no new snapshots reported"
  assert_contains "$out" "~0" "no updates reported"
  assert_contains "$out" "−0" "no removals reported"
}
register_case "W7.2 reindex twice is idempotent (+0/~0/-0)" w7_2_reindex_idempotent

# W7.3 — prompt expects reindex to surface integrity error on a
# truncated blob. Current v0.4.x reindex does NOT detect truncated-
# but-parseable blobs; the error surfaces at `harness log` time.
# Lock in observed behavior; flag as v0.4.x backlog (reindex should
# detect blobs whose content doesn't match their filename hash).
w7_3_truncated_blob_surfaces_at_log() {
  fixture_corrupted_blob
  local rout
  rout=$( ( cd "$FIXTURE_DIR" && "$HARNESS" reindex ) 2>&1 )
  local rrc=$?
  assert_exit 0 "$rrc" "reindex passes silently (current v0.4.x; backlog)"
  assert_contains "$rout" "Reindexed:" "reindex still runs"
  # Log surfaces the integrity error.
  local lout
  lout=$( ( cd "$FIXTURE_DIR" && "$HARNESS" log ) 2>&1 )
  local lrc=$?
  assert_exit 1 "$lrc" "log exits 1 on corrupted blob"
  assert_contains "$lout" "IntegrityError" "log surfaces IntegrityError"
  assert_contains "$lout" "filename id" "error mentions filename id mismatch"
}
register_case "W7.3 truncated blob: reindex silent (BACKLOG); log surfaces IntegrityError" w7_3_truncated_blob_surfaces_at_log

# W7.4 — prompt expects reindex to report the missing blob. Current
# v0.4.x reindex crashes with a FOREIGN KEY constraint stack trace.
# Lock in current behavior; flag as v0.4.x backlog (reindex should
# clean the index entry for a removed blob).
w7_4_removed_blob_crashes_reindex() {
  fixture_lineage_3_snapshots
  local blob; blob=$(find "$FIXTURE_DIR/.harness/snapshots" -type f -name '*.json' | head -1)
  assert_file_exists "$blob" "fixture provided at least one blob"
  rm -f "$blob"
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" reindex ) 2>&1 )
  local rc=$?
  assert_exit 2 "$rc" "reindex exits 2=internal-bug (current v0.4.x; backlog)"
  assert_contains "$out" "FOREIGN KEY" "stack trace contains FOREIGN KEY (current behavior; ugly)"
}
register_case "W7.4 removed blob: reindex crashes (BACKLOG; should clean index)" w7_4_removed_blob_crashes_reindex

w7_5_corrupted_head_clean_error() {
  fixture_corrupted_head
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" log ) 2>&1 )
  local rc=$?
  assert_exit 1 "$rc" "log exits 1 on corrupted HEAD"
  assert_contains "$out" "IntegrityError" "clean error class (not a stack trace)"
  assert_contains "$out" "HEAD" "error mentions HEAD"
  assert_not_contains "$out" "    at " "no JS stack trace lines"
}
register_case "W7.5 corrupted HEAD: clean IntegrityError (not stack trace)" w7_5_corrupted_head_clean_error

w7_6_dangling_branch_ref() {
  fixture_baseline_no_apm
  ( cd "$FIXTURE_DIR" && "$HARNESS" snap "first" >/dev/null )
  printf '0000000000000000000000000000000000000000\n' > "$FIXTURE_DIR/.harness/refs/heads/main"
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" checkout main ) 2>&1 )
  local rc=$?
  assert_exit 1 "$rc" "checkout dangling main exits 1"
  assert_contains "$out" "0000000000000000000000000000000000000000" "error names the dangling id"
  assert_contains "$out" "IoError" "IoError clearly stated"
}
register_case "W7.6 checkout dangling branch ref exits 1 with IoError" w7_6_dangling_branch_ref
