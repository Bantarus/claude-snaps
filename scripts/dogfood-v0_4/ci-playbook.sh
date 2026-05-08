#!/usr/bin/env bash
# CI-runnable observation playbook for harness v0.4.x.
#
# Replaces real-world observation as the verification channel: every
# (state, action) → (expected) triple in the v0.4.1 contract is
# enumerated as a deterministic case, asserted against durable
# artifacts in .harness/.
#
# Usage:
#   bash scripts/dogfood-v0_4/ci-playbook.sh [flags]
#
# Flags:
#   --fail-fast       exit on first 'not ok'
#   --filter <regex>  run only cases whose label matches (e.g. ^W6)
#   --no-color        no-op (TAP output is plain text)
#   --leave-state     skip on-exit cleanup of $CIP_SCRATCH
#   --list            print all case labels without running
#
# Exits 0 if every registered case passes; non-zero on any failure
# (or 1 immediately if --fail-fast).

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/lib.sh"
source "$HERE/lib-tap.sh"
source "$HERE/lib-assert.sh"
source "$HERE/lib-hook-fire.sh"
source "$HERE/lib-fixtures.sh"
source "$HERE/lib-blob.sh"
source "$HERE/lib-jsonl.sh"

# ---- flags ----

TAP_FAIL_FAST=0
TAP_FILTER=""
TAP_LIST_ONLY=0
LEAVE_STATE=0

while [ "$#" -gt 0 ]; do
  case $1 in
    --fail-fast)   TAP_FAIL_FAST=1; shift ;;
    --filter)      TAP_FILTER=$2; shift 2 ;;
    --filter=*)    TAP_FILTER=${1#--filter=}; shift ;;
    --no-color)    shift ;;
    --leave-state) LEAVE_STATE=1; shift ;;
    --list)        TAP_LIST_ONLY=1; shift ;;
    -h|--help)
      sed -n '2,/^set -uo pipefail/p' "$0" | sed -e 's/^# \{0,1\}//' -e '$d'
      exit 0
      ;;
    *)
      printf 'ci-playbook: unknown arg: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

# ---- doctor: verify required runtime deps ----

_require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'ci-playbook: missing required command: %s\n' "$1" >&2
    exit 2
  fi
}

_require_cmd bash
_require_cmd git
_require_cmd jq
_require_cmd python3
_require_cmd node

if [ ! -x "$HARNESS" ]; then
  printf 'ci-playbook: HARNESS=%s is not executable\n' "$HARNESS" >&2
  exit 2
fi
if [ ! -x "$HARNESS_HOOK" ]; then
  printf 'ci-playbook: HARNESS_HOOK=%s is not executable\n' "$HARNESS_HOOK" >&2
  exit 2
fi

# apm is verified per-case (W6.10 deliberately tests the no-apm path).

# ---- scratch dir + cleanup ----

CIP_SCRATCH="${CIP_SCRATCH:-$(mktemp -d "${TMPDIR:-/tmp}/harness-cip.XXXXXX")}"
export CIP_SCRATCH

_cleanup() {
  if [ "$LEAVE_STATE" -eq 1 ]; then
    printf '\n# CIP_SCRATCH retained at: %s\n' "$CIP_SCRATCH"
    return 0
  fi
  if [ -n "${CIP_SCRATCH:-}" ] && [ -d "$CIP_SCRATCH" ]; then
    rm -rf "$CIP_SCRATCH"
  fi
}
trap _cleanup EXIT

# ---- register cases ----

# Cases live in cases/w*.sh; each file sources via register_case calls.
# Loaded in numeric order. Bash globs sort lexicographically so w10/w11
# come AFTER w2 — fix by listing explicitly when we add cases beyond W9.
shopt -s nullglob
for case_file in "$HERE"/cases/w[0-9]_*.sh; do
  source "$case_file"
done
for case_file in "$HERE"/cases/w[1-9][0-9]_*.sh; do
  source "$case_file"
done
shopt -u nullglob

# Skeleton sanity cases — verify the runner shape itself before any
# real workflow. Removed once W1 lands.
if [ "${#REGISTERED_LABELS[@]}" -eq 0 ]; then
  _skel_pass() { assert_equal a a "skeleton pass"; }
  _skel_fail() { assert_equal a b "skeleton fail (expected: this case is intentionally failing)"; }
  register_case "S0.1 skeleton trivial pass" _skel_pass
  register_case "S0.2 skeleton trivial fail (expected)" _skel_fail
fi

# ---- emit TAP + run ----

PLAN_COUNT=$(count_filtered_cases)

if [ "$TAP_LIST_ONLY" -eq 1 ]; then
  run_registered_cases
  exit 0
fi

tap_version
tap_plan "$PLAN_COUNT"

run_registered_cases

if tap_summary; then
  exit 0
else
  exit 1
fi
