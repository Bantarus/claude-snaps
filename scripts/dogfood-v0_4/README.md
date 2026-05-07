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
├── ci-playbook.sh          ← runner: source cases/, count, plan, run, summarize
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
└── cases/
    ├── w1_cold_start.sh        (5 cases)
    ├── w2_hook_firing.sh       (7 cases)
    ├── w3_snap.sh              (5 cases)
    ├── w4_queries.sh          (10 cases)
    ├── w5_refs.sh             (10 cases)
    ├── w6_reproduce.sh        (12 cases)  ← load-bearing
    ├── w7_recovery.sh          (6 cases)
    ├── w8_install_hook.sh      (5 cases)
    ├── w9_apm.sh               (4 cases)
    ├── w10_dag.sh              (3 cases)
    └── w11_format_compat.sh    (4 cases)
```

Total: **71 cases** across 11 workflows.
