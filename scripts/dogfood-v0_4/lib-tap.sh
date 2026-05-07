# TAP 14 output formatter for ci-playbook.sh.
#
# A "case" is one assertion target. The runner calls `run_case` with a
# label and a function; this library handles TAP emission and tracks
# pass/fail counts.

# Counters maintained by the runner.
TAP_CASE_INDEX=0       # incremented per case run
TAP_CASE_PASS=0
TAP_CASE_FAIL=0
TAP_FAIL_FAST=${TAP_FAIL_FAST:-0}
TAP_FILTER=${TAP_FILTER:-}
TAP_LIST_ONLY=${TAP_LIST_ONLY:-0}

# Diagnostic accumulators populated by lib-assert.sh per case. Cleared
# at the start of each case via reset_case_diagnostics.
declare -a CASE_FAILURES=()
declare -a CASE_DIAGNOSTICS=()

reset_case_diagnostics() {
  CASE_FAILURES=()
  CASE_DIAGNOSTICS=()
}

tap_version() {
  printf 'TAP version 14\n'
}

tap_plan() {
  local count=$1
  printf '1..%d\n' "$count"
}

tap_workflow_header() {
  local label=$1
  printf '# Workflow %s\n' "$label"
}

tap_comment() {
  printf '# %s\n' "$*"
}

# Emit `ok N - <label>`. Diagnostic-free.
_tap_ok() {
  local num=$1 label=$2
  printf 'ok %d - %s\n' "$num" "$label"
}

# Emit `not ok N - <label>` plus a YAML diagnostic block listing the
# failures and any diagnostic context lines.
_tap_not_ok() {
  local num=$1 label=$2
  printf 'not ok %d - %s\n' "$num" "$label"
  printf '  ---\n'
  printf '  failures:\n'
  if [ ${#CASE_FAILURES[@]} -eq 0 ]; then
    printf '    - "(no failure messages captured)"\n'
  else
    local f
    for f in "${CASE_FAILURES[@]}"; do
      printf '    - %s\n' "$(_yaml_escape "$f")"
    done
  fi
  if [ ${#CASE_DIAGNOSTICS[@]} -gt 0 ]; then
    printf '  diagnostics:\n'
    local d
    for d in "${CASE_DIAGNOSTICS[@]}"; do
      printf '    - %s\n' "$(_yaml_escape "$d")"
    done
  fi
  printf '  ---\n'
}

# Minimal YAML scalar escape: quote-and-backslash-escape the string.
_yaml_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  printf '"%s"' "$s"
}

# Run one case. Args: <label> <function-name>.
# Honors TAP_FILTER (regex against label). Honors TAP_LIST_ONLY.
# Honors TAP_FAIL_FAST (exits 1 on first failure once tap_summary
# would have printed).
run_case() {
  local label=$1 fn=$2

  if [ -n "$TAP_FILTER" ] && ! [[ "$label" =~ $TAP_FILTER ]]; then
    return 0
  fi

  TAP_CASE_INDEX=$((TAP_CASE_INDEX + 1))

  if [ "$TAP_LIST_ONLY" -eq 1 ]; then
    printf '%s\n' "$label"
    return 0
  fi

  reset_case_diagnostics
  # Run the case function. Tolerate non-zero exit; assertions populate
  # CASE_FAILURES rather than relying on the function's exit code.
  set +e
  "$fn"
  local fn_rc=$?
  set -e

  # Surface unexpected non-zero exits as a synthetic failure (helps
  # catch unbound variable / set -e hits inside the case).
  if [ "$fn_rc" -ne 0 ] && [ ${#CASE_FAILURES[@]} -eq 0 ]; then
    CASE_FAILURES+=("case function exited non-zero (rc=$fn_rc) with no captured assertion failures")
  fi

  if [ ${#CASE_FAILURES[@]} -eq 0 ]; then
    _tap_ok "$TAP_CASE_INDEX" "$label"
    TAP_CASE_PASS=$((TAP_CASE_PASS + 1))
  else
    _tap_not_ok "$TAP_CASE_INDEX" "$label"
    TAP_CASE_FAIL=$((TAP_CASE_FAIL + 1))
    if [ "$TAP_FAIL_FAST" -eq 1 ]; then
      tap_summary
      exit 1
    fi
  fi
}

# Final summary. Returns 0 if all passed, 1 otherwise.
tap_summary() {
  if [ "$TAP_LIST_ONLY" -eq 1 ]; then
    return 0
  fi
  local total=$((TAP_CASE_PASS + TAP_CASE_FAIL))
  if [ "$TAP_CASE_FAIL" -eq 0 ]; then
    printf '\n# All %d cases passed\n' "$total"
    return 0
  fi
  printf '\n# %d of %d cases failed\n' "$TAP_CASE_FAIL" "$total"
  return 1
}
