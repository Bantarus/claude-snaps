#!/usr/bin/env bash
# Self-tests for ci-playbook.sh per docs/ci-playbook-prompt.md §"Test
# gates".
#
# Verifies CIP1, CIP3, CIP4, CIP5, CIP6 inline. CIP2 (regression
# detection) requires `git revert --no-commit <commit>` cycles and
# is documented in scripts/dogfood-v0_4/README.md — run it manually
# before merging changes that touch a load-bearing v0.4.1 commit.
#
# Exits 0 iff every gate passes.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$HERE/ci-playbook.sh"

pass=0
fail=0
report() {
  local name=$1 ok=$2; shift 2
  if [ "$ok" -eq 0 ]; then
    printf '  ok   %s\n' "$name"
    pass=$((pass + 1))
  else
    printf '  FAIL %s\n' "$name"
    [ "$#" -gt 0 ] && printf '         %s\n' "$@"
    fail=$((fail + 1))
  fi
}

printf '\n[CIP1] clean run on green commit\n'
out1=$(bash "$RUNNER" 2>&1)
rc1=$?
total=$(printf '%s\n' "$out1" | grep -E '^1\.\.([0-9]+)$' | head -1 | sed -E 's/1\.\.//')
passed=$(printf '%s\n' "$out1" | grep -cE '^ok ')
if [ "$rc1" -eq 0 ] && [ -n "$total" ] && [ "$passed" = "$total" ]; then
  report "all $total cases pass" 0
else
  report "all cases pass" 1 "rc=$rc1 plan=$total ok=$passed"
fi

printf '\n[CIP3] idempotent re-run\n'
out2=$(bash "$RUNNER" 2>&1)
rc2=$?
report "second run still exits 0" "$rc2"

printf '\n[CIP4] selective filter\n'
out_w6=$(bash "$RUNNER" --filter '^W6' 2>&1)
rc_w6=$?
plan_w6=$(printf '%s\n' "$out_w6" | grep -E '^1\.\.([0-9]+)$' | head -1 | sed -E 's/1\.\.//')
ok_w6=$(printf '%s\n' "$out_w6" | grep -cE '^ok ')
no_w_other=$(printf '%s\n' "$out_w6" | grep -cE '^(ok|not ok) [0-9]+ - W([12345789]|10|11)\.')
if [ "$rc_w6" -eq 0 ] && [ "$plan_w6" = "$ok_w6" ] && [ "$no_w_other" -eq 0 ] && [ "$plan_w6" -gt 0 ]; then
  report "--filter '^W6' selects only W6 cases (plan=$plan_w6)" 0
else
  report "--filter '^W6' selects only W6" 1 "rc=$rc_w6 plan=$plan_w6 ok=$ok_w6 other=$no_w_other"
fi

printf '\n[CIP5] cleanup behavior\n'
TMP_PASS_DIR=/tmp/cip-self-test-pass-$$
CIP_SCRATCH="$TMP_PASS_DIR" bash "$RUNNER" --filter '^W1\.1' >/dev/null 2>&1
if [ ! -e "$TMP_PASS_DIR" ]; then
  report "scratch removed after a green run (--leave-state OFF)" 0
else
  report "scratch removed" 1 "still exists: $TMP_PASS_DIR"
  rm -rf "$TMP_PASS_DIR"
fi
TMP_LEAVE_DIR=/tmp/cip-self-test-leave-$$
CIP_SCRATCH="$TMP_LEAVE_DIR" bash "$RUNNER" --filter '^W1\.1' --leave-state >/dev/null 2>&1
if [ -d "$TMP_LEAVE_DIR" ]; then
  report "--leave-state preserves scratch" 0
  rm -rf "$TMP_LEAVE_DIR"
else
  report "--leave-state preserves scratch" 1
fi

printf '\n[CIP6] --list count matches plan\n'
list_count=$(bash "$RUNNER" --list 2>&1 | grep -cE '^W[0-9]+\.')
plan_count=$(bash "$RUNNER" 2>&1 | grep -E '^1\.\.([0-9]+)$' | head -1 | sed -E 's/1\.\.//')
if [ "$list_count" = "$plan_count" ] && [ "$list_count" -gt 0 ]; then
  report "list outputs $list_count entries matching plan ($plan_count)" 0
else
  report "list count matches plan" 1 "list=$list_count plan=$plan_count"
fi

printf '\n[summary] pass=%d fail=%d\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
