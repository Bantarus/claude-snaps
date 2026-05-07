# Implementation prompt: CI-runnable playbook (v0.4.x)

> Hand this to a fresh Claude Code session against this monorepo. The
> session has no prior context; everything load-bearing is captured
> here or referenced inline.

## Goal

Build a CI-runnable test script that **replaces** real-world
observation as the verification channel for harness's user-visible
contract. Real-world observation is not an acceptable CI process: it
requires human evaluation, takes weeks to surface enough cases, and
is non-deterministic.

We know the workflows. We know the branches. The CI playbook
enumerates every meaningful (state, action) → (expected outcome)
triple and asserts on durable artifacts. When CI is green, the
contract holds — period. When CI fails, the failing assertion names
the regression precisely.

This is v0.4.x backlog work. CLI behavior, format spec, and reproducer
contract do NOT change. The script is observation infrastructure,
not subject under test.

The existing [`scripts/dogfood-v0_4/PLAYBOOK.md`](../scripts/dogfood-v0_4/PLAYBOOK.md)
is the design-conversation artifact that produced the v0.4.0 + v0.4.1
contract. After this CI playbook lands, PLAYBOOK.md is **deprecated as
a verification channel** — kept as a tutorial / onboarding doc only.
All future regression catches happen in CI.

## Hard pins (do NOT relitigate)

1. **CI replaces observation, not supplements it.** We do not gate
   v0.5 plugin work on weeks of v0.4.1 real-world use. We gate it on
   green CI. Real-world observation is reserved for emergent
   properties we cannot enumerate (UX legibility, surprising user
   misreadings) — NOT for behavioral contracts we can specify.
2. **Bash + a tiny assertion harness.** No new test framework
   dependency (no Bats, no Pytest, no Vitest extension). Runs on any
   Linux/macOS shell with bash 4+, git, node, jq, python3, and apm.
3. **Single entry point.** `bash scripts/dogfood-v0_4/ci-playbook.sh`
   runs every case in order. Optional flags listed in §"Output
   format".
4. **No Claude Code dependency.** All Claude session steps are
   replaced by synthesized `harness-hook` invocations with stdin JSON
   payloads matching the spec/hooks.md §1.1 shape (see §"Synthesizing
   hook fires" for the exact bytes).
5. **Workflow-driven, not feature-driven.** Cases are organized by
   user journey (cold-start → APM-onboarding → reproduce-arc), not by
   CLI command. Each workflow enumerates every branch the user could
   traverse.
6. **Exhaustive within scope.** Every (current state, action) pair
   that has divergent behavior gets a case. Unit-level branches
   (covered by vitest in `packages/*/test/`) are out of scope; we
   test what a user can do via the CLI / hook surface.
7. **Idempotent.** The playbook can be re-run from any state: it
   sets up its own environment per case (or per workflow), runs
   every case, exits cleanly.
8. **TAP 14 output.** Each case emits one TAP line. CI integrations
   (GitHub Actions, GitLab) parse this without custom regex.
9. **Fail-fast OFF by default.** Run all cases; report all failures.
   Exit non-zero if ANY case fails. Flag `--fail-fast` flips behavior
   for local dev iteration.
10. **No CLI changes.** This is observation infrastructure; the
    subject under test (harness CLI) is treated as a black box.
    Surface CLI gaps as separate v0.4.x backlog items if you find
    any.

## The success criterion

After this work lands, the following must work end-to-end:

```bash
$ bash scripts/dogfood-v0_4/ci-playbook.sh
TAP version 14
1..58
# Workflow W1: cold start → first capture
ok 1 - W1.1 init in empty dir
ok 2 - W1.2 init idempotent on existing .harness/
ok 3 - W1.3 init in non-git dir (codePin null)
ok 4 - W1.4 init in git dir (codePin populated)
ok 5 - W1.5 init with --branch flag
# Workflow W2: hook firing surface
ok 6 - W2.1 SessionStart source=startup
ok 7 - W2.2 SessionStart source=resume (replays prior session_id)
ok 8 - W2.3 SessionStart source=clear (mints new session_id pattern)
ok 9 - W2.4 SessionStart source=compact
ok 10 - W2.5 UserPromptSubmit
ok 11 - W2.6 hook idempotent on (session_id, observed_at, event_kind)
ok 12 - W2.7 hook no-op when no .harness/ in cwd ancestry
[...]
ok 58 - W11.4 spec test vector matches canonical-501.bin

# All 58 cases passed
$ echo $?
0
```

A failing run prints `not ok N` lines with YAML diagnostic blocks.
The TAP plan number (`1..58`) MUST match the count of cases run; a
mismatch indicates a registration bug in the playbook itself.

## File layout

```
scripts/dogfood-v0_4/
├── PLAYBOOK.md                   ← DEPRECATED post-this-prompt; kept as tutorial
├── lib.sh                        ← existing (V04_DIR, helpers)
├── reset.sh                      ← existing
├── setup-apm-fixture.sh          ← existing
├── audit.sh                      ← existing
├── lib-assert.sh                 ← NEW: assertion harness
├── lib-hook-fire.sh              ← NEW: synthesized hook payloads
├── lib-tap.sh                    ← NEW: TAP output formatter
├── lib-fixtures.sh               ← NEW: per-workflow setup helpers
├── ci-playbook.sh                ← NEW: the runner
└── cases/                        ← NEW: cases organized by workflow
    ├── w1_cold_start.sh
    ├── w2_hook_firing.sh
    ├── w3_snap.sh
    ├── w4_queries.sh
    ├── w5_refs.sh
    ├── w6_reproduce.sh
    ├── w7_recovery.sh
    ├── w8_install_hook.sh
    ├── w9_apm.sh
    ├── w10_dag.sh
    └── w11_format_compat.sh
```

Splitting cases into per-workflow files keeps each file under ~300
lines. `ci-playbook.sh` sources each in order; the file enforces the
case numbering convention (W<n>.<m>).

## Library shape

### `lib-assert.sh`

Plain bash assertion helpers. Each: returns 0 on pass, 1 on fail. On
fail, populates `CASE_FAILURES` and `CASE_DIAGNOSTICS` arrays consumed
by `lib-tap.sh`.

```bash
# Equality / matching
assert_equal           expected actual [label]
assert_not_equal       a b [label]
assert_contains        haystack needle [label]
assert_not_contains    haystack needle [label]
assert_matches         haystack regex [label]
assert_count           expected actual [label]

# Filesystem
assert_file_exists     path
assert_file_not_exists path
assert_dir_exists      path
assert_dir_not_exists  path
assert_file_contains   path content [label]
assert_file_hash       path expected_sha256
assert_symlink         path

# Process / output
assert_exit            expected_code actual_code [label]
assert_stdout_matches  command_output regex [label]
assert_stderr_contains command_stderr substring [label]

# JSON / structured
assert_json_path       json_str jq_path expected
assert_json_count      json_str jq_path expected_count
```

Implementation pattern (one example):

```bash
assert_equal() {
  local expected=$1 actual=$2 label=${3:-}
  if [ "$expected" = "$actual" ]; then return 0; fi
  _assert_fail "${label:-assert_equal}" \
    "expected: $(printf '%q' "$expected")" \
    "actual:   $(printf '%q' "$actual")"
  return 1
}

_assert_fail() {
  local message=$1; shift
  CASE_FAILURES+=("$message")
  CASE_DIAGNOSTICS+=("$@")
}
```

### `lib-hook-fire.sh`

Synthesizes hook stdin payloads matching spec/hooks.md §1.1 (the same
shape `packages/hook/test/hook.test.ts:252` already verifies):

```bash
fire_session_start() {
  local cwd=$1 session_id=$2 source=${3:-startup}
  jq -nc \
    --arg sid "$session_id" \
    --arg cwd "$cwd" \
    --arg src "$source" \
    '{session_id: $sid, cwd: $cwd, hook_event_name: "SessionStart",
      transcript_path: "/dev/null", source: $src}' \
    | "$HARNESS_HOOK"
}

fire_user_prompt() {
  local cwd=$1 session_id=$2
  jq -nc \
    --arg sid "$session_id" \
    --arg cwd "$cwd" \
    '{session_id: $sid, cwd: $cwd, hook_event_name: "UserPromptSubmit",
      transcript_path: "/dev/null"}' \
    | "$HARNESS_HOOK"
}

# For corruption / tolerance cases:
fire_malformed() { local cwd=$1; printf 'not json' | "$HARNESS_HOOK"; }
fire_no_stdin()  { local cwd=$1; "$HARNESS_HOOK" </dev/null; }
fire_with_flag() { local sid=$1; "$HARNESS_HOOK" --session-id="$sid" </dev/null; }
```

The hook MUST exit 0 in every case (must not block the user). Side
effects are verified post-fire by reading `.harness/` artifacts.

### `lib-tap.sh`

TAP version 14. `tap_ok` / `tap_not_ok` / `tap_summary` helpers (same
as the prior draft). A case wraps in `run_case "<W#.#>: <description>"
<function>` which calls the function, captures pass/fail, emits TAP.

### `lib-fixtures.sh`

Per-workflow setup helpers. Each workflow may need a different
starting state; this library composes the existing `reset.sh` /
`setup-apm-fixture.sh` into named fixtures:

```bash
fixture_empty_project()         # tmpdir, no .harness/, no .claude/, no apm
fixture_baseline_no_apm()       # reset.sh state
fixture_baseline_with_apm()     # reset.sh + apm.yml + apm install
fixture_lineage_3_snapshots()   # baseline + 2 hook-fired auto snapshots
fixture_branched()              # baseline + main + experimental branches
fixture_tagged()                # baseline + v0.1 tag
fixture_corrupted_blob()        # baseline + truncate one snapshot's JSON
fixture_corrupted_head()        # baseline + write garbage to HEAD
```

Cases call the fixture they need at start. Fixtures are idempotent
(wipe + rebuild every call) so cases don't pollute each other.

## Case inventory: 58 cases across 11 workflows

Cases are listed in **workflow → branch** matrix form. Each row
becomes one CI case. The new session implements each by following
the established pattern (fixture setup → action → assertions).

### W1: Cold start → first capture (5 cases)

| # | Setup | Action | Expected |
|---|---|---|---|
| W1.1 | empty tmpdir | `harness init` | `.harness/HEAD`, `config`, `snapshots/` exist; HEAD = `ref: refs/heads/main` |
| W1.2 | existing `.harness/` | `harness init` again | idempotent; no error; HEAD unchanged |
| W1.3 | non-git tmpdir | hook fire after init | snapshot's `codePin` is null |
| W1.4 | git tmpdir | hook fire after init | snapshot's `codePin` = current git HEAD sha |
| W1.5 | empty tmpdir | `harness init --branch=dev` | HEAD = `ref: refs/heads/dev` |

### W2: Hook firing surface (7 cases)

| # | Setup | Action | Expected |
|---|---|---|---|
| W2.1 | baseline_no_apm | `fire_session_start cwd s1 startup` | 1 snapshot, 1 attribution row, source=startup |
| W2.2 | post-W2.1 | `fire_session_start cwd s1 resume` | same snapshot id (composition unchanged); 2 attribution rows for s1; source=resume on second |
| W2.3 | post-W2.1 | `fire_session_start cwd s1 clear` | source=clear on the new attribution row |
| W2.4 | post-W2.1 | `fire_session_start cwd s1 compact` | source=compact accepted (forward-compat unknown source values per §2.7) |
| W2.5 | post-W2.1 | `fire_user_prompt cwd s1` | event_kind=user_prompt attribution appended |
| W2.6 | post-W2.5 | re-fire same event | idempotent on `(session_id, observed_at, event_kind)` PK; row count unchanged |
| W2.7 | empty tmpdir (no `.harness/`) | hook fire | exit 0; no side effects (no `.harness/` created) |

### W3: Snap (CLI capture) (5 cases)

| # | Setup | Action | Expected |
|---|---|---|---|
| W3.1 | baseline_no_apm; mutate skill | `harness snap "added skill"` | new auto snapshot; note attribution attached; sessionId = `<manual>` |
| W3.2 | baseline_no_apm | `harness snap "no change note"` | NO new snapshot (composition unchanged); 1 note attribution attached to existing head |
| W3.3 | baseline_no_apm | `harness snap ""` | exit 1; clear "note required" message |
| W3.4 | baseline_no_apm; checkout id (detached) | `harness snap "x"` | exit 1; "detached HEAD refused" message |
| W3.5 | baseline_no_apm | `harness snap "📝 unicode"` | snapshot writes; note attribution carries the unicode bytes intact |

### W4: Read-only queries (10 cases)

| # | Setup | Action | Expected |
|---|---|---|---|
| W4.1 | empty tmpdir + init | `harness log` | exit 1; "no commits yet" message |
| W4.2 | lineage_3_snapshots | `harness log` | 3 rows, newest first; HEAD annotation on the matching row |
| W4.3 | lineage_3_snapshots | `harness log --limit=1` | 1 row |
| W4.4 | branched | `harness log --branch=experimental` | rows on experimental only |
| W4.5 | lineage_3_snapshots | `harness log --with-sessions` | each row ends with `[N session(s)]` |
| W4.6 | lineage_3_snapshots | `harness diff <a> <b>` | non-empty op list; matches snapshot module diff |
| W4.7 | lineage_3_snapshots | `harness diff <id> <id>` | exit 0; empty diff |
| W4.8 | tagged | `harness diff v0.1 HEAD` | diff resolves both refs |
| W4.9 | lineage_3_snapshots | `harness sessions` | lists every session_id observed |
| W4.10 | lineage_3_snapshots | `harness sessions <unknown>` | empty trajectory; exit 0 |

### W5: Refs (tag, branch, checkout) (10 cases)

| # | Setup | Action | Expected |
|---|---|---|---|
| W5.1 | baseline_no_apm | `harness tag v0.1` | `refs/tags/v0.1` written; resolves to HEAD id |
| W5.2 | tagged (v0.1 exists) | `harness tag v0.1` | exit 1; "already exists" message |
| W5.3 | tagged | `harness tag v0.1 --force` | overwrites; exit 0 |
| W5.4 | baseline_no_apm | `harness branch experimental` | `refs/heads/experimental` exists; HEAD unchanged |
| W5.5 | branched | `harness branch experimental` | exit 1 (without --force) |
| W5.6 | branched | `harness checkout experimental` | HEAD = `ref: refs/heads/experimental` (symbolic) |
| W5.7 | branched | `harness checkout <full-id>` | HEAD = 40-hex (detached) |
| W5.8 | branched | `harness checkout <6-char-prefix>` | resolves to full id; HEAD detached at it |
| W5.9 | tagged | `harness checkout nonexistent` | exit 1; "unknown ref" |
| W5.10 | branched + mutate | `harness checkout main` | `Working tree DIVERGED` warning fires |

### W6: Reproduce (the load-bearing one) (12 cases)

| # | Setup | Action | Expected |
|---|---|---|---|
| W6.1 | baseline_no_apm; mutate notes/SKILL.md | `harness reproduce HEAD` | apmPhase=skipped; HEAD advances detached; **file NOT restored** (local-source untouched per §6.1); `pathsRemoved=[]` |
| W6.2 | baseline_with_apm | `harness reproduce HEAD` (no mutation) | apmPhase=success; verified count > 0; idempotent (1 backup created) |
| W6.3 | baseline_with_apm; corrupt apm-managed file | `harness reproduce HEAD` | apmPhase=success; file restored to upstream content; `verified == expected` |
| W6.4 | baseline_with_apm; hand-edit apm-managed file; capture | `harness reproduce HEAD` | apmPhase=failed; configHash mismatch; **HEAD NOT advanced**; backup retained |
| W6.5 | lineage with APM added partway | `harness reproduce <init-id>` | apmPhase=skipped; **`pathsRemoved` includes apm-managed path**; **`apm.lock.yaml` removed**; backup at `apm.lock.yaml.harness-backup` |
| W6.6 | post-W6.5 | `harness reproduce <apm-id>` (forward) | apmPhase=success; `pathsRemoved=[]`; `apm.lock.yaml` restored; APM files materialized |
| W6.7 | baseline_with_apm | `harness reproduce HEAD --dry-run` | exit 0; output prefixed `Would ...`; ends `(No changes made.)`; HEAD unchanged; `.claude/` byte-identical pre/post; no new backup directory |
| W6.8 | baseline_with_apm; checkout id (detached) | `harness reproduce HEAD` | works on detached HEAD; HEAD remains detached at the new id |
| W6.9 | baseline_with_apm; tagged v0.4-apm | `harness reproduce v0.4-apm` | tag resolves; same outcome as id-based reproduce |
| W6.10 | baseline_with_apm | `PATH=/nonexistent harness reproduce HEAD` | exit 1; "apm not found on PATH"; **NO backup created** (abort BEFORE backup) |
| W6.11 | baseline_with_apm | `harness reproduce <nonexistent>` | exit 1; "unknown ref"; no backup created |
| W6.12 | baseline_with_apm; mutate apm + add hand-written local skill | `harness reproduce HEAD` | apm file restored; **hand-written skill UNTOUCHED**; pathsRemoved excludes the local skill |

### W7: Recovery from corruption (6 cases)

| # | Setup | Action | Expected |
|---|---|---|---|
| W7.1 | lineage_3_snapshots | `harness reindex` | exit 0; report shows added/updated/removed counts |
| W7.2 | lineage_3_snapshots | reindex twice | second run reports zero changes (idempotent) |
| W7.3 | lineage_3_snapshots; truncate one blob to `{}` | `harness reindex` | surfaces integrity error on that blob; other blobs unaffected |
| W7.4 | lineage_3_snapshots; manually rm one blob | `harness reindex` | reports the blob as removed from index; `harness log` excludes it |
| W7.5 | corrupted_head | `harness log` | exit 1; clear error referencing HEAD; not a generic crash |
| W7.6 | baseline_no_apm; write `refs/heads/main` containing nonexistent id | `harness log` or `checkout main` | exit 1; clear error pointing at the dangling ref |

### W8: install-hook (5 cases)

| # | Setup | Action | Expected |
|---|---|---|---|
| W8.1 | git project, no `.claude/` | `harness install-hook` | creates `.claude/settings.json` with both SessionStart + UserPromptSubmit entries |
| W8.2 | git project, existing `.claude/settings.json` with model field | `echo y \| harness install-hook` | settings.json keeps model field, gains hook config |
| W8.3 | git project, existing settings.json with conflicting hook | `echo y \| harness install-hook` (no `--force`) | exit 0 with clear merge note; OR exit 1 with conflict — assert whichever the spec defines |
| W8.4 | non-git project | `harness install-hook` | exit 0; works without git |
| W8.5 | git project with dirty `.claude/settings.json` | `harness install-hook` | exit 1; "untracked / unstaged changes; use --force" message |

### W9: APM integration (4 cases)

| # | Setup | Action | Expected |
|---|---|---|---|
| W9.1 | baseline_with_apm (local-path dep) | hook fire | snapshot has `apm-test` as `source.kind=apm`; `package` starts with `_local/` (v0.4.1 enrichment) |
| W9.2 | baseline + write empty `apm.lock.yaml` (`packages: []`) | hook fire | snapshot has `apmLockHash` non-null; modules have no apm-source entries |
| W9.3 | baseline + write malformed YAML in apm.lock.yaml | hook fire | hook exits 0; snapshot captures `apmLockHash` of the bytes; modules unaffected (no apm enrichment) |
| W9.4 | baseline_with_apm + apm.lock.yaml lists directory in deployed_files | hook fire | child file under that directory is enriched as apm-source (v0.4.1 directory-prefix matcher) |

### W10: DAG / cross-session (3 cases)

| # | Setup | Action | Expected |
|---|---|---|---|
| W10.1 | baseline_no_apm | `fire_session_start` from 3 different session_ids, same composition | 1 snapshot; 3 attribution rows; `[3 sessions]` annotation on log row |
| W10.2 | branched (main + experimental) + composition diverged | log on each branch | distinct rows per branch; experimental branch is descended off main's tip |
| W10.3 | synthetic merge node (parentIds.length=2) written via direct API | `harness log` + `harness diff` | tolerates the merge per §4.1; renders without crash |

### W11: Format compatibility + spec gates (4 cases)

| # | Setup | Action | Expected |
|---|---|---|---|
| W11.1 | place a v0.3 snapshot blob (formatVersion=0.3) into `.harness/snapshots/` | `harness log` | reads it; renders the v0.3 snapshot in the lineage |
| W11.2 | place a v0.2 snapshot blob (formatVersion=0.2) | `harness log` | exit 1 (or refuses that blob); major-version mismatch surfaces |
| W11.3 | run spec-gate scripts | `python3 scripts/check_schema_agreement.py && python3 scripts/check_format_version_bump.py` | both exit 0 (no spec drift) |
| W11.4 | spec test vector | `python3 scripts/build_examples.py` then verify `spec/test-vectors/canonical-501.bin` matches the recomputed bytes | byte-identical |

**Total: 58 cases.** This is the v0.4.1 contract enumerated. If you
identify a workflow branch I missed, ADD a case and bump the count;
don't shrink the inventory.

## Synthesizing hook fires (the trickiest part)

Real Claude Code SessionStart fires include the full transcript_path
and session metadata. We synthesize with `/dev/null` because the hook
doesn't read transcripts in v0.4 (verified: `packages/hook/src/main.ts`
does not touch `transcript_path` content). If a future v0.5 hook starts
reading transcripts, the playbook needs real bytes — surface to user.

The payload shape comes from `packages/hook/test/hook.test.ts:252`
verbatim:
```json
{
  "session_id": "<id>",
  "cwd": "<abs project dir>",
  "hook_event_name": "SessionStart",
  "transcript_path": "/dev/null",
  "source": "startup"
}
```

For UserPromptSubmit, omit the `source` field. Both go via stdin to
`harness-hook` (no positional args; no flags).

For idempotency tests (W2.6), preserve the same `session_id` AND
`observed_at`. Since the hook captures `observed_at = now()`, two
fires in different millisecond brackets get different observed_at
values — they're distinct rows. To force the SAME observed_at, you'd
need to mock `now()` (we don't). Instead, W2.6 tests
**dedup-by-composition**: two fires of the same composition produce
1 snapshot blob (not 2), even if attribution rows are distinct.

## Output format

### Default: TAP 14 with workflow group comments

```
TAP version 14
1..58
# Workflow W1: cold start
ok 1 - W1.1 init in empty dir
[...]
# Workflow W2: hook firing
ok 6 - W2.1 SessionStart source=startup
[...]
# All 58 cases passed
```

The `# Workflow ...` comments are TAP-legal (anything after `#` is
ignored by parsers) and improve human readability.

### Optional flags

- `--fail-fast` — exit on first `not ok`. For local iteration.
- `--filter '<regex>'` — run only cases whose name matches. Example:
  `--filter '^W6'` runs all reproduce cases.
- `--no-color` — strip ANSI from human-friendly summary.
- `--leave-state` — skip on-exit cleanup so the failing case's
  `$V04_DIR` state can be inspected.
- `--list` — print all case names without running them. For
  enumeration / completeness checks.

## CI integration

GitHub Actions workflow (`.github/workflows/ci-playbook.yml`):

```yaml
name: CI playbook
on:
  push:
    branches: [main]
  pull_request:
    paths:
      - 'packages/**'
      - 'spec/**'
      - 'scripts/dogfood-v0_4/**'

jobs:
  ci-playbook:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '24' }
      - uses: pnpm/action-setup@v3
        with: { version: 9 }
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r build
      - name: Install harness CLI globally
        run: pnpm link --global packages/cli packages/hook
      - name: Install APM
        run: curl -sSL https://aka.ms/apm-unix | sh
      - name: Run CI playbook
        run: bash scripts/dogfood-v0_4/ci-playbook.sh
      - name: Upload state on failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: v04-observe-state
          path: ~/harness-v0_4-observe/
```

The "Upload state on failure" step ensures forensic data is
available when CI fails — same spirit as the `--leave-state` flag.

## Test gates (for the playbook itself)

The playbook is also under test. These gates verify it works.

### Gate CIP1: Clean run on green commit

`git checkout main && bash scripts/dogfood-v0_4/ci-playbook.sh` →
exit 0; all 58 cases pass. This gates merging the playbook itself.

### Gate CIP2: Detects a real regression

For each load-bearing v0.4.1 commit (subtractive contract, local-path
APM enrichment, divergence warning), revert it on a branch and
confirm CI fails the relevant case(s). Specifically:

- Revert `c9f0b3c` (subtractive) → W6.5 fails ("pathsRemoved is empty
  when expected non-empty")
- Revert `038a690` (local-path enrichment) → W9.1 fails ("apm-test
  source.kind is local, expected apm")
- Revert `878394f` (divergence warning) → W5.10 fails ("DIVERGED
  string not in output")

Each must produce a clear diagnostic identifying the failing
assertion. If a regression doesn't surface in CI, ADD a case for it.

### Gate CIP3: Idempotent re-run

Run the playbook twice in succession (no manual cleanup). Both exit
0. The second run's fixtures clean up the first run's state.

### Gate CIP4: Selective filter

`bash ci-playbook.sh --filter '^W6'` runs only W6.* cases; other
cases neither run nor appear in TAP. The plan number adapts (e.g.
`1..12` for W6 alone).

### Gate CIP5: Failure cleanup

When `--leave-state` is OFF and a case fails, the playbook still
cleans up `$V04_DIR` (no leftover backup directories that would
interfere with the next run). When `--leave-state` is ON, state is
preserved.

### Gate CIP6: --list emits 58 entries

`bash ci-playbook.sh --list | wc -l` returns 58 (or whatever the
final count is). Mismatch indicates a registration bug.

## What's NOT in scope

- **Translating `scripts/dogfood/` (v0.3 playbook).** Predates v0.4.
  Out of scope.
- **Property-based / fuzz testing.** Belongs in `packages/core/test/`
  as vitest tests, not in the observation playbook.
- **CLI changes for testability.** If a case is hard to assert
  because the CLI doesn't expose enough info, file as v0.4.x
  backlog and write the case with the workaround (e.g., parse stdout
  rather than reading a structured field that doesn't exist yet).
- **Performance assertions.** Wall-clock time isn't asserted; CI
  environments vary.
- **Submission to a CI service.** The GitHub Actions stub is a
  starter; the user picks where to run it.

## Order of operations

Each step ends in a verifiable state. Pause and commit between
steps.

1. **Library scaffolding** (~half day). Author `lib-assert.sh`,
   `lib-hook-fire.sh`, `lib-tap.sh`, `lib-fixtures.sh`. Write 5+
   smoke tests for each library function (pass case, fail case).
   Run them inline; verify libraries work before any case uses
   them. Commit.

2. **Runner skeleton** (~2 hours). Author `ci-playbook.sh` with the
   case-runner loop, TAP output, flag parsing, on-exit cleanup. No
   real cases yet — register one trivial pass-case and one fail-
   case. Verify TAP shape matches §"The success criterion".
   Commit.

3. **W1 cold-start cases** (~3 hours). Author `cases/w1_cold_start.sh`
   with all 5 cases. Each ends with the runner reporting
   `ok N - W1.x ...`. Commit.

4. **W2 hook-firing cases** (~half day). Author `cases/w2_hook_firing.sh`
   with all 7 cases. W2.6 (idempotency) is the most subtle —
   verifies dedup-by-composition. Commit.

5. **W3 snap cases** (~3 hours). Includes the unicode case (W3.5).
   Commit.

6. **W4 query cases** (~half day). 10 cases; mostly mechanical.
   Commit.

7. **W5 refs cases** (~half day). 10 cases. W5.10 (divergence) is
   the cosmetic-batch verification. Commit.

8. **W6 reproduce cases** (~1 day; the most cases). 12 cases. W6.4
   (hand-edit mismatch) and W6.5 (subtractive ancestor) are the
   load-bearing ones; verify they produce the exact failure shape
   expected. Commit per cluster (W6.1-W6.6 first, W6.7-W6.12 second).

9. **W7 recovery cases** (~half day). 6 cases. W7.5/W7.6 require
   manual filesystem corruption. Commit.

10. **W8 install-hook cases** (~3 hours). 5 cases. W8.3 (conflicting
    hook) needs spec clarification — if behavior is undefined,
    surface to user.

11. **W9 APM cases** (~half day). 4 cases. W9.1 (local-path
    enrichment) is the v0.4.1 verification. Commit.

12. **W10 DAG cases** (~3 hours). 3 cases. W10.3 (merge node) needs
    direct-API construction since v0.4 writers don't produce merges.
    Commit.

13. **W11 format-compat cases** (~3 hours). 4 cases. W11.3 wraps
    the existing python gates. Commit.

14. **CI integration** (~half day). Author the GitHub Actions
    workflow. Run it on a PR branch; verify end-to-end on the
    runner. Tune install steps if APM has hiccups in the actions
    environment. Commit.

15. **Self-gates CIP1–CIP6** (~half day). Verify each gate. The
    regression-detection gate (CIP2) is the most important — if a
    revert doesn't surface, the playbook has a coverage gap; add a
    case. Commit.

16. **Documentation** (~half day). README in
    `scripts/dogfood-v0_4/` covering: how to run, how to interpret
    TAP, how to add a new case, how to debug. Mark `PLAYBOOK.md` as
    deprecated for verification (still useful as a tutorial).
    Cross-link both docs. Commit.

## Open questions to surface, NOT settle

1. **Synthesized hook faithfulness.** We use `/dev/null` for
   transcript_path. Verified: v0.4 hook doesn't read transcript
   bytes. If a future hook ever does, the playbook needs real
   bytes. Surface; default to `/dev/null` with a comment.

2. **W2.4 source=compact.** The v0.3 soak couldn't reproduce a real
   `compact` SessionStart from Claude Code (host-side rare). We
   synthesize one. Confirm the spec accepts unknown source values
   per §2.7's forward-compat rule, and that the attribution row
   carries `compact` verbatim. If the spec is ambiguous, surface and
   re-discuss.

3. **W7.3 — what does "integrity error" look like?** If the CLI
   crashes with a stack trace instead of a clean error, file as
   v0.4.x backlog and assert on whatever shape it produces today
   (locking in the current behavior; note that the case will need
   updating when the CLI improves the error).

4. **W8.3 — install-hook conflict resolution.** The spec doesn't
   specify behavior when an existing hook block conflicts with the
   harness-hook entry. Surface the actual behavior and assert on
   it; flag if the spec needs amending.

5. **W10.3 — merge node construction.** v0.4 writers don't produce
   merges; the test fixture needs direct API construction (e.g.,
   write a synthetic blob with `parentIds.length=2` to disk and
   reindex). Confirm the playbook has access to that construction
   path; if not, defer W10.3 with a TODO.

6. **`.github/workflows/` location.** If the repo doesn't have it
   yet, surface and ask before creating.

## Estimated effort

Per the order of operations: ~6 days of focused work. Faster than
v0.5 plugin work because cases are mechanical once the libraries
exist. The two long stretches (W6 reproduce, library scaffolding) are
the substance; the rest is pattern-matching.

## What success looks like

A CI run, on a fresh checkout, against any commit on main:

```
TAP version 14
1..58
[...58 ok lines...]
# All 58 cases passed
```

…and exits 0. A regression on any v0.4.1 contract pin produces a
specific `not ok` line with a diagnostic that names the failing
assertion. The PR check is green/red on this single boolean.

Once this lands:
- Real-world v0.4.1 observation is no longer the verification
  channel.
- v0.5 plugin work (`docs/plugin-implementation-prompt.md`) is
  unblocked the moment CI is green on v0.4.1.
- New v0.4.x or v0.5 contract changes get a deterministic gate that
  catches regressions automatically. Adding a new case is a 5-line
  addition to the right `cases/w*.sh` file.

The discipline pivots: instead of "observe in real workflows and
hope to surface bugs," we say "the contract is what CI asserts." If
a behavior isn't asserted, it isn't part of the contract.

---

When this prompt is complete, the v0.4.x verification infrastructure
is CI-driven. v0.5 plugin work begins immediately on green. The human
PLAYBOOK.md becomes a tutorial; the contract lives in the CI
playbook.
