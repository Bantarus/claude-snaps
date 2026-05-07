# Workflow W9 — APM enrichment behavior on capture (4 cases).
#
# Verifies the v0.4.1 apm.ts reader contract: local-path entries
# synthesize identity (_local/<name> + git HEAD), directory-shaped
# deployed_files match child files, malformed lockfiles do not break
# capture.

w9_1_local_path_apm_enrichment() {
  fixture_baseline_with_apm
  local blob; blob=$(read_head_blob "$FIXTURE_DIR")
  local mod; mod=$(echo "$blob" | jq '.modules[] | select(.name=="apm-test")')
  if [ -z "$mod" ]; then
    _assert_fail "no apm-test module in head blob"
    return 1
  fi
  assert_json_path "$mod" '.source.kind' "apm" "apm-test enriched as apm-kind"
  local pkg; pkg=$(echo "$mod" | jq -r '.source.package')
  assert_matches "$pkg" '^_local/' "package starts with _local/ (v0.4.1 enrichment)"
  local commit; commit=$(echo "$mod" | jq -r '.source.resolvedCommit')
  assert_matches "$commit" '^[0-9a-f]{40}$' "resolvedCommit is 40-hex (synthesized from git HEAD)"
  assert_json_path "$mod" '.source.depth' "1" "depth=1 for local-path"
  # apmLockHash present on the snapshot.
  assert_matches "$(echo "$blob" | jq -r '.apmLockHash')" '^sha256:[0-9a-f]{64}$' "apmLockHash recorded"
}
register_case "W9.1 local-path APM dep enriched as apm-kind with _local/ prefix" w9_1_local_path_apm_enrichment

w9_2_empty_packages_lockfile() {
  fixture_baseline_no_apm
  cat > "$FIXTURE_DIR/apm.lock.yaml" <<'YAML'
lockfile_version: '1'
generated_at: '2026-05-07T00:00:00.000000+00:00'
apm_version: 0.8.11
dependencies: []
YAML
  fire_session_start "$FIXTURE_DIR" w9-2 startup
  local blob; blob=$(read_head_blob "$FIXTURE_DIR")
  # apmLockHash should be set (the bytes of the lockfile were hashed).
  assert_matches "$(echo "$blob" | jq -r '.apmLockHash')" '^sha256:[0-9a-f]{64}$' "apmLockHash captures the empty-lockfile bytes"
  # No module should be apm-kind.
  local apm_count; apm_count=$(echo "$blob" | jq '[.modules[] | select(.source.kind=="apm")] | length')
  assert_equal "0" "$apm_count" "no apm-kind modules when packages is empty"
}
register_case "W9.2 empty packages lockfile: apmLockHash set, no apm modules" w9_2_empty_packages_lockfile

w9_3_malformed_yaml_lockfile() {
  fixture_baseline_no_apm
  printf 'this is: not - valid yaml [[[\n' > "$FIXTURE_DIR/apm.lock.yaml"
  set +e
  fire_session_start "$FIXTURE_DIR" w9-3 startup
  local rc=$?
  set -e
  assert_exit 0 "$rc" "hook still exits 0 with malformed lockfile"
  local blob; blob=$(read_head_blob "$FIXTURE_DIR")
  # apmLockHash hashes the BYTES, regardless of parse success.
  assert_matches "$(echo "$blob" | jq -r '.apmLockHash')" '^sha256:[0-9a-f]{64}$' "apmLockHash captures the raw bytes"
  # Modules unaffected — no enrichment, no apm-kind entries.
  local apm_count; apm_count=$(echo "$blob" | jq '[.modules[] | select(.source.kind=="apm")] | length')
  assert_equal "0" "$apm_count" "malformed lockfile yields zero apm enrichments"
}
register_case "W9.3 malformed YAML lockfile: hook exits 0; no enrichment" w9_3_malformed_yaml_lockfile

w9_4_directory_deployed_files_matches_child() {
  # baseline_with_apm produces a lockfile with deployed_files listing
  # the directory `.claude/skills/apm-test`. The actual module the
  # capture sees is a SKILL with path `.claude/skills/apm-test/SKILL.md`.
  # v0.4.1's directory-prefix matcher recognizes the child as
  # apm-source. This case asserts that explicit chain.
  fixture_baseline_with_apm
  # Inspect the lockfile to confirm the deployed entry IS the
  # directory (not the file) — this is what triggers the directory-
  # prefix matcher path.
  local lock; lock=$(cat "$FIXTURE_DIR/apm.lock.yaml")
  assert_contains "$lock" ".claude/skills/apm-test" "lockfile lists apm-test path"
  assert_not_contains "$lock" "SKILL.md" "lockfile entry is the directory, not a file"
  # Snapshot module is apm-kind despite the deployed entry being a
  # directory — that is the directory-prefix match working.
  local blob; blob=$(read_head_blob "$FIXTURE_DIR")
  local kind; kind=$(echo "$blob" | jq -r '.modules[] | select(.name=="apm-test") | .source.kind')
  assert_equal "apm" "$kind" "child SKILL.md classified as apm via directory-prefix match"
}
register_case "W9.4 directory-shaped deployed_files matches child file" w9_4_directory_deployed_files_matches_child
