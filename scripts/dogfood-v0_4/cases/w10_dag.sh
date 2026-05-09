# Workflow W10 — DAG / cross-session (3 cases).
#
# Verifies multiple-session attribution onto one snapshot, branch
# divergence rendering, and merge-node tolerance (synthetic blob since
# v0.4 writers don't produce merges).

w10_1_three_sessions_one_composition() {
  fixture_baseline_no_apm
  fire_session_start "$FIXTURE_DIR" w10-a startup
  fire_session_start "$FIXTURE_DIR" w10-b startup
  fire_session_start "$FIXTURE_DIR" w10-c startup
  assert_count 1 "$(count_snapshot_blobs "$FIXTURE_DIR")" "1 snapshot blob"
  local sessions_out
  sessions_out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" sessions ) 2>&1 )
  assert_contains "$sessions_out" "w10-a" "session w10-a listed"
  assert_contains "$sessions_out" "w10-b" "session w10-b listed"
  assert_contains "$sessions_out" "w10-c" "session w10-c listed"
  # log --with-sessions should annotate the row with [3 sessions].
  local log_out
  log_out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" log --with-sessions ) 2>&1 )
  assert_contains "$log_out" "[3 session" "log row annotated with 3-session count"
}
register_case "W10.1 three sessions on same composition share one snapshot" w10_1_three_sessions_one_composition

w10_2_branch_divergence_render() {
  fixture_branched
  ( cd "$FIXTURE_DIR" && "$HARNESS" checkout experimental >/dev/null )
  mkdir -p "$FIXTURE_DIR/.claude/skills/exp"
  cat > "$FIXTURE_DIR/.claude/skills/exp/SKILL.md" <<'SKILL'
---
name: exp
description: e
---
# e
SKILL
  ( cd "$FIXTURE_DIR" && "$HARNESS" snap "exp tip" >/dev/null )
  local exp_id; exp_id=$(head_snapshot_id "$FIXTURE_DIR")
  ( cd "$FIXTURE_DIR" && "$HARNESS" checkout main >/dev/null 2>&1 )
  # Mutate main only by adding a different skill (so branches diverge).
  mkdir -p "$FIXTURE_DIR/.claude/skills/main_only"
  cat > "$FIXTURE_DIR/.claude/skills/main_only/SKILL.md" <<'SKILL'
---
name: main_only
description: m
---
# m
SKILL
  # Restore main's original .claude/ shape before snapping (remove exp).
  rm -rf "$FIXTURE_DIR/.claude/skills/exp"
  ( cd "$FIXTURE_DIR" && "$HARNESS" snap "main tip" >/dev/null )
  local main_id; main_id=$(head_snapshot_id "$FIXTURE_DIR")
  assert_not_equal "$exp_id" "$main_id" "main and experimental tips are distinct"
  # Each branch's log shows only its own snapshot.
  local main_log; main_log=$( ( cd "$FIXTURE_DIR" && "$HARNESS" log --branch=main ) 2>&1 )
  local exp_log;  exp_log=$(  ( cd "$FIXTURE_DIR" && "$HARNESS" log --branch=experimental ) 2>&1 )
  assert_contains "$main_log" "$(echo "$main_id" | head -c 8)" "main log shows main tip"
  assert_not_contains "$main_log" "$(echo "$exp_id" | head -c 8)" "main log excludes experimental"
  assert_contains "$exp_log" "$(echo "$exp_id" | head -c 8)" "experimental log shows experimental tip"
  assert_not_contains "$exp_log" "$(echo "$main_id" | head -c 8)" "experimental log excludes main"
}
register_case "W10.2 divergent branches: log filters by snapshot.branch" w10_2_branch_divergence_render

# W10.3 — synthetic merge node. v0.4 writers don't produce merges, so
# we author a blob with parentIds.length=2 directly. The harness CLI
# must tolerate it on log + diff per spec/format.md §4.1.
#
# Construction: take an existing snapshot's content, swap parentIds
# to [parent_a, parent_b], change createdAt to ensure uniqueness,
# compute the canonical snapshot id (sha256 of canonical bytes,
# minus EXCLUDED_FIELDS), and write the blob to its derived path.
w10_3_synthetic_merge_node() {
  fixture_lineage_3_snapshots
  # Capture two parent ids from the lineage.
  local ids
  ids=$( find "$FIXTURE_DIR/.harness/snapshots" -type f -name '*.json' \
        | sort \
        | sed -E 's|.*/([0-9a-f]{2})/([0-9a-f]+)\.json|\1\2|' )
  local parent_a; parent_a=$(echo "$ids" | sed -n 1p)
  local parent_b; parent_b=$(echo "$ids" | sed -n 2p)
  if [ -z "$parent_a" ] || [ -z "$parent_b" ]; then
    _assert_fail "lineage_3 produced fewer than 2 blobs; cannot construct merge"
    return 1
  fi
  # Use parent_a's content as the template.
  local template_path="$FIXTURE_DIR/.harness/snapshots/${parent_a:0:2}/${parent_a:2}.json"
  # Build the merge blob via node with canonicalization inlined.
  local NEW_PATH
  NEW_PATH=$( node -e '
    const fs = require("node:fs");
    const crypto = require("node:crypto");
    const [tplPath, parentA, parentB, dotHarness] = process.argv.slice(1);
    const tpl = JSON.parse(fs.readFileSync(tplPath, "utf-8"));
    // Synthetic merge: two parents, distinct timestamp.
    tpl.parentIds = [parentA, parentB];
    tpl.createdAt = "2099-01-01T00:00:00.000Z";
    delete tpl.id;
    function canonicalize(v) {
      if (v === null || typeof v !== "object") return v;
      if (Array.isArray(v)) return v.map(canonicalize);
      const sorted = {};
      for (const k of Object.keys(v).sort()) sorted[k] = canonicalize(v[k]);
      return sorted;
    }
    const EXCLUDED = ["id","createdAt","codePin","model","permissionMode","claudeCodeVersion"];
    const stripped = { ...tpl };
    for (const k of EXCLUDED) delete stripped[k];
    const bytes = Buffer.from(JSON.stringify(canonicalize(stripped)), "utf-8");
    const id = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 40);
    const dir = `${dotHarness}/snapshots/${id.slice(0,2)}`;
    fs.mkdirSync(dir, { recursive: true });
    const path = `${dir}/${id.slice(2)}.json`;
    // Writer puts the id on the blob alongside the EXCLUDED fields;
    // reader verifies blob.id matches the filename id. Add it back.
    const onDisk = { ...tpl, id };
    fs.writeFileSync(path, JSON.stringify(onDisk, null, 2));
    process.stdout.write(path);
  ' "$template_path" "$parent_a" "$parent_b" "$FIXTURE_DIR/.harness" )

  assert_file_exists "$NEW_PATH" "synthetic merge blob written"

  # Reindex picks up the new blob.
  local rout
  rout=$( ( cd "$FIXTURE_DIR" && "$HARNESS" reindex ) 2>&1 )
  local rrc=$?
  assert_exit 0 "$rrc" "reindex tolerates merge node"
  # The merge-node id should now appear in log output.
  local merge_id; merge_id=$(basename "$(dirname "$NEW_PATH")")$(basename "$NEW_PATH" .json)
  local merge_short=${merge_id:0:8}
  local lout
  lout=$( ( cd "$FIXTURE_DIR" && "$HARNESS" log ) 2>&1 )
  local lrc=$?
  assert_exit 0 "$lrc" "log doesn't crash with merge node"
  assert_contains "$lout" "$merge_short" "log lists the merge node"
  # diff between merge node and one of its parents should also work.
  local dout
  dout=$( ( cd "$FIXTURE_DIR" && "$HARNESS" diff "$parent_a" "$merge_id" ) 2>&1 )
  local drc=$?
  assert_exit 0 "$drc" "diff against merge node doesn't crash"
}
register_case "W10.3 synthetic merge-node tolerated by log + diff" w10_3_synthetic_merge_node
