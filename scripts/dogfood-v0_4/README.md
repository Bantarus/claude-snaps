# CI playbook (v0.4.x)

CI-runnable observation playbook for harness. Replaces real-world
human evaluation with deterministic assertions over every meaningful
`(state, action) → (expected outcome)` triple in the v0.4.1 contract.

When CI is green, the contract holds. When CI fails, the failing
assertion names the regression precisely.

## How to run

Locally:

```bash
bash scripts/dogfood-v0_4/ci-playbook.sh           # full run
bash scripts/dogfood-v0_4/ci-playbook.sh --filter '^W6'   # one workflow
bash scripts/dogfood-v0_4/ci-playbook.sh --list    # case names only
bash scripts/dogfood-v0_4/ci-playbook.sh --leave-state    # keep scratch
bash scripts/dogfood-v0_4/ci-playbook.sh --fail-fast      # exit on first fail
```

In CI: see [.github/workflows/ci-playbook.yml](../../.github/workflows/ci-playbook.yml).
On failure, the workflow uploads `/tmp/cip-scratch` as an artifact.

Self-gates (verify the playbook itself works):

```bash
bash scripts/dogfood-v0_4/cip-self-test.sh
```

## Local end-to-end (real Claude Code, no API key)

`local-observe.sh` is a separate runner that drives **real** Claude
Code headless sessions (`claude -p`) instead of synthesizing hook
payloads. Same assertion library, same fixtures — different harness.
Use it locally to catch emergent properties (real session_id format,
real `source=startup`/`resume` semantics, real `transcript_path`
bytes, model + permission_mode passthrough) that synthesis can't
exercise.

```bash
bash scripts/dogfood-v0_4/local-observe.sh --smoke   # plumbing only (1 case)
bash scripts/dogfood-v0_4/local-observe.sh           # full local pass
bash scripts/dogfood-v0_4/local-observe.sh --filter '^L1\.2'   # one case
```

Auth: uses your locally-logged-in `claude` CLI (claude.ai
subscription). **No Anthropic API key required.** Per-case cost is
~tens of subscription tokens; each invocation pins
`--model claude-haiku-4-5-20251001` and `--tools ""` to keep it
minimal. Override via env: `LOCAL_MODEL=...` `LOCAL_PERM_MODE=...`.

CI safety: if `claude` is not on PATH, the runner exits 0 with a
skip notice — safe to call from `.github/workflows/` even though
GHA runners don't have `claude` available.

local-observe.sh and ci-playbook.sh are **complementary**, not
alternatives:

| | ci-playbook.sh | local-observe.sh |
|---|---|---|
| Drives | synthesized hook payloads | real `claude -p` sessions |
| Auth | none | claude.ai subscription |
| Cost | free | subscription tokens |
| Speed | fast (seconds) | slow (one network round-trip per case) |
| Determinism | full | partial (Claude's output varies) |
| Runs in CI | yes (gating) | no (skipped on missing `claude`) |
| Catches | contract regressions | emergent integration drift |

## Runtime dependencies

Required on the host running `ci-playbook.sh`:

| Tool | Purpose | How to install |
|---|---|---|
| `bash` 4+ | runner shell | system |
| `git` | fixture setup, code-pin probes | system |
| `node` 24+ | `harness` and `harness-hook` shims | nvm / system |
| `jq` | hook payload synthesis, JSON assertions | `apt-get install jq` / `brew install jq` |
| `python3` | spec-gate scripts (W11) | system |
| `apm` | APM-driven reproduce + capture (W6, W9) | `curl -sSL https://aka.ms/apm-unix \| sh` |

## How to interpret TAP

Output is [TAP version 14](https://testanything.org/tap-version-14-specification.html).
Standard parsers (GitHub Actions, GitLab CI, custom) handle it. The
shape is:

```
TAP version 14
1..71
# Workflow W1
ok 1 - W1.1 init in empty git dir
ok 2 - W1.2 init on existing .harness exits 1 with reindex hint
[...]
not ok 47 - W6.5 subtractive cleanup on ancestor: pathsRemoved + lockfile gone
  ---
  failures:
    - "report mentions removal"
  diagnostics:
    - "needle:   Removed "
    - "haystack: <full reproduce stdout>"
  ---
[...]

# All 71 cases passed
```

YAML diagnostic blocks list each failed assertion (`failures:`) and
the context that lets you reproduce the case (`diagnostics:`).

## How to add a new case

1. Pick the right workflow file under [`cases/`](cases/). If the
   case doesn't fit any existing workflow, add a new
   `cases/wN_<name>.sh` file (the runner globs `w[0-9]_*.sh` and
   `w[1-9][0-9]_*.sh`).

2. Write the case as a function that calls assertion helpers:

   ```bash
   wN_M_short_name() {
     fixture_baseline_no_apm     # or whichever fixture fits
     # ... action under test ...
     assert_equal "<expected>" "<actual>" "human-readable label"
   }
   register_case "WN.M short label" wN_M_short_name
   ```

3. Available helpers:
   - **fixtures** ([`lib-fixtures.sh`](lib-fixtures.sh)) —
     `fixture_empty_project`, `fixture_empty_git_project`,
     `fixture_baseline_no_apm`, `fixture_baseline_with_apm`,
     `fixture_lineage_3_snapshots`, `fixture_branched`,
     `fixture_tagged`, `fixture_corrupted_blob`,
     `fixture_corrupted_head`. Each sets `$FIXTURE_DIR`.
   - **hook fires** ([`lib-hook-fire.sh`](lib-hook-fire.sh)) —
     `fire_session_start <cwd> <sid> [source]`,
     `fire_user_prompt <cwd> <sid>`, `fire_malformed_stdin`,
     `fire_no_stdin`.
   - **state queries** ([`lib-blob.sh`](lib-blob.sh)) —
     `head_snapshot_id`, `read_head_blob`, `read_head_pointer`,
     `count_snapshot_blobs`, `trajectory_count`,
     `trajectory_kinds`, `trajectory_sources`,
     `trajectory_snapshot_ids_short`.
   - **assertions** ([`lib-assert.sh`](lib-assert.sh)) — see the
     file's header comment for the full menu.

4. **Do NOT enable `set -e` inside a case body.** The runner disables
   it via `run_case`'s `set +e` wrapper so assertions can return
   non-zero without killing the runner. If you set `set -e` in your
   case, the next failing assertion will short-circuit the run.

5. **Helpers that mutate `FIXTURE_DIR` cannot be called via command
   substitution.** `local x=$(my_helper)` runs `my_helper` in a
   subshell — `FIXTURE_DIR` set there does not propagate. Call the
   helper in the caller's scope, then read what you need separately.

6. Run `bash scripts/dogfood-v0_4/cip-self-test.sh` to verify the
   plan number adapts and the new case integrates cleanly.

## How to debug a failing case

1. **Read the YAML diagnostic block.** It names the failed
   assertion and shows the expected vs actual values.

2. **Run with `--leave-state`.** Then `cd $CIP_SCRATCH/<fixture>` and
   poke at `.harness/`, `.claude/`, `apm.lock.yaml` directly.

3. **Run a single case in isolation.** `--filter '^WN\.M$'` runs
   only that case. Combine with `--leave-state` for forensic
   inspection.

4. **Add `printf` debug lines.** Cases run with `set -e` disabled —
   add `printf 'debug: %s\n' "$some_var" >&2` anywhere in the case
   to surface state during the run.

## Manual regression test (CIP2)

[`cip-self-test.sh`](cip-self-test.sh) covers CIP1, CIP3, CIP4,
CIP5, CIP6 inline. CIP2 (regression detection) needs `git revert`
cycles and is run manually before merging changes that touch a
load-bearing v0.4.1 commit.

The pattern, using a worktree to isolate the revert from your
working state:

```bash
git worktree add /tmp/cip2 HEAD
cd /tmp/cip2

# Revert a load-bearing commit and rebuild.
git revert --no-commit <commit-sha>
pnpm install --frozen-lockfile
pnpm -r build

# Run the relevant case with the WORKTREE's binaries (not the host
# PATH's, which still point at the un-reverted main repo).
HARNESS="$PWD/packages/cli/bin/harness" \
HARNESS_HOOK="$PWD/packages/hook/bin/harness-hook" \
  bash scripts/dogfood-v0_4/ci-playbook.sh --filter '^WN\.M'

# Confirm the case fails with the expected diagnostic, then clean up.
git reset --hard HEAD
cd ~/DEV/claude-snaps     # or wherever your main worktree is
git worktree remove --force /tmp/cip2
```

The three load-bearing v0.4.1 commits and the cases they're expected
to break:

| Reverting this commit | Should fail this case |
|---|---|
| `c9f0b3c` (subtractive contract) | `W6.5` |
| `038a690` (local-path APM enrichment) | `W9.1` |
| `878394f` (checkout divergence warning) | `W5.10` |

If a revert does NOT surface the expected failure, the playbook has
a coverage gap. Add a stricter assertion or a new case. Don't loosen
the case to match the revert.

## File map

```
scripts/dogfood-v0_4/
├── README.md               ← this file (CI-runnable; the verification channel)
├── PLAYBOOK.md             ← deprecated; kept as tutorial / onboarding doc
├── ci-playbook.sh          ← synthesized runner (deterministic, free; runs in CI)
├── local-observe.sh        ← real-Claude-Code runner (subscription; local-only)
├── cip-self-test.sh        ← self-gates (CIP1, CIP3-CIP6)
├── lib.sh                  ← shared env (HARNESS, HARNESS_HOOK, V04_DIR)
├── lib-tap.sh              ← TAP 14 emit + case registry + run_case
├── lib-assert.sh           ← assertion harness (18 helpers)
├── lib-hook-fire.sh        ← spec/hooks.md §1.1 stdin payload synthesis
├── lib-fixtures.sh         ← named fixtures, idempotent
├── lib-blob.sh             ← .harness/ state readers
├── reset.sh                ← live-walkthrough setup (PLAYBOOK.md only)
├── setup-apm-fixture.sh    ← live-walkthrough APM fixture (PLAYBOOK.md only)
├── audit.sh                ← live-walkthrough audit script (PLAYBOOK.md only)
├── cases/                  ← synthesized cases (W1–W12) for ci-playbook.sh
│   ├── w1_cold_start.sh        (5 cases)
│   ├── w2_hook_firing.sh      (10 cases — incl. W2.8/9/10 drift detectors)
│   ├── w3_snap.sh              (5 cases)
│   ├── w4_queries.sh          (10 cases)
│   ├── w5_refs.sh             (10 cases)
│   ├── w6_reproduce.sh        (12 cases)  ← load-bearing
│   ├── w7_recovery.sh          (6 cases)
│   ├── w8_install_hook.sh      (5 cases)
│   ├── w9_apm.sh               (4 cases)
│   ├── w10_dag.sh              (3 cases)
│   ├── w11_format_compat.sh    (4 cases)
│   └── w12_session_metrics.sh (12 cases — v0.5.0 ingestion + privacy)
└── local_cases/            ← real-Claude cases (L0–Ln) for local-observe.sh
    ├── l0_smoke.sh             (1 case — plumbing check)
    ├── l1_basic.sh             (4 cases — startup/resume/model/dedup)
    ├── l2_v0_5_pre_flight.sh   (3 cases — v0.5 host-contract drift detectors)
    └── l2_session_metrics.sh   (3 cases — v0.5 ingestion correctness + privacy)
```

CI playbook: **86 cases** across 12 workflows.
Local observe: **10 cases** (1 smoke + 4 L1 + 3 L2 pre-flight + 3 L2 session-metrics).

### W12 (v0.5.0 — session metrics + transcript ingestion)

W12.1 – W12.12 verify the v0.5.0 `harness ingest-session` /
`harness session-cost` CLI surface against synthesized JSONL fixtures.
Mirrors unit coverage in `packages/core/test/ingest.test.ts` +
`packages/core/test/privacy_fuzz.test.ts`; the shell layer regresses
the full binary path including SQLite migration 007.

| Gate | What |
|---|---|
| W12.1 | 5-turn fixture: rows + shape (per-row spot checks on tokens/users/asst counts) |
| W12.2 | idempotent: re-ingest unchanged file adds zero rows |
| W12.3 | append 2 turns; re-ingest adds exactly 2 |
| W12.4 | mcp__server__tool names kept verbatim end-to-end |
| W12.5 | **privacy fuzz — ZERO canary leakage** (load-bearing per spec/format.md §10.2) |
| W12.6 | isSidechain=true persists as is_sidechain=1 |
| W12.7 | pre-v0.5 snapshot immutable under ingestion |
| W12.8 | v0.5+ snapshot immutable across mid-session version drift |
| W12.9 | session-cost reports correct per-session totals |
| W12.10 | session-cost --by-tool: call counts + §10.3 limitation surfaced |
| W12.11 | ingest-session --all skips sessions with no transcript on disk |
| W12.12 | v0.5 reader tolerates v0.4.x blob without claudeCodeVersion |

### L2 (real claude -p — v0.5 contract verification)

L2.1, L2.2, L2.3 (`l2_v0_5_pre_flight.sh`) are **drift detectors**:
they turn red when Claude Code changes its hook event inventory,
project-dir encoding rule, or `attributionSkill` semantics. Locked
prospectively against Claude Code 2.1.131 on 2026-05-08; see
docs/session-metrics-prompt.md "Verified pins".

L2.4, L2.5, L2.6 (`l2_session_metrics.sh`) are **ingestion gates**:
they drive a real `claude -p`, run `harness ingest-session` against
the resulting JSONL, and verify token-count + privacy correctness.

| Gate | What |
|---|---|
| L2.1 | hook event inventory = [SessionStart, UserPromptSubmit, Stop, SessionEnd] |
| L2.2 | project-dir encoding = non-alnum-to-single-dash, no collapsing |
| L2.3 | attributionSkill is null on assistant turns when no skill active |
| L2.4 | ingest real session: row count = JSONL message-line count |
| L2.5 | ingest real session: token totals match JSONL usage blocks |
| L2.6 | **real-session prompt canary does NOT leak into harness storage** |
