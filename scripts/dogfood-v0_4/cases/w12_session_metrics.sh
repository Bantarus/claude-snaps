# Workflow W12 — session metrics + transcript ingestion (v0.5.0).
#
# Verifies the `harness ingest-session` + `harness session-cost`
# CLI surface against synthesized JSONL fixtures. Mirrors the unit
# coverage in packages/core/test/ingest.test.ts and
# packages/core/test/privacy_fuzz.test.ts; this layer regresses the
# end-to-end CLI binary path, the SQLite schema migration, and the
# normative redaction whitelist (W12.5) against shell-level grep.

# ── helpers ────────────────────────────────────────────────────────────

_w12_lineage_db() {
  printf '%s' "$FIXTURE_DIR/.harness/lineage.sqlite"
}

# python3 SQLite query helper. Used in lieu of sqlite3 CLI (which is
# not a documented dep) — python3 is already required for the schema-
# agreement gates (W11.3) and is universally available. SQL is passed
# via argv to avoid shell-quoting collisions with embedded ' or ".
_w12_query() {
  local sql=$1
  python3 -c '
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
for row in conn.execute(sys.argv[2]):
    print("|".join("" if c is None else str(c) for c in row))
' "$(_w12_lineage_db)" "$sql"
}

_w12_query_scalar() {
  _w12_query "$1" | head -1
}

# Write a 5-turn fixture: 2 user, 3 assistant. Models, usage, and tools
# all populated. Stamped with version=2.1.131 on every line.
_w12_write_5turn_fixture() {
  local sid=$1
  local path=$2
  cat > "$path" <<JSONL
{"type":"user","sessionId":"$sid","version":"2.1.131","isSidechain":false,"message":{"role":"user","content":[]}}
{"type":"assistant","sessionId":"$sid","version":"2.1.131","isSidechain":false,"requestId":"req_a","message":{"model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":50,"cache_creation_input_tokens":100,"cache_read_input_tokens":1000},"content":[{"type":"tool_use","name":"Bash","input":{}}]}}
{"type":"user","sessionId":"$sid","version":"2.1.131","isSidechain":false,"message":{"role":"user","content":[]}}
{"type":"assistant","sessionId":"$sid","version":"2.1.131","isSidechain":false,"requestId":"req_b","message":{"model":"claude-opus-4-7","usage":{"input_tokens":5,"output_tokens":25,"cache_creation_input_tokens":0,"cache_read_input_tokens":500},"content":[{"type":"tool_use","name":"Read","input":{}},{"type":"tool_use","name":"Edit","input":{}}]}}
{"type":"assistant","sessionId":"$sid","version":"2.1.131","isSidechain":false,"requestId":"req_c","message":{"model":"claude-opus-4-7","usage":{"input_tokens":1,"output_tokens":3},"content":[]}}
JSONL
}

# Count rows in turn_metrics for a session via python3 SQLite stdlib.
_w12_turn_count() {
  local sid=$1
  _w12_query_scalar "SELECT COUNT(*) FROM turn_metrics WHERE session_id='$sid'"
}

# Run ingest-session against the FIXTURE_DIR. Suppresses output for
# pure write-side cases; later cases call $HARNESS directly to capture
# stdout for assertions.
_w12_ingest() {
  local sid=$1 path=$2
  ( cd "$FIXTURE_DIR" && "$HARNESS" ingest-session "$sid" --transcript-path "$path" ) >/dev/null 2>&1
}

# ── W12.1 — 5-turn fixture: exactly 5 rows, correct shape ─────────────

w12_1_basic_ingest_5_turn() {
  fixture_baseline_no_apm
  local sid='aa11aaaa-0000-4000-8000-000000000001'
  local path="$FIXTURE_DIR/transcript.jsonl"
  _w12_write_5turn_fixture "$sid" "$path"

  local out
  out=$( cd "$FIXTURE_DIR" && "$HARNESS" ingest-session "$sid" --transcript-path "$path" 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "ingest-session exits 0"
  assert_contains "$out" "Ingested 5 new turns" "5 turns reported"
  assert_count 5 "$(_w12_turn_count "$sid")" "exactly 5 rows in turn_metrics"

  # Per-row spot-checks via python3 + sqlite3 stdlib.
  local user_rows; user_rows=$(_w12_query_scalar \
    "SELECT COUNT(*) FROM turn_metrics WHERE session_id='$sid' AND turn_type='user'")
  assert_equal "2" "$user_rows" "2 user rows"
  local asst_rows; asst_rows=$(_w12_query_scalar \
    "SELECT COUNT(*) FROM turn_metrics WHERE session_id='$sid' AND turn_type='assistant'")
  assert_equal "3" "$asst_rows" "3 assistant rows"
  local total_input; total_input=$(_w12_query_scalar \
    "SELECT SUM(input_tokens) FROM turn_metrics WHERE session_id='$sid'")
  assert_equal "16" "$total_input" "input_tokens sum = 10+5+1 = 16"
  local total_output; total_output=$(_w12_query_scalar \
    "SELECT SUM(output_tokens) FROM turn_metrics WHERE session_id='$sid'")
  assert_equal "78" "$total_output" "output_tokens sum = 50+25+3 = 78"
  local total_cache_read; total_cache_read=$(_w12_query_scalar \
    "SELECT SUM(cache_read_input_tokens) FROM turn_metrics WHERE session_id='$sid'")
  assert_equal "1500" "$total_cache_read" "cache_read sum = 1000+500"
}
register_case "W12.1 ingest 5-turn fixture: rows + shape" w12_1_basic_ingest_5_turn

# ── W12.2 — idempotent re-ingest yields zero new rows ─────────────────

w12_2_idempotent_reingest() {
  fixture_baseline_no_apm
  local sid='aa22aaaa-0000-4000-8000-000000000002'
  local path="$FIXTURE_DIR/transcript.jsonl"
  _w12_write_5turn_fixture "$sid" "$path"
  _w12_ingest "$sid" "$path"

  local out
  out=$( cd "$FIXTURE_DIR" && "$HARNESS" ingest-session "$sid" --transcript-path "$path" 2>&1 )
  assert_contains "$out" "0 new turns" "second pass adds 0 rows"
  assert_contains "$out" "5 turns already stored" "5 already-stored reported"
  assert_count 5 "$(_w12_turn_count "$sid")" "still exactly 5 rows"
}
register_case "W12.2 idempotent: re-ingest unchanged file adds zero rows" w12_2_idempotent_reingest

# ── W12.3 — append 2 turns; re-ingest adds exactly 2 ──────────────────

w12_3_append_two_turns() {
  fixture_baseline_no_apm
  local sid='aa33aaaa-0000-4000-8000-000000000003'
  local path="$FIXTURE_DIR/transcript.jsonl"
  _w12_write_5turn_fixture "$sid" "$path"
  _w12_ingest "$sid" "$path"
  assert_count 5 "$(_w12_turn_count "$sid")" "5 rows after first ingest"

  cat >> "$path" <<JSONL
{"type":"user","sessionId":"$sid","version":"2.1.131","isSidechain":false,"message":{"role":"user","content":[]}}
{"type":"assistant","sessionId":"$sid","version":"2.1.131","isSidechain":false,"message":{"model":"claude-opus-4-7","usage":{"input_tokens":2,"output_tokens":4},"content":[]}}
JSONL

  local out
  out=$( cd "$FIXTURE_DIR" && "$HARNESS" ingest-session "$sid" --transcript-path "$path" 2>&1 )
  assert_contains "$out" "Ingested 2 new turns" "2 new turns reported"
  assert_count 7 "$(_w12_turn_count "$sid")" "7 rows total after append"
}
register_case "W12.3 append 2 turns; re-ingest adds exactly 2" w12_3_append_two_turns

# ── W12.4 — mcp__server__tool names preserved verbatim ────────────────

w12_4_mcp_tool_names_preserved() {
  fixture_baseline_no_apm
  local sid='aa44aaaa-0000-4000-8000-000000000004'
  local path="$FIXTURE_DIR/transcript.jsonl"
  cat > "$path" <<JSONL
{"type":"assistant","sessionId":"$sid","isSidechain":false,"message":{"model":"claude-opus-4-7","usage":{"input_tokens":1,"output_tokens":1},"content":[{"type":"tool_use","name":"mcp__github__create_issue","input":{}},{"type":"tool_use","name":"mcp__claude_ai_Gmail__authenticate","input":{}}]}}
JSONL
  _w12_ingest "$sid" "$path"

  local csv
  csv=$(_w12_query_scalar \
    "SELECT tool_names_csv FROM turn_metrics WHERE session_id='$sid'")
  assert_equal "mcp__github__create_issue,mcp__claude_ai_Gmail__authenticate" "$csv" \
    "mcp__-prefixed tool names preserved verbatim, comma-joined"
}
register_case "W12.4 mcp__server__tool names kept verbatim end-to-end" w12_4_mcp_tool_names_preserved

# ── W12.5 — privacy whitelist (load-bearing) ──────────────────────────

w12_5_privacy_canary_grep() {
  fixture_baseline_no_apm
  local sid='aa55aaaa-0000-4000-8000-000000000005'
  local path="$FIXTURE_DIR/transcript.jsonl"
  # Fuzzed fixture with canaries in every spec/format.md §10.2 forbidden
  # field. The canary tokens are unique per field so a positive match
  # tells us which one leaked.
  cat > "$path" <<JSONL
{"type":"system","system_prompt":"SECRET_CANARY_SYS_8a","append_system_prompt":"SECRET_CANARY_APPSYS_8b"}
{"type":"user","sessionId":"$sid","isSidechain":false,"message":{"role":"user","content":[{"type":"text","text":"SECRET_CANARY_PROMPT_8c"}]}}
{"type":"assistant","sessionId":"$sid","isSidechain":false,"requestId":"req_canary","attributionSkill":"recall","message":{"model":"claude-opus-4-7","usage":{"input_tokens":1,"output_tokens":1},"content":[{"type":"thinking","thinking":"SECRET_CANARY_THINK_8d","signature":"SECRET_CANARY_SIG_8e"},{"type":"text","text":"SECRET_CANARY_ASSIST_8f"},{"type":"tool_use","id":"SECRET_CANARY_TUID_90","name":"Bash","input":{"command":"SECRET_CANARY_INPUT_91"}}]}}
{"type":"user","sessionId":"$sid","isSidechain":false,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"SECRET_CANARY_TUID_90","content":"SECRET_CANARY_RESULT_92"}]},"toolUseResult":{"stdout":"SECRET_CANARY_RESULT_93"}}
{"type":"attachment","attachment":{"content":"SECRET_CANARY_ATTACH_94"}}
{"type":"last-prompt","lastPrompt":"SECRET_CANARY_PROMPT_95"}
JSONL
  _w12_ingest "$sid" "$path"

  # Sanity: at least the assistant turn should have produced one row
  # (rules out "parser silently dropped everything" trivially passing).
  local count; count=$(_w12_turn_count "$sid")
  if [ "$count" -lt 2 ]; then
    _assert_fail "expected >=2 rows from W12.5 fixture, got $count"
  fi

  # Grep all SQLite bytes (main + WAL + SHM sidecars) for ANY canary.
  # Must match nothing.
  local hits=0
  for f in "$(_w12_lineage_db)" "$(_w12_lineage_db)-wal" "$(_w12_lineage_db)-shm"; do
    [ -f "$f" ] || continue
    if grep -a -c 'SECRET_CANARY_' "$f" 2>/dev/null | grep -v '^0$' >/dev/null; then
      hits=$((hits + 1))
      _assert_fail "canary leaked into $f" \
        "$(grep -a -o 'SECRET_CANARY_[A-Z_0-9]*' "$f" | sort -u | head -10)"
    fi
  done
  assert_equal "0" "$hits" "0 canary leaks across lineage.sqlite + sidecars (11 forbidden-field types)"
}
register_case "W12.5 privacy fuzz: ZERO canary leakage in lineage.sqlite (load-bearing)" w12_5_privacy_canary_grep

# ── W12.6 — isSidechain → is_sidechain column ─────────────────────────

w12_6_is_sidechain() {
  fixture_baseline_no_apm
  local sid='aa66aaaa-0000-4000-8000-000000000006'
  local path="$FIXTURE_DIR/transcript.jsonl"
  cat > "$path" <<JSONL
{"type":"assistant","sessionId":"$sid","isSidechain":true,"message":{"model":"claude-opus-4-7","usage":{"input_tokens":1,"output_tokens":1},"content":[]}}
{"type":"assistant","sessionId":"$sid","isSidechain":false,"message":{"model":"claude-opus-4-7","usage":{"input_tokens":1,"output_tokens":1},"content":[]}}
JSONL
  _w12_ingest "$sid" "$path"

  local sidechain_list; sidechain_list=$(_w12_query \
    "SELECT is_sidechain FROM turn_metrics WHERE session_id='$sid' ORDER BY turn_index" \
    | tr '\n' ',' | sed 's/,$//')
  assert_equal "1,0" "$sidechain_list" "is_sidechain reflects isSidechain truthy/falsy"
}
register_case "W12.6 isSidechain=true persists as is_sidechain=1" w12_6_is_sidechain

# ── W12.7 — pre-v0.5 snapshot is byte-identical after ingest ──────────

w12_7_pre_v0_5_snapshot_immutable() {
  fixture_baseline_no_apm
  local sid='aa77aaaa-0000-4000-8000-000000000007'
  # Fire the hook with a dummy transcript_path (no version field) so
  # the resulting snapshot has claudeCodeVersion = null. /dev/null
  # is unreadable for our purposes — the readClaudeCodeVersion
  # fallback to `claude --version` could populate it on a host
  # where claude is installed. Use an empty file instead.
  local empty_tx="$FIXTURE_DIR/empty.jsonl"
  : > "$empty_tx"
  jq -nc --arg sid "$sid" --arg cwd "$FIXTURE_DIR" --arg tx "$empty_tx" \
    '{session_id: $sid, cwd: $cwd, hook_event_name: "SessionStart",
      transcript_path: $tx, source: "startup"}' \
    | "$HARNESS_HOOK" >/dev/null 2>&1

  # Pull the full 40-hex id directly from sqlite to avoid log output
  # parsing (color codes vary by terminal).
  local full_id; full_id=$(_w12_query_scalar "SELECT id FROM snapshots LIMIT 1")
  if [ -z "$full_id" ]; then
    _assert_fail "no snapshot written by hook fire"
    return 1
  fi
  local blob_path="$FIXTURE_DIR/.harness/snapshots/${full_id:0:2}/${full_id:2}.json"
  assert_file_exists "$blob_path" "snapshot blob present"
  # Skip if the host populated claudeCodeVersion via claude --version
  # fallback — that's a different scenario, covered by W12.8.
  if grep -q 'claudeCodeVersion' "$blob_path"; then
    assert_equal "ok" "ok" "host populated claudeCodeVersion via fallback (covered by W12.8)"
    return 0
  fi
  local before_hash; before_hash=$(sha256sum "$blob_path" | awk '{print $1}')

  # Now ingest a transcript that DOES carry a version. The snapshot
  # MUST NOT be rewritten.
  local tx="$FIXTURE_DIR/transcript.jsonl"
  cat > "$tx" <<JSONL
{"type":"assistant","sessionId":"$sid","version":"2.1.131","isSidechain":false,"message":{"model":"claude-opus-4-7","usage":{"input_tokens":1,"output_tokens":1},"content":[]}}
JSONL
  _w12_ingest "$sid" "$tx"

  local after_hash; after_hash=$(sha256sum "$blob_path" | awk '{print $1}')
  assert_equal "$before_hash" "$after_hash" \
    "pre-v0.5 snapshot bytes unchanged after ingest (immutability holds)"
  if grep -q 'claudeCodeVersion' "$blob_path"; then
    _assert_fail "ingestion wrote claudeCodeVersion onto a pre-v0.5 snapshot"
  fi
}
register_case "W12.7 pre-v0.5 snapshot immutable under ingestion" w12_7_pre_v0_5_snapshot_immutable

# ── W12.8 — v0.5+ snapshot is byte-identical even when JSONL drifts ───

w12_8_v0_5_snapshot_immutable_under_drift() {
  fixture_baseline_no_apm
  local sid='aa88aaaa-0000-4000-8000-000000000008'
  # Fire with a transcript that reports version=2.1.131 — the snapshot
  # is written with claudeCodeVersion=2.1.131.
  local tx_first="$FIXTURE_DIR/first.jsonl"
  cat > "$tx_first" <<JSONL
{"type":"user","sessionId":"$sid","version":"2.1.131","isSidechain":false,"message":{"role":"user","content":[]}}
JSONL
  jq -nc --arg sid "$sid" --arg cwd "$FIXTURE_DIR" --arg tx "$tx_first" \
    '{session_id: $sid, cwd: $cwd, hook_event_name: "SessionStart",
      transcript_path: $tx, source: "startup"}' \
    | "$HARNESS_HOOK" >/dev/null 2>&1

  local full_id; full_id=$(_w12_query_scalar "SELECT id FROM snapshots LIMIT 1")
  if [ -z "$full_id" ]; then
    _assert_fail "no snapshot written by hook fire"
    return 1
  fi
  local blob_path="$FIXTURE_DIR/.harness/snapshots/${full_id:0:2}/${full_id:2}.json"
  assert_file_contains "$blob_path" '"claudeCodeVersion": "2.1.131"' \
    "v0.5 snapshot has claudeCodeVersion=2.1.131"
  local before_hash; before_hash=$(sha256sum "$blob_path" | awk '{print $1}')

  # Ingest a transcript reporting a DIFFERENT (newer) version. The
  # snapshot's claudeCodeVersion MUST stay at 2.1.131.
  local tx_drift="$FIXTURE_DIR/drift.jsonl"
  cat > "$tx_drift" <<JSONL
{"type":"user","sessionId":"$sid","version":"2.1.140","isSidechain":false,"message":{"role":"user","content":[]}}
{"type":"assistant","sessionId":"$sid","version":"2.1.140","isSidechain":false,"message":{"model":"claude-opus-4-7","usage":{"input_tokens":1,"output_tokens":1},"content":[]}}
JSONL
  _w12_ingest "$sid" "$tx_drift"

  local after_hash; after_hash=$(sha256sum "$blob_path" | awk '{print $1}')
  assert_equal "$before_hash" "$after_hash" \
    "v0.5 snapshot bytes unchanged after ingesting drifted transcript"
  assert_file_contains "$blob_path" '"claudeCodeVersion": "2.1.131"' \
    "claudeCodeVersion still pinned at first-observation value"
}
register_case "W12.8 v0.5+ snapshot immutable across mid-session version drift" w12_8_v0_5_snapshot_immutable_under_drift

# ── W12.9 — session-cost reports correct totals ───────────────────────

w12_9_session_cost_totals() {
  fixture_baseline_no_apm
  local sid='aa99aaaa-0000-4000-8000-000000000009'
  local path="$FIXTURE_DIR/transcript.jsonl"
  _w12_write_5turn_fixture "$sid" "$path"
  _w12_ingest "$sid" "$path"

  local out
  out=$( cd "$FIXTURE_DIR" && "$HARNESS" session-cost "$sid" 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "session-cost exits 0"
  assert_contains "$out" "Turns:                5 (2 user / 3 assistant)" "totals correct"
  assert_contains "$out" "Models:               claude-opus-4-7" "model surfaced"
  # Input tokens (live) = 10+5+1 = 16; cache_read = 1000+500; etc.
  assert_contains "$out" "Input tokens (live):  16" "input_tokens total"
  assert_contains "$out" "Cache read:           1,500" "cache_read total"
  assert_contains "$out" "Cache creation:       100" "cache_creation total"
  assert_contains "$out" "Output tokens:        78" "output_tokens total"
  assert_contains "$out" "Tools called:" "tools list rendered"
  assert_contains "$out" "Bash: 1" "Bash count = 1"
  assert_contains "$out" "Read: 1" "Read count = 1"
  assert_contains "$out" "Edit: 1" "Edit count = 1"
}
register_case "W12.9 session-cost reports correct per-session totals" w12_9_session_cost_totals

# ── W12.10 — --by-tool: call counts + per-tool-token limitation ───────

w12_10_by_tool_limitation_help() {
  fixture_baseline_no_apm
  local sid='bbaaaaaa-0000-4000-8000-000000000010'
  local path="$FIXTURE_DIR/transcript.jsonl"
  _w12_write_5turn_fixture "$sid" "$path"
  _w12_ingest "$sid" "$path"

  local out
  out=$( cd "$FIXTURE_DIR" && "$HARNESS" session-cost "$sid" --by-tool 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "session-cost --by-tool exits 0"
  # The §10.3 limitation MUST appear in the rendered output.
  assert_contains "$out" "per-tool tokens NOT supportable per spec/format.md §10.3" \
    "per-tool-token limitation surfaced"
  # Each tool has its own row with call count.
  assert_matches "$out" 'Bash[[:space:]]+1 call' "Bash row with count"
  assert_matches "$out" 'Read[[:space:]]+1 call' "Read row with count"
  assert_matches "$out" 'Edit[[:space:]]+1 call' "Edit row with count"
}
register_case "W12.10 session-cost --by-tool: call counts + §10.3 limitation surfaced" w12_10_by_tool_limitation_help

# ── W12.11 — ingest-session --all skips missing transcripts ───────────

w12_11_ingest_all_skips_missing() {
  fixture_baseline_no_apm
  # Fire the hook for two sessions to create attribution rows. The
  # hook receives transcript_path=/dev/null so no JSONL exists at the
  # default ~/.claude/projects/<encoded>/<sid>.jsonl path → ingest
  # --all should skip cleanly with a count.
  fire_session_start "$FIXTURE_DIR" 'cc111111-0000-4000-8000-000000000011' startup
  fire_session_start "$FIXTURE_DIR" 'cc222222-0000-4000-8000-000000000012' startup

  local out
  out=$( cd "$FIXTURE_DIR" && "$HARNESS" ingest-session --all 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "ingest-session --all exits 0 even when all transcripts missing"
  assert_contains "$out" "Ingested 0 sessions" "0 ingested when no transcripts on disk"
  assert_contains "$out" "had no transcript on disk" "missing-transcript counter rendered"
}
register_case "W12.11 ingest-session --all skips sessions with no transcript on disk" w12_11_ingest_all_skips_missing

# ── W12.12 — v0.4.x snapshot tolerance check ──────────────────────────

w12_12_v0_4_snapshot_no_claudeCodeVersion_tolerated() {
  fixture_baseline_no_apm
  # The v0.4 compat fixture under spec/examples/compat-fixtures/ has
  # no claudeCodeVersion field. Drop one such blob into the fresh
  # repo and verify reindex+log read it without error.
  local src="$MONOREPO_ROOT/spec/examples/compat-fixtures/.harness/snapshots/f5/e6cac2653911ae8338cd58c683b5fbff9abf3c.json"
  if [ ! -f "$src" ]; then
    _assert_fail "compat fixture missing at $src"
    return 1
  fi
  mkdir -p "$FIXTURE_DIR/.harness/snapshots/f5"
  cp "$src" "$FIXTURE_DIR/.harness/snapshots/f5/e6cac2653911ae8338cd58c683b5fbff9abf3c.json"

  # Sanity: the source blob lacks claudeCodeVersion.
  if grep -q 'claudeCodeVersion' "$src"; then
    _assert_fail "compat fixture unexpectedly carries claudeCodeVersion"
    return 1
  fi

  local rout
  rout=$( ( cd "$FIXTURE_DIR" && "$HARNESS" reindex ) 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "v0.5 reader tolerates v0.4 snapshot without claudeCodeVersion"
  assert_contains "$rout" "+1 snapshots" "blob added to index"

  ( cd "$FIXTURE_DIR" && "$HARNESS" checkout f5e6cac2 >/dev/null 2>&1 )
  local lout
  lout=$( ( cd "$FIXTURE_DIR" && "$HARNESS" log ) 2>&1 )
  local lrc=$?
  assert_exit 0 "$lrc" "log doesn't crash on v0.4 blob at HEAD"
  assert_contains "$lout" "f5e6cac2" "v0.4 blob rendered in log"
}
register_case "W12.12 v0.5 reader tolerates v0.4.x blob without claudeCodeVersion" w12_12_v0_4_snapshot_no_claudeCodeVersion_tolerated
