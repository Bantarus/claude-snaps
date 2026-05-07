# Workflow W6 — `harness reproduce` (load-bearing) (12 cases).
#
# Verifies the v0.4.1 reproduction contract from spec/format.md §6.1:
# subtractive within scope, APM-driven for content, local-source
# reported but not materialized, dry-run is byte-identical, abort-
# before-backup on missing apm.

w6_1_no_apm_local_source_not_restored() {
  fixture_baseline_no_apm
  ( cd "$FIXTURE_DIR" && "$HARNESS" snap "baseline" >/dev/null )
  # Mutate a local-source skill file.
  echo "MUTATED" >> "$FIXTURE_DIR/.claude/skills/notes/SKILL.md"
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" reproduce HEAD ) 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "reproduce exits 0"
  assert_contains "$out" "APM phase skipped" "apm phase skipped (no lockfile)"
  assert_contains "$out" "Local-source modules NOT reproduced" "local-source reported"
  # File NOT restored — the mutation persists.
  assert_file_contains "$FIXTURE_DIR/.claude/skills/notes/SKILL.md" "MUTATED" "local-source mutation NOT restored"
  # HEAD advances (detached, since reproduce checks out by id).
  local head; head=$(read_head_pointer "$FIXTURE_DIR")
  assert_matches "$head" '^[0-9a-f]{40}$' "HEAD detached at the snapshot id"
  # No paths removed (this is forward identity, not subtractive).
  assert_not_contains "$out" "Removed " "no paths removed message"
}
register_case "W6.1 reproduce on no-APM snapshot: local-source NOT restored, no removals" w6_1_no_apm_local_source_not_restored

w6_2_with_apm_idempotent() {
  fixture_baseline_with_apm
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" reproduce HEAD ) 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "reproduce exits 0"
  assert_contains "$out" "verified 1 of 1 APM module" "1 APM module verified"
  assert_contains "$out" "Backed up" "backup created"
  # Backup directory present.
  local backups; backups=$(find "$FIXTURE_DIR" -maxdepth 1 -type d -name '.claude.harness-backup-*' | wc -l | tr -d ' ')
  assert_count 1 "$backups" "exactly 1 backup directory"
}
register_case "W6.2 reproduce on baseline_with_apm: verified 1/1; 1 backup" w6_2_with_apm_idempotent

w6_3_corrupt_apm_file_restored() {
  fixture_baseline_with_apm
  local skill="$FIXTURE_DIR/.claude/skills/apm-test/SKILL.md"
  local hash_before; hash_before=$(sha256sum "$skill" | awk '{print $1}')
  echo "CORRUPTED" >> "$skill"
  local hash_corrupt; hash_corrupt=$(sha256sum "$skill" | awk '{print $1}')
  assert_not_equal "$hash_before" "$hash_corrupt" "file is genuinely mutated"
  ( cd "$FIXTURE_DIR" && "$HARNESS" reproduce HEAD >/dev/null 2>&1 )
  local rc=$?
  local hash_after; hash_after=$(sha256sum "$skill" | awk '{print $1}')
  assert_exit 0 "$rc" "reproduce exits 0"
  assert_equal "$hash_before" "$hash_after" "apm-managed file restored to upstream content"
}
register_case "W6.3 corrupt apm file: reproduce restores upstream content" w6_3_corrupt_apm_file_restored

w6_4_hand_edit_capture_then_reproduce_mismatch() {
  fixture_baseline_with_apm
  # Hand-edit the apm-managed file.
  echo "USER_EDIT" >> "$FIXTURE_DIR/.claude/skills/apm-test/SKILL.md"
  # Capture the hand-edited state — this records the edit's hash.
  fire_user_prompt "$FIXTURE_DIR" w6-4
  local edited_head; edited_head=$(head_snapshot_id "$FIXTURE_DIR")
  # Now reproduce: apm install will overwrite to upstream; post-install
  # hash won't match the recorded (hand-edited) hash → mismatch failure.
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" reproduce "$edited_head" ) 2>&1 )
  local rc=$?
  assert_exit 1 "$rc" "reproduce exits 1 on configHash mismatch"
  assert_contains "$out" "APM phase failed" "apm phase failed reported"
  # HEAD NOT advanced — still on its prior pointer (likely main symbolic).
  local head; head=$(read_head_pointer "$FIXTURE_DIR")
  assert_contains "$head" "ref: refs/heads/main" "HEAD remains on main (not advanced)"
  # Backup retained (failure path keeps it for forensics).
  local backups; backups=$(find "$FIXTURE_DIR" -maxdepth 1 -type d -name '.claude.harness-backup-*' | wc -l | tr -d ' ')
  if [ "$backups" -lt 1 ]; then
    _assert_fail "expected at least 1 backup retained, got $backups"
  fi
}
register_case "W6.4 hand-edit + capture + reproduce: mismatch, HEAD not advanced" w6_4_hand_edit_capture_then_reproduce_mismatch

w6_5_subtractive_ancestor_removes_apm_paths() {
  # Build a lineage where APM was added partway: init (no APM) → APM
  # added (new snap). Then reproduce the init id → APM paths removed.
  fixture_baseline_no_apm
  ( cd "$FIXTURE_DIR" && "$HARNESS" snap "init" >/dev/null )
  local init_id; init_id=$(head_snapshot_id "$FIXTURE_DIR")

  _ensure_apm_fixture
  cat > "$FIXTURE_DIR/apm.yml" <<APMYML
name: cip-test-project
version: 1.0.0
dependencies:
  apm:
    - $CIP_APM_FIXTURE
APMYML
  ( cd "$FIXTURE_DIR" && "$APM" install >/dev/null 2>&1 )
  fire_session_start "$FIXTURE_DIR" w6-5 startup
  local apm_id; apm_id=$(head_snapshot_id "$FIXTURE_DIR")

  # Pre-conditions: apm path present, lockfile present.
  assert_file_exists "$FIXTURE_DIR/.claude/skills/apm-test/SKILL.md" "apm path present pre-reproduce"
  assert_file_exists "$FIXTURE_DIR/apm.lock.yaml" "apm.lock.yaml present pre-reproduce"

  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" reproduce "$init_id" ) 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "reproduce exits 0"
  assert_contains "$out" "APM phase skipped" "init had no apmLockfile"
  assert_contains "$out" "Removed " "report mentions removal"
  # Apm path removed.
  assert_file_not_exists "$FIXTURE_DIR/.claude/skills/apm-test/SKILL.md" "apm path removed by subtractive cleanup"
  # apm.lock.yaml removed (init had null apmLockfile).
  assert_file_not_exists "$FIXTURE_DIR/apm.lock.yaml" "apm.lock.yaml removed"
  # Backup of lockfile retained for safety.
  assert_file_exists "$FIXTURE_DIR/apm.lock.yaml.harness-backup" "apm.lock.yaml backup retained"
}
register_case "W6.5 subtractive cleanup on ancestor: pathsRemoved + lockfile gone" w6_5_subtractive_ancestor_removes_apm_paths

w6_6_forward_after_subtractive_restores_apm() {
  # Same lineage as W6.5, but reproduce the apm-id (forward) after a
  # mock subtractive state. apm.lock.yaml restored; apm files
  # materialized; pathsRemoved=[].
  fixture_baseline_no_apm
  ( cd "$FIXTURE_DIR" && "$HARNESS" snap "init" >/dev/null )
  local init_id; init_id=$(head_snapshot_id "$FIXTURE_DIR")

  _ensure_apm_fixture
  cat > "$FIXTURE_DIR/apm.yml" <<APMYML
name: cip-test-project
version: 1.0.0
dependencies:
  apm:
    - $CIP_APM_FIXTURE
APMYML
  ( cd "$FIXTURE_DIR" && "$APM" install >/dev/null 2>&1 )
  fire_session_start "$FIXTURE_DIR" w6-6a startup
  local apm_id; apm_id=$(head_snapshot_id "$FIXTURE_DIR")

  # Subtract first.
  ( cd "$FIXTURE_DIR" && "$HARNESS" reproduce "$init_id" >/dev/null 2>&1 )
  assert_file_not_exists "$FIXTURE_DIR/.claude/skills/apm-test/SKILL.md" "apm path gone after subtract"
  # Now go forward.
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" reproduce "$apm_id" ) 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "forward reproduce exits 0"
  assert_contains "$out" "verified 1 of 1 APM module" "apm verified"
  assert_file_exists "$FIXTURE_DIR/.claude/skills/apm-test/SKILL.md" "apm file materialized"
  assert_file_exists "$FIXTURE_DIR/apm.lock.yaml" "apm.lock.yaml restored"
}
register_case "W6.6 forward reproduce after subtractive restores APM state" w6_6_forward_after_subtractive_restores_apm

w6_7_dry_run_byte_identical() {
  fixture_baseline_with_apm
  # Capture .claude/ tree hash pre-dry-run.
  local hash_before
  hash_before=$( find "$FIXTURE_DIR/.claude" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}' )
  local head_before; head_before=$(read_head_pointer "$FIXTURE_DIR")
  local backups_before; backups_before=$(find "$FIXTURE_DIR" -maxdepth 1 -type d -name '.claude.harness-backup-*' | wc -l | tr -d ' ')

  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" reproduce HEAD --dry-run ) 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "dry-run exits 0"
  assert_contains "$out" "Would" "output uses 'Would ...' prefix"
  assert_contains "$out" "(No changes made.)" "dry-run footer present"

  local hash_after
  hash_after=$( find "$FIXTURE_DIR/.claude" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}' )
  assert_equal "$hash_before" "$hash_after" ".claude/ byte-identical pre/post dry-run"
  local head_after; head_after=$(read_head_pointer "$FIXTURE_DIR")
  assert_equal "$head_before" "$head_after" "HEAD unchanged"
  local backups_after; backups_after=$(find "$FIXTURE_DIR" -maxdepth 1 -type d -name '.claude.harness-backup-*' | wc -l | tr -d ' ')
  assert_equal "$backups_before" "$backups_after" "no new backup directory created"
}
register_case "W6.7 reproduce --dry-run is byte-identical; no backup" w6_7_dry_run_byte_identical

w6_8_reproduce_on_detached_head() {
  fixture_baseline_with_apm
  local sid; sid=$(head_snapshot_id "$FIXTURE_DIR")
  ( cd "$FIXTURE_DIR" && "$HARNESS" checkout "$sid" >/dev/null )
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" reproduce HEAD ) 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "reproduce works on detached HEAD"
  local head; head=$(read_head_pointer "$FIXTURE_DIR")
  assert_matches "$head" '^[0-9a-f]{40}$' "HEAD remains detached"
}
register_case "W6.8 reproduce works on detached HEAD" w6_8_reproduce_on_detached_head

w6_9_reproduce_by_tag() {
  fixture_baseline_with_apm
  ( cd "$FIXTURE_DIR" && "$HARNESS" tag v0.4-apm >/dev/null )
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" reproduce v0.4-apm ) 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "reproduce by tag exits 0"
  assert_contains "$out" "verified 1 of 1 APM module" "tag-based reproduce same outcome"
}
register_case "W6.9 reproduce <tag> resolves and runs" w6_9_reproduce_by_tag

# W6.10 — apm not on PATH.
# Build a minimal PATH that has node + harness shim but NOT apm.
# W6.10 — apm not on PATH. Use a minimal PATH that has node and
# system bins but excludes any directory containing apm. Invoke the
# harness binary by absolute path so PATH-discovery of harness isn't
# needed. APM lives next to harness in $HOME/.local/bin on this host;
# omitting that directory from PATH is what makes apm unfindable.
w6_10_apm_not_on_path() {
  fixture_baseline_with_apm
  local node_dir; node_dir=$(dirname "$(command -v node)")
  local minimal_path="$node_dir:/usr/bin:/bin"
  if env -i PATH="$minimal_path" command -v apm >/dev/null 2>&1; then
    _assert_fail "apm is reachable on the minimal PATH; cannot exercise the apm-missing branch on this host"
    return 1
  fi
  local backups_before; backups_before=$(find "$FIXTURE_DIR" -maxdepth 1 -type d -name '.claude.harness-backup-*' | wc -l | tr -d ' ')
  local out
  out=$( env -i HOME="$HOME" PATH="$minimal_path" sh -c "cd '$FIXTURE_DIR' && '$HARNESS' reproduce HEAD" 2>&1 )
  local rc=$?
  assert_exit 1 "$rc" "reproduce exits 1 with no apm on PATH"
  assert_contains "$out" "apm not found" "error names missing apm"
  local backups_after; backups_after=$(find "$FIXTURE_DIR" -maxdepth 1 -type d -name '.claude.harness-backup-*' | wc -l | tr -d ' ')
  assert_equal "$backups_before" "$backups_after" "abort BEFORE backup (no new directory)"
}
register_case "W6.10 reproduce aborts before backup when apm missing" w6_10_apm_not_on_path

w6_11_reproduce_unknown_ref() {
  fixture_baseline_with_apm
  local backups_before; backups_before=$(find "$FIXTURE_DIR" -maxdepth 1 -type d -name '.claude.harness-backup-*' | wc -l | tr -d ' ')
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" reproduce nonexistent ) 2>&1 )
  local rc=$?
  assert_exit 1 "$rc" "reproduce <unknown> exits 1"
  assert_contains "$out" "unknown ref" "error names unknown ref"
  local backups_after; backups_after=$(find "$FIXTURE_DIR" -maxdepth 1 -type d -name '.claude.harness-backup-*' | wc -l | tr -d ' ')
  assert_equal "$backups_before" "$backups_after" "no backup created on ref-resolve failure"
}
register_case "W6.11 reproduce <unknown> exits 1; no backup" w6_11_reproduce_unknown_ref

w6_12_local_skill_untouched_during_apm_restore() {
  fixture_baseline_with_apm
  # Add a brand-new local skill the snapshot doesn't know about.
  mkdir -p "$FIXTURE_DIR/.claude/skills/handwritten"
  cat > "$FIXTURE_DIR/.claude/skills/handwritten/SKILL.md" <<'SKILL'
---
name: handwritten
description: locally added after the snapshot
---
# handwritten
local content the user just wrote
SKILL
  local hand_hash; hand_hash=$(sha256sum "$FIXTURE_DIR/.claude/skills/handwritten/SKILL.md" | awk '{print $1}')
  # Mutate the apm file so reproduce has work to do.
  echo "CORRUPTED" >> "$FIXTURE_DIR/.claude/skills/apm-test/SKILL.md"
  ( cd "$FIXTURE_DIR" && "$HARNESS" reproduce HEAD >/dev/null 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "reproduce exits 0"
  # APM file restored.
  assert_not_contains "$(cat "$FIXTURE_DIR/.claude/skills/apm-test/SKILL.md")" "CORRUPTED" "apm file restored"
  # Handwritten skill untouched.
  assert_file_exists "$FIXTURE_DIR/.claude/skills/handwritten/SKILL.md" "handwritten skill survives"
  local hand_after; hand_after=$(sha256sum "$FIXTURE_DIR/.claude/skills/handwritten/SKILL.md" | awk '{print $1}')
  assert_equal "$hand_hash" "$hand_after" "handwritten skill bytes unchanged"
}
register_case "W6.12 reproduce restores APM but leaves hand-written skill alone" w6_12_local_skill_untouched_during_apm_restore
