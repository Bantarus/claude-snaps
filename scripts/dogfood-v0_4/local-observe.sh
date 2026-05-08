#!/usr/bin/env bash
# Local observability test for harness — drives REAL Claude Code
# headless sessions to exercise the SessionStart + UserPromptSubmit
# hook integration end-to-end.
#
# Complementary to ci-playbook.sh:
#   - ci-playbook.sh   synthesizes hook payloads. Deterministic, free,
#                      fast, runs in CI. Catches contract regressions
#                      in the hook + capture + reproduce surface.
#   - local-observe.sh launches `claude -p` against a wired fixture.
#                      Slower, flakier, consumes claude.ai quota. Catches
#                      emergent properties (real session_id format,
#                      real source=startup/resume semantics, real
#                      transcript_path bytes, model + permission_mode
#                      passthrough) that synthesis can't cover.
#
# Auth: uses the locally-logged-in `claude` CLI (claude.ai
# subscription). NO Anthropic API key required. Cost: each case fires
# one or two short `claude -p` invocations against a tiny model
# (haiku-4-5 by default) with --tools "" to suppress tool use; the
# per-case cost is in subscription tokens, not USD billed inference.
#
# Usage:
#   bash scripts/dogfood-v0_4/local-observe.sh           # full run
#   bash scripts/dogfood-v0_4/local-observe.sh --filter '^L1\.1'
#   bash scripts/dogfood-v0_4/local-observe.sh --list
#   bash scripts/dogfood-v0_4/local-observe.sh --leave-state
#   bash scripts/dogfood-v0_4/local-observe.sh --smoke   # plumbing only
#
# Exits 0 if all cases pass; 0 with a skip notice if claude is not
# on PATH (so this script is safe to run in CI without breaking the
# pipeline); non-zero on any case failure.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/lib.sh"
source "$HERE/lib-tap.sh"
source "$HERE/lib-assert.sh"
source "$HERE/lib-fixtures.sh"
source "$HERE/lib-blob.sh"

# ---- flags ----

TAP_FAIL_FAST=0
TAP_FILTER=""
TAP_LIST_ONLY=0
LEAVE_STATE=0
SMOKE_ONLY=0

while [ "$#" -gt 0 ]; do
  case $1 in
    --fail-fast)   TAP_FAIL_FAST=1; shift ;;
    --filter)      TAP_FILTER=$2; shift 2 ;;
    --filter=*)    TAP_FILTER=${1#--filter=}; shift ;;
    --leave-state) LEAVE_STATE=1; shift ;;
    --list)        TAP_LIST_ONLY=1; shift ;;
    --smoke)       SMOKE_ONLY=1; shift ;;
    -h|--help)
      sed -n '2,/^set -uo pipefail/p' "$0" | sed -e 's/^# \{0,1\}//' -e '$d'
      exit 0
      ;;
    *)
      printf 'local-observe: unknown arg: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

# ---- doctor: claude must be on PATH; if not, skip cleanly ----

if ! command -v claude >/dev/null 2>&1; then
  printf '# local-observe: skipping — `claude` not on PATH (this is expected in CI; run locally for end-to-end coverage)\n'
  exit 0
fi

# Default model + permission mode for every case unless a case
# overrides. Haiku-4-5 is the cheapest model we can target while
# still exercising the real auth + hook plumbing.
LOCAL_MODEL="${LOCAL_MODEL:-claude-haiku-4-5-20251001}"
LOCAL_PERM_MODE="${LOCAL_PERM_MODE:-default}"

# Tool surface: disable all tools so Claude responds with text only.
# Tool use would fire PreToolUse / PostToolUse hooks which are
# out-of-scope for v0.4 capture; leaving tools enabled also makes the
# session non-deterministic in length.
LOCAL_TOOLS_OFF='--tools '

# Standard headless invocation. $1=cwd, $2=session-id (uuid),
# $3=prompt. Stdout is captured separately by the caller.
local_claude() {
  local cwd=$1 sid=$2 prompt=$3
  ( cd "$cwd" && claude -p \
      --session-id "$sid" \
      --model "$LOCAL_MODEL" \
      --permission-mode "$LOCAL_PERM_MODE" \
      --tools "" \
      --output-format text \
      "$prompt" )
}

# Resume variant. $1=cwd, $2=session-id-to-resume, $3=prompt.
local_claude_resume() {
  local cwd=$1 sid=$2 prompt=$3
  ( cd "$cwd" && claude -p \
      --resume "$sid" \
      --model "$LOCAL_MODEL" \
      --permission-mode "$LOCAL_PERM_MODE" \
      --tools "" \
      --output-format text \
      "$prompt" )
}

# Generate a deterministic test UUID v4. Pure bash so we don't need
# uuidgen on PATH.
local_uuid() {
  local hex
  hex=$(head -c 16 /dev/urandom | xxd -p)
  printf '%s-%s-4%s-%s-%s\n' \
    "${hex:0:8}" "${hex:8:4}" "${hex:13:3}" "${hex:16:4}" "${hex:20:12}"
}

# ---- scratch dir + cleanup ----

CIP_SCRATCH="${CIP_SCRATCH:-$(mktemp -d "${TMPDIR:-/tmp}/harness-localobs.XXXXXX")}"
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

shopt -s nullglob
if [ "$SMOKE_ONLY" -eq 1 ]; then
  source "$HERE/local_cases/l0_smoke.sh"
else
  # L0 is reserved for --smoke; the regular pass sources L1+ only.
  for case_file in "$HERE"/local_cases/l[1-9]_*.sh "$HERE"/local_cases/l[1-9][0-9]_*.sh; do
    source "$case_file"
  done
fi
shopt -u nullglob

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
