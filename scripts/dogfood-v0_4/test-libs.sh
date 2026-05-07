#!/usr/bin/env bash
# Smoke tests for the ci-playbook libraries. Run inline once after
# library changes; the runner itself does NOT depend on this script.
# Verifies pass-case AND fail-case for every library function.
#
# Exits 0 if every helper behaves as expected, 1 otherwise.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/lib.sh"
source "$HERE/lib-tap.sh"
source "$HERE/lib-assert.sh"
source "$HERE/lib-hook-fire.sh"
source "$HERE/lib-fixtures.sh"

# ---- micro-runner (separate from real TAP to avoid confusion) ----

LIB_PASS=0
LIB_FAIL=0

# Run a sub-test in a subshell. The subshell's CASE_FAILURES/
# CASE_DIAGNOSTICS arrays are isolated so one assertion's failure
# state doesn't leak into the next.
expect_pass() {
  local label=$1; shift
  local rc
  set +e
  ( reset_case_diagnostics; "$@" ); rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    printf '  ok   %s\n' "$label"
    LIB_PASS=$((LIB_PASS + 1))
  else
    printf '  FAIL %s (expected pass, got rc=%d)\n' "$label" "$rc"
    LIB_FAIL=$((LIB_FAIL + 1))
  fi
}

expect_fail() {
  local label=$1; shift
  local rc
  set +e
  ( reset_case_diagnostics; "$@" ); rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    printf '  ok   %s\n' "$label"
    LIB_PASS=$((LIB_PASS + 1))
  else
    printf '  FAIL %s (expected fail, got pass)\n' "$label"
    LIB_FAIL=$((LIB_FAIL + 1))
  fi
}

# ---- lib-assert.sh ----

printf '\n[lib-assert.sh]\n'

expect_pass "assert_equal pass"     assert_equal a a
expect_fail "assert_equal fail"     assert_equal a b
expect_pass "assert_not_equal pass" assert_not_equal a b
expect_fail "assert_not_equal fail" assert_not_equal a a
expect_pass "assert_contains pass"  assert_contains "hello world" "world"
expect_fail "assert_contains fail"  assert_contains "hello world" "moon"
expect_pass "assert_not_contains pass" assert_not_contains "hello" "moon"
expect_fail "assert_not_contains fail" assert_not_contains "hello world" "world"
expect_pass "assert_matches pass"   assert_matches "v0.4.1" '^v[0-9]+\.[0-9]+\.[0-9]+$'
expect_fail "assert_matches fail"   assert_matches "no version" '^v[0-9]+'
expect_pass "assert_count pass"     assert_count 3 3
expect_fail "assert_count fail"     assert_count 3 4

TMPF=$(mktemp)
TMPD=$(mktemp -d)
echo "needle inside file" > "$TMPF"

expect_pass "assert_file_exists pass"     assert_file_exists "$TMPF"
expect_fail "assert_file_exists fail"     assert_file_exists "/nonexistent/path"
expect_pass "assert_file_not_exists pass" assert_file_not_exists "/nonexistent/path"
expect_fail "assert_file_not_exists fail" assert_file_not_exists "$TMPF"
expect_pass "assert_dir_exists pass"      assert_dir_exists "$TMPD"
expect_fail "assert_dir_exists fail"      assert_dir_exists "/nonexistent/dir"
expect_pass "assert_dir_not_exists pass"  assert_dir_not_exists "/nonexistent/dir"
expect_fail "assert_dir_not_exists fail"  assert_dir_not_exists "$TMPD"
expect_pass "assert_file_contains pass"   assert_file_contains "$TMPF" "needle"
expect_fail "assert_file_contains fail"   assert_file_contains "$TMPF" "haystack"
expect_fail "assert_file_contains missing-file" assert_file_contains "/nonexistent" "x"

EXP_HASH=$(sha256sum "$TMPF" | awk '{print $1}')
expect_pass "assert_file_hash pass" assert_file_hash "$TMPF" "$EXP_HASH"
expect_fail "assert_file_hash fail" assert_file_hash "$TMPF" 0000000000000000000000000000000000000000000000000000000000000000

LINK=$(mktemp -u)
ln -s "$TMPF" "$LINK"
expect_pass "assert_symlink pass" assert_symlink "$LINK"
expect_fail "assert_symlink fail" assert_symlink "$TMPF"
rm -f "$LINK"

expect_pass "assert_exit pass"           assert_exit 0 0
expect_fail "assert_exit fail"           assert_exit 0 1
expect_pass "assert_stdout_matches pass" assert_stdout_matches "version 1.2.3" '[0-9]+\.[0-9]+\.[0-9]+'
expect_fail "assert_stdout_matches fail" assert_stdout_matches "no version" '[0-9]+\.[0-9]+\.[0-9]+'
expect_pass "assert_stderr_contains pass" assert_stderr_contains "error: foo" "error:"
expect_fail "assert_stderr_contains fail" assert_stderr_contains "ok" "error:"

JSON='{"a": {"b": [1, 2, 3]}, "name": "harness"}'
expect_pass "assert_json_path pass"   assert_json_path "$JSON" '.name' "harness"
expect_fail "assert_json_path fail"   assert_json_path "$JSON" '.name' "wrong"
expect_pass "assert_json_count pass"  assert_json_count "$JSON" '.a.b' 3
expect_fail "assert_json_count fail"  assert_json_count "$JSON" '.a.b' 5

rm -f "$TMPF"
rm -rf "$TMPD"

# ---- lib-tap.sh (run_case + diagnostic arrays) ----

printf '\n[lib-tap.sh]\n'

# Reset counters for a clean micro-run.
TAP_CASE_INDEX=0; TAP_CASE_PASS=0; TAP_CASE_FAIL=0

_pass_case() { assert_equal a a "trivial"; }
_fail_case() { assert_equal a b "trivial"; }

# Capture the runner's stdout instead of letting it spam.
TAP_OUT=$(
  TAP_CASE_INDEX=0
  TAP_CASE_PASS=0
  TAP_CASE_FAIL=0
  run_case "P1" _pass_case
  run_case "P2" _pass_case
  run_case "F1" _fail_case
  printf 'pass=%d fail=%d total=%d\n' "$TAP_CASE_PASS" "$TAP_CASE_FAIL" "$TAP_CASE_INDEX"
)

if echo "$TAP_OUT" | grep -q 'pass=2 fail=1 total=3'; then
  printf '  ok   run_case counts pass/fail correctly\n'
  LIB_PASS=$((LIB_PASS + 1))
else
  printf '  FAIL run_case counts wrong\n%s\n' "$TAP_OUT"
  LIB_FAIL=$((LIB_FAIL + 1))
fi

if echo "$TAP_OUT" | grep -qE '^ok 1 - P1$'; then
  printf '  ok   ok-line shape\n'; LIB_PASS=$((LIB_PASS + 1))
else
  printf '  FAIL ok-line shape\n%s\n' "$TAP_OUT"; LIB_FAIL=$((LIB_FAIL + 1))
fi

if echo "$TAP_OUT" | grep -qE '^not ok 3 - F1$'; then
  printf '  ok   not-ok-line shape\n'; LIB_PASS=$((LIB_PASS + 1))
else
  printf '  FAIL not-ok-line shape\n%s\n' "$TAP_OUT"; LIB_FAIL=$((LIB_FAIL + 1))
fi

if echo "$TAP_OUT" | grep -q 'failures:'; then
  printf '  ok   YAML diagnostic block emitted\n'; LIB_PASS=$((LIB_PASS + 1))
else
  printf '  FAIL YAML diagnostic block missing\n%s\n' "$TAP_OUT"; LIB_FAIL=$((LIB_FAIL + 1))
fi

# Filter test
TAP_OUT_FILT=$(
  TAP_CASE_INDEX=0
  TAP_CASE_PASS=0
  TAP_CASE_FAIL=0
  TAP_FILTER='^P'
  run_case "P1" _pass_case
  run_case "X1" _pass_case
  run_case "P2" _pass_case
  printf 'pass=%d total=%d\n' "$TAP_CASE_PASS" "$TAP_CASE_INDEX"
)
if echo "$TAP_OUT_FILT" | grep -q 'pass=2 total=2'; then
  printf '  ok   TAP_FILTER selects matching cases\n'; LIB_PASS=$((LIB_PASS + 1))
else
  printf '  FAIL TAP_FILTER\n%s\n' "$TAP_OUT_FILT"; LIB_FAIL=$((LIB_FAIL + 1))
fi

# List-only test
TAP_OUT_LIST=$(
  TAP_CASE_INDEX=0
  TAP_CASE_PASS=0
  TAP_CASE_FAIL=0
  TAP_LIST_ONLY=1
  run_case "L1" _pass_case
  run_case "L2" _fail_case
)
if [ "$(echo "$TAP_OUT_LIST" | wc -l)" = "2" ] && \
   echo "$TAP_OUT_LIST" | grep -q '^L1$' && \
   echo "$TAP_OUT_LIST" | grep -q '^L2$'; then
  printf '  ok   TAP_LIST_ONLY emits names without running\n'; LIB_PASS=$((LIB_PASS + 1))
else
  printf '  FAIL TAP_LIST_ONLY\n%s\n' "$TAP_OUT_LIST"; LIB_FAIL=$((LIB_FAIL + 1))
fi

# ---- lib-hook-fire.sh + lib-fixtures.sh (require harness binaries) ----

printf '\n[lib-hook-fire.sh + lib-fixtures.sh]\n'

if [ ! -x "$HARNESS" ] && ! command -v "$HARNESS" >/dev/null 2>&1; then
  printf '  SKIP (HARNESS=%s not executable)\n' "$HARNESS"
else
  CIP_SCRATCH="$(mktemp -d)"
  trap 'rm -rf "$CIP_SCRATCH"' EXIT

  # Empty fixture — just a tmpdir.
  fixture_empty_project
  expect_pass "fixture_empty_project creates dir" assert_dir_exists "$FIXTURE_DIR"
  expect_fail "fixture_empty_project has no .harness" assert_dir_exists "$FIXTURE_DIR/.harness"

  # Empty git fixture — has .git, no .harness.
  fixture_empty_git_project
  expect_pass "fixture_empty_git_project has .git" assert_dir_exists "$FIXTURE_DIR/.git"
  expect_fail "fixture_empty_git_project has no .harness" assert_dir_exists "$FIXTURE_DIR/.harness"

  # Baseline — full harness init + install-hook.
  fixture_baseline_no_apm
  expect_pass "baseline has .harness/HEAD"          assert_file_exists "$FIXTURE_DIR/.harness/HEAD"
  expect_pass "baseline has .claude/settings.json"  assert_file_exists "$FIXTURE_DIR/.claude/settings.json"
  expect_pass "baseline has notes skill"            assert_file_exists "$FIXTURE_DIR/.claude/skills/notes/SKILL.md"

  # Hook fire — record one session_start. Verify via `harness sessions`
  # which lists session ids that have attribution rows.
  fire_session_start "$FIXTURE_DIR" cip-test-1 startup
  HARNESS_SESSIONS=$(cd "$FIXTURE_DIR" && "$HARNESS" sessions 2>&1 || true)
  if echo "$HARNESS_SESSIONS" | grep -q 'cip-test-1'; then
    printf '  ok   fire_session_start produced a session attribution\n'; LIB_PASS=$((LIB_PASS + 1))
  else
    printf '  FAIL fire_session_start (sessions: %s)\n' "$HARNESS_SESSIONS"; LIB_FAIL=$((LIB_FAIL + 1))
  fi

  # Malformed stdin must still exit 0 (defense-in-depth).
  set +e
  fire_malformed_stdin "$FIXTURE_DIR" >/dev/null 2>&1
  RC=$?
  set -e
  if [ "$RC" -eq 0 ]; then
    printf '  ok   fire_malformed_stdin exits 0\n'; LIB_PASS=$((LIB_PASS + 1))
  else
    printf '  FAIL fire_malformed_stdin rc=%d (expected 0)\n' "$RC"; LIB_FAIL=$((LIB_FAIL + 1))
  fi

  set +e
  fire_no_stdin "$FIXTURE_DIR" >/dev/null 2>&1
  RC=$?
  set -e
  if [ "$RC" -eq 0 ]; then
    printf '  ok   fire_no_stdin exits 0\n'; LIB_PASS=$((LIB_PASS + 1))
  else
    printf '  FAIL fire_no_stdin rc=%d (expected 0)\n' "$RC"; LIB_FAIL=$((LIB_FAIL + 1))
  fi
fi

# ---- summary ----

printf '\n[summary] pass=%d fail=%d\n' "$LIB_PASS" "$LIB_FAIL"
if [ "$LIB_FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
