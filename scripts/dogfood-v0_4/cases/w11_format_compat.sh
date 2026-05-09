# Workflow W11 — format compatibility + spec gates (4 cases).
#
# Verifies cross-version reader tolerance and the python spec gates
# that catch drift between schema, examples, and the spec text.

# Repo root for spec scripts (resolved from MONOREPO_ROOT in lib.sh).
_w11_repo_root() {
  printf '%s' "$MONOREPO_ROOT"
}

# W11.1 — drop the root v0.3 blob from compat-fixtures (parentIds=[])
# into .harness/snapshots/, point HEAD detached at it, and verify the
# reader tolerates it via reindex + log.
w11_1_v03_blob_renders() {
  fixture_lineage_3_snapshots
  local src="$MONOREPO_ROOT/spec/examples/compat-fixtures/.harness/snapshots/f5/e6cac2653911ae8338cd58c683b5fbff9abf3c.json"
  if [ ! -f "$src" ]; then
    _assert_fail "compat fixture missing at $src"
    return 1
  fi
  mkdir -p "$FIXTURE_DIR/.harness/snapshots/f5"
  cp "$src" "$FIXTURE_DIR/.harness/snapshots/f5/e6cac2653911ae8338cd58c683b5fbff9abf3c.json"
  local rout
  rout=$( ( cd "$FIXTURE_DIR" && "$HARNESS" reindex ) 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "reindex tolerates v0.3 blob"
  assert_contains "$rout" "+1 snapshots" "reindex picks up the new v0.3 blob"
  # Detach HEAD at the v0.3 blob and log it.
  ( cd "$FIXTURE_DIR" && "$HARNESS" checkout f5e6cac2 >/dev/null 2>&1 )
  local lout
  lout=$( ( cd "$FIXTURE_DIR" && "$HARNESS" log ) 2>&1 )
  local lrc=$?
  assert_exit 0 "$lrc" "log doesn't crash with v0.3 blob at HEAD"
  assert_contains "$lout" "f5e6cac2" "v0.3 blob rendered in log"
}
register_case "W11.1 v0.3 blob: reader tolerates and renders" w11_1_v03_blob_renders

w11_2_v02_blob_refused() {
  fixture_lineage_3_snapshots
  # Construct a synthetic v0.2 blob (formatVersion="0.2") whose id
  # matches its content per spec/format.md §3.2.
  local tpl
  tpl=$(find "$FIXTURE_DIR/.harness/snapshots" -type f -name '*.json' | head -1)
  local v02_id
  v02_id=$( node -e '
    const fs = require("node:fs");
    const crypto = require("node:crypto");
    const tpl = JSON.parse(fs.readFileSync(process.argv[1], "utf-8"));
    tpl.formatVersion = "0.2";
    tpl.createdAt = "2099-02-01T00:00:00.000Z";
    delete tpl.id;
    function canon(v) { if (v===null||typeof v!=="object") return v; if (Array.isArray(v)) return v.map(canon); const s={}; for (const k of Object.keys(v).sort()) s[k]=canon(v[k]); return s; }
    const EX = ["id","createdAt","codePin","model","permissionMode","claudeCodeVersion"];
    const stripped = { ...tpl };
    for (const k of EX) delete stripped[k];
    const bytes = Buffer.from(JSON.stringify(canon(stripped)), "utf-8");
    const id = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 40);
    const dir = process.argv[2] + "/snapshots/" + id.slice(0,2);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dir + "/" + id.slice(2) + ".json", JSON.stringify({...tpl, id}, null, 2));
    process.stdout.write(id);
  ' "$tpl" "$FIXTURE_DIR/.harness" )

  # Current v0.4.x behavior: reindex + log silently accept the v0.2
  # blob (formatVersion field is recorded but no major-version refusal
  # check happens). Lock in current behavior; flag as v0.4.x backlog
  # (reader should refuse pre-v0.3 blobs with a clear error).
  local rout
  rout=$( ( cd "$FIXTURE_DIR" && "$HARNESS" reindex ) 2>&1 )
  local rrc=$?
  assert_exit 0 "$rrc" "reindex accepts v0.2 blob (BACKLOG; should refuse)"
  assert_contains "$rout" "+1 snapshots" "v0.2 blob added to index"
  local lout
  lout=$( ( cd "$FIXTURE_DIR" && "$HARNESS" log ) 2>&1 )
  local lrc=$?
  assert_exit 0 "$lrc" "log lists the v0.2 blob (BACKLOG; should refuse)"
  # Verify the v0.2 blob's formatVersion is preserved verbatim on disk
  # — proves the reader read it without normalizing.
  local v02_path
  v02_path=$(find "$FIXTURE_DIR/.harness/snapshots" -name "$(echo "$v02_id" | cut -c3-)*.json" -path "*/$( echo "$v02_id" | cut -c1-2)/*" | head -1)
  assert_file_exists "$v02_path" "v0.2 blob written to disk"
  assert_file_contains "$v02_path" '"formatVersion": "0.2"' "blob's formatVersion preserved"
}
register_case "W11.2 v0.2 blob silently accepted (BACKLOG; should refuse)" w11_2_v02_blob_refused

w11_3_spec_gate_scripts() {
  local root; root=$(_w11_repo_root)
  local out1
  out1=$( cd "$root" && python3 scripts/check_schema_agreement.py 2>&1 )
  local rc1=$?
  assert_exit 0 "$rc1" "check_schema_agreement.py exits 0"
  local out2
  out2=$( cd "$root" && python3 scripts/check_format_version_bump.py 2>&1 )
  local rc2=$?
  assert_exit 0 "$rc2" "check_format_version_bump.py exits 0"
}
register_case "W11.3 spec-gate scripts exit 0 (no schema/version drift)" w11_3_spec_gate_scripts

# W11.4 — the canonical-501.bin test vector must be byte-stable. Run
# build_examples.py and verify the test vector is unchanged. Because
# build_examples.py also rewrites .harness/ examples in the spec, the
# only safe-for-CI verification is "no diff vs git" on the spec/
# subtree. CI runs from a clean checkout so any drift surfaces.
w11_4_canonical_test_vector_byte_stable() {
  local root; root=$(_w11_repo_root)
  # Snapshot pre-state of spec/ via git.
  local before_status
  before_status=$( cd "$root" && git status --porcelain spec/ 2>&1 )
  cd "$root" && python3 scripts/build_examples.py >/dev/null 2>&1
  local rc=$?
  assert_exit 0 "$rc" "build_examples.py exits 0"
  local after_status
  after_status=$( cd "$root" && git status --porcelain spec/ 2>&1 )
  if [ "$before_status" != "$after_status" ]; then
    _assert_fail "build_examples.py modified spec/ — round-trip drift" \
      "before: $before_status" "after: $after_status"
  fi
  # Specifically check the canonical-501.bin test vector.
  assert_file_exists "$root/spec/test-vectors/canonical-501.bin" "canonical-501.bin present"
  local diff_out
  diff_out=$( cd "$root" && git diff --stat spec/test-vectors/canonical-501.bin 2>&1 )
  if [ -n "$diff_out" ]; then
    _assert_fail "canonical-501.bin changed after build_examples.py" "$diff_out"
  fi
}
register_case "W11.4 build_examples.py is byte-stable (canonical-501.bin)" w11_4_canonical_test_vector_byte_stable
