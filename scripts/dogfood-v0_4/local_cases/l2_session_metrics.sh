# Workflow L2 — v0.5 session-metrics validation against real claude -p.
#
# Companion to local_cases/l2_v0_5_pre_flight.sh:
#   - pre-flight cases (L2.1, L2.2, L2.3) are DRIFT DETECTORS that
#     turn red when the host changes shape (hook event inventory,
#     project-dir encoding, attributionSkill semantics)
#   - this file's cases (L2.4, L2.5, L2.6) are INGESTION GATES that
#     drive a real `claude -p`, run `harness ingest-session` against
#     the resulting JSONL, and verify token-count / row-count
#     correctness end-to-end through the real CLI binaries.
#
# These are the load-bearing v0.5 integration tests — they catch
# bugs the synthesized W12 fixtures can't (e.g. "Claude Code 2.2
# adds a new turn-line type the parser silently miscounts").

# Pull a scalar value from lineage.sqlite via python3 + stdlib.
_l2_query_scalar() {
  local cwd=$1 sql=$2
  python3 -c '
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
row = next(conn.execute(sys.argv[2]), None)
if row is not None:
    print("|".join("" if c is None else str(c) for c in row))
' "$cwd/.harness/lineage.sqlite" "$sql"
}

# Find the JSONL transcript Claude Code wrote for a session in this
# fixture cwd. Returns "" if the file doesn't exist.
_l2_find_jsonl() {
  local cwd=$1 sid=$2
  local encoded; encoded=$(echo -n "$cwd" | sed 's/[^a-zA-Z0-9]/-/g')
  local path="$HOME/.claude/projects/$encoded/$sid.jsonl"
  [ -f "$path" ] && printf '%s' "$path"
}

# L2.4 — End-to-end: drive a real claude -p, ingest the resulting
# JSONL, verify the ingested row count matches the JSONL's
# user/assistant line count exactly.
l2_4_ingest_real_session_row_count() {
  fixture_baseline_no_apm
  local sid; sid=$(local_uuid)
  local_claude "$FIXTURE_DIR" "$sid" "Reply with the single word OK." >/dev/null 2>&1
  local rc=$?
  assert_exit 0 "$rc" "claude -p exits 0"

  local jsonl; jsonl=$(_l2_find_jsonl "$FIXTURE_DIR" "$sid")
  if [ -z "$jsonl" ]; then
    _assert_fail "session JSONL missing — host did not write to predicted path"
    return 1
  fi
  # Count user/assistant lines directly from the JSONL.
  local jsonl_users; jsonl_users=$(jq -c 'select(.type == "user")' "$jsonl" 2>/dev/null | wc -l)
  local jsonl_asst; jsonl_asst=$(jq -c 'select(.type == "assistant")' "$jsonl" 2>/dev/null | wc -l)
  local jsonl_total=$((jsonl_users + jsonl_asst))

  # Run ingest-session (the JSONL path is auto-resolved per §10.5).
  local out
  out=$( cd "$FIXTURE_DIR" && "$HARNESS" ingest-session "$sid" 2>&1 )
  local irc=$?
  assert_exit 0 "$irc" "ingest-session exits 0"
  assert_contains "$out" "Ingested $jsonl_total new turns" \
    "ingested row count = JSONL message-line count"

  # Cross-check via the database directly.
  local db_total
  db_total=$(_l2_query_scalar "$FIXTURE_DIR" \
    "SELECT COUNT(*) FROM turn_metrics WHERE session_id='$sid'")
  assert_equal "$jsonl_total" "$db_total" \
    "turn_metrics row count = JSONL message-line count"
  local db_users
  db_users=$(_l2_query_scalar "$FIXTURE_DIR" \
    "SELECT COUNT(*) FROM turn_metrics WHERE session_id='$sid' AND turn_type='user'")
  assert_equal "$jsonl_users" "$db_users" "user row count matches"
  local db_asst
  db_asst=$(_l2_query_scalar "$FIXTURE_DIR" \
    "SELECT COUNT(*) FROM turn_metrics WHERE session_id='$sid' AND turn_type='assistant'")
  assert_equal "$jsonl_asst" "$db_asst" "assistant row count matches"

  # Cleanup the host project dir we created.
  local encoded; encoded=$(echo -n "$FIXTURE_DIR" | sed 's/[^a-zA-Z0-9]/-/g')
  rm -rf "$HOME/.claude/projects/$encoded"
}
register_case "L2.4 ingest real claude -p session: row count = JSONL message count" l2_4_ingest_real_session_row_count

# L2.5 — Token-count fidelity: the sum of input/output/cache tokens
# in turn_metrics matches the assistant turns' usage blocks in the
# JSONL. This is the privacy-safe analog of "verify token totals
# match `claude --output-format json` usage report" — we can't get
# JSON output for free with --tools "" so we cross-check against the
# canonical source (the JSONL itself).
l2_5_ingest_token_fidelity() {
  fixture_baseline_no_apm
  local sid; sid=$(local_uuid)
  local_claude "$FIXTURE_DIR" "$sid" "Reply with one short word." >/dev/null 2>&1
  local rc=$?
  assert_exit 0 "$rc" "claude -p exits 0"

  local jsonl; jsonl=$(_l2_find_jsonl "$FIXTURE_DIR" "$sid")
  if [ -z "$jsonl" ]; then
    _assert_fail "session JSONL missing"
    return 1
  fi
  # Sum each token column from the JSONL assistant turns.
  local jsonl_input
  jsonl_input=$(jq -s '[.[] | select(.type == "assistant") | .message.usage.input_tokens // 0] | add' "$jsonl")
  local jsonl_output
  jsonl_output=$(jq -s '[.[] | select(.type == "assistant") | .message.usage.output_tokens // 0] | add' "$jsonl")
  local jsonl_cache_read
  jsonl_cache_read=$(jq -s '[.[] | select(.type == "assistant") | .message.usage.cache_read_input_tokens // 0] | add' "$jsonl")
  local jsonl_cache_create
  jsonl_cache_create=$(jq -s '[.[] | select(.type == "assistant") | .message.usage.cache_creation_input_tokens // 0] | add' "$jsonl")

  ( cd "$FIXTURE_DIR" && "$HARNESS" ingest-session "$sid" >/dev/null 2>&1 )

  local db_input db_output db_cache_read db_cache_create
  db_input=$(_l2_query_scalar "$FIXTURE_DIR" \
    "SELECT COALESCE(SUM(input_tokens), 0) FROM turn_metrics WHERE session_id='$sid'")
  db_output=$(_l2_query_scalar "$FIXTURE_DIR" \
    "SELECT COALESCE(SUM(output_tokens), 0) FROM turn_metrics WHERE session_id='$sid'")
  db_cache_read=$(_l2_query_scalar "$FIXTURE_DIR" \
    "SELECT COALESCE(SUM(cache_read_input_tokens), 0) FROM turn_metrics WHERE session_id='$sid'")
  db_cache_create=$(_l2_query_scalar "$FIXTURE_DIR" \
    "SELECT COALESCE(SUM(cache_creation_input_tokens), 0) FROM turn_metrics WHERE session_id='$sid'")

  assert_equal "$jsonl_input"        "$db_input"        "input_tokens sum matches JSONL"
  assert_equal "$jsonl_output"       "$db_output"       "output_tokens sum matches JSONL"
  assert_equal "$jsonl_cache_read"   "$db_cache_read"   "cache_read_input_tokens sum matches JSONL"
  assert_equal "$jsonl_cache_create" "$db_cache_create" "cache_creation_input_tokens sum matches JSONL"

  # Cross-check via the CLI's session-cost output.
  local cost_out
  cost_out=$( cd "$FIXTURE_DIR" && "$HARNESS" session-cost "$sid" 2>&1 )
  local crc=$?
  assert_exit 0 "$crc" "session-cost exits 0"
  assert_contains "$cost_out" "Models:               $LOCAL_MODEL" \
    "session-cost reports the model claude -p ran with"

  local encoded; encoded=$(echo -n "$FIXTURE_DIR" | sed 's/[^a-zA-Z0-9]/-/g')
  rm -rf "$HOME/.claude/projects/$encoded"
}
register_case "L2.5 ingest real claude -p session: token totals match JSONL usage blocks" l2_5_ingest_token_fidelity

# L2.6 — Privacy whitelist holds against a REAL session. Drive
# claude -p with a prompt containing a unique canary token. After
# ingestion, grep all of lineage.sqlite (and the snapshot blobs
# the hot-path wrote) for that canary. Zero matches required —
# the prompt content MUST NOT have leaked into harness storage.
#
# This is the load-bearing privacy check at the integration layer:
# W12.5 (synthesized) verifies the parser; this case verifies the
# parser-as-deployed against a real Claude Code transcript.
l2_6_real_session_no_prompt_leak() {
  fixture_baseline_no_apm
  local sid; sid=$(local_uuid)
  local canary="L2_PRIVACY_CANARY_$(date +%s%N)"
  local prompt="Reply with one word and ignore the rest: $canary FILLER"
  local_claude "$FIXTURE_DIR" "$sid" "$prompt" >/dev/null 2>&1
  local rc=$?
  assert_exit 0 "$rc" "claude -p exits 0"

  local jsonl; jsonl=$(_l2_find_jsonl "$FIXTURE_DIR" "$sid")
  if [ -z "$jsonl" ]; then
    _assert_fail "session JSONL missing"
    return 1
  fi
  # Sanity: the canary IS in the transcript JSONL (otherwise we're
  # not actually testing prompt-leakage).
  if ! grep -q "$canary" "$jsonl"; then
    _assert_fail "canary not present in JSONL — test is no-op"
    return 1
  fi

  ( cd "$FIXTURE_DIR" && "$HARNESS" ingest-session "$sid" >/dev/null 2>&1 )

  local hits=0
  for f in "$FIXTURE_DIR/.harness/lineage.sqlite" \
           "$FIXTURE_DIR/.harness/lineage.sqlite-wal" \
           "$FIXTURE_DIR/.harness/lineage.sqlite-shm"; do
    [ -f "$f" ] || continue
    if grep -a -q "$canary" "$f" 2>/dev/null; then
      hits=$((hits + 1))
      _assert_fail "real-session canary leaked into $f"
    fi
  done
  # Also grep all snapshot blobs.
  while IFS= read -r blob; do
    if grep -a -q "$canary" "$blob" 2>/dev/null; then
      hits=$((hits + 1))
      _assert_fail "real-session canary leaked into snapshot blob $blob"
    fi
  done < <(find "$FIXTURE_DIR/.harness/snapshots" -type f -name '*.json' 2>/dev/null)

  assert_equal "0" "$hits" "ZERO leaks of real-session prompt canary across all harness storage"

  local encoded; encoded=$(echo -n "$FIXTURE_DIR" | sed 's/[^a-zA-Z0-9]/-/g')
  rm -rf "$HOME/.claude/projects/$encoded"
}
register_case "L2.6 real claude -p prompt canary does NOT leak into harness storage" l2_6_real_session_no_prompt_leak
