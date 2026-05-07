# Implementation prompt: CI-runnable playbook (v0.4.x)

> Hand this to a fresh Claude Code session against this monorepo. The
> session has no prior context; everything load-bearing is captured
> here or referenced inline. Pairs with the existing
> [`scripts/dogfood-v0_4/PLAYBOOK.md`](../scripts/dogfood-v0_4/PLAYBOOK.md)
> which is the human-evaluation source.

## Goal

Convert the v0.4 observation playbook into a **CI-runnable** test
script that asserts deterministically on durable artifacts (file
existence, file content, exit codes, parsed CLI output) without any
human evaluation step. The current PLAYBOOK.md has two
human-evaluation paths that block CI use:

1. **Claude Code session steps** (cases B3, C2): "your turn — open
   `claude`, paste this prompt, `/exit`."
2. **Visual inspection of output** ("Expected: output looks like X" —
   verified by reading).

A CI playbook removes both. The new script:
- Synthesizes hook stdin payloads to fire `harness-hook` directly,
  bypassing Claude Code entirely.
- Replaces visual inspection with explicit assertions
  (`assert_equal`, `assert_file_exists`, `assert_contains`, etc.)
  that exit non-zero on any divergence.
- Runs end-to-end via a single command (`bash
  scripts/dogfood-v0_4/ci-playbook.sh`), suitable for any CI
  runner (GitHub Actions, GitLab, Jenkins, local pre-commit hook).

This is v0.4.x backlog work. CLI behavior, format spec, and reproducer
contract do NOT change. The new script extends the existing playbook
infrastructure (reset.sh, setup-apm-fixture.sh, audit.sh) — does NOT
replace it.

## Hard pins (do NOT relitigate)

1. **Bash + a tiny assertion harness.** No new test framework
   dependency (no Bats, no Pytest, no Vitest extension). The
   playbook must run on any Linux/macOS shell with bash 4+, git,
   node, jq, python3, and apm. The CI runner installs those; the
   playbook assumes them present.
2. **Single entry point.** `bash scripts/dogfood-v0_4/ci-playbook.sh`
   runs every case in order. No subcommands, no flags by default;
   optional flags listed in §"Output format" below.
3. **No Claude Code dependency.** All Claude session steps are
   replaced by synthesized `harness-hook` invocations with stdin
   JSON payloads matching the spec/hooks.md §1.1 shape (see
   §"Synthesizing hook fires" for the exact bytes).
4. **Same scenario inventory.** All 14 cases from the human PLAYBOOK
   (A1–A3, B1–B6, C1–C4, D1–D3, E1) are translated to CI cases. New
   edge cases are ADDED in §"New edge cases (CI-only)" but the
   existing cases are NOT removed.
5. **Idempotent.** The playbook can be re-run from any state: it
   sets up its own environment (calls `reset.sh` first), runs all
   cases, and on the way out either cleans up or leaves the soak
   repo + report file behind for forensic inspection.
6. **Fail-fast OFF by default.** Run all cases; report all failures.
   Exit non-zero if ANY case fails. CLI flag `--fail-fast` flips
   this behavior for shorter iteration during local dev.
7. **TAP output format.** Each case emits one TAP line. CI
   integrations (GitHub Actions, GitLab) can parse this without
   custom regex.
8. **No CLI changes.** This is observation infrastructure; the
   subject under test (harness CLI) is treated as a black box.
   Surface CLI gaps as separate v0.4.x backlog items if you find
   any.

## The success criterion

After this work lands, the following must work end-to-end:

```bash
$ bash scripts/dogfood-v0_4/ci-playbook.sh
TAP version 14
1..28
ok 1 - A1: reset baseline
ok 2 - A2: baseline blob shape
ok 3 - A3: reproduce no-APM (skipped path, locals reported)
ok 4 - B1: APM fixture setup
ok 5 - B2: apm install + lockfile shape
ok 6 - B3: synthesized SessionStart hook fires + apm-kind enrichment
ok 7 - B4: mutate APM file → reproduce → restored + verified
ok 8 - B5: tag-by-name reproduce
ok 9 - B6: dry-run zero side effects
ok 10 - C1: idempotent reproduce
ok 11 - C2: hand-edit + reproduce → configHash mismatch + HEAD not advanced
ok 12 - C3: reproduce on detached HEAD
ok 13 - C4: apm not on PATH aborts before backup
ok 14 - D1: divergence warning fires
ok 15 - D2: clean match — no warning
ok 16 - D3: subtractive ancestor reproduce + byte-identity recompute
ok 17 - E1: audit gate counts match
ok 18 - X1: concurrent hook fires (race-safe)
ok 19 - X2: blob corruption → reindex recovery
ok 20 - X3: deleted parent snapshot detection
ok 21 - X4: subtractive cleanup boundary (sibling dirs untouched)
ok 22 - X5: subtractive cleanup with symlinks (security: no escape)
ok 23 - X6: malformed apm.lock.yaml tolerance
ok 24 - X7: empty apm.lock.yaml (zero packages) round-trip
ok 25 - X8: HEAD file corruption recovery
ok 26 - X9: tag pointing at non-existent snapshot
ok 27 - X10: reproduce when working tree is partially mutated
ok 28 - X11: backup directory accumulation (>10 backups; no error)

# All 28 cases passed
$ echo $?
0
```

A failing run looks like:

```bash
$ bash scripts/dogfood-v0_4/ci-playbook.sh
TAP version 14
1..28
ok 1 - A1: reset baseline
not ok 2 - A2: baseline blob shape
  ---
  message: 'expected formatVersion=0.4, got 0.3'
  severity: fail
  data:
    snapshot_id: 4f1d8dba
    expected: '0.4'
    actual: '0.3'
  ...
ok 3 - A3: reproduce no-APM (skipped path, locals reported)
[...]
# 27 of 28 cases passed; 1 failed
$ echo $?
1
```

That output shape is the contract. CI integrations parse the TAP
lines; humans read the YAML diagnostic block on failures.

## File layout

```
scripts/dogfood-v0_4/
├── PLAYBOOK.md                  ← existing (human-evaluation source)
├── lib.sh                       ← existing (V04_DIR, helpers)
├── reset.sh                     ← existing
├── setup-apm-fixture.sh         ← existing
├── audit.sh                     ← existing
├── lib-assert.sh                ← NEW: assertion harness
├── lib-hook-fire.sh             ← NEW: synthesized hook payloads
├── lib-tap.sh                   ← NEW: TAP output formatter
└── ci-playbook.sh               ← NEW: the CI runner
```

`PLAYBOOK.md` stays as the human reference; the CI playbook IS its
deterministic counterpart. Each case in `ci-playbook.sh` cross-
references the matching PLAYBOOK case in a comment so the two stay
linked.

## Library shape

### `lib-assert.sh`

Plain bash assertion helpers. Each:
- Returns 0 on pass, 1 on fail
- On fail, writes a YAML diagnostic block to a global accumulator
  (consumed by `lib-tap.sh` when formatting the case output)

```bash
# Required helpers (minimum):
assert_equal           expected actual [label]
assert_not_equal       a b [label]
assert_contains        haystack needle [label]
assert_not_contains    haystack needle [label]
assert_matches         haystack regex [label]
assert_file_exists     path
assert_file_not_exists path
assert_dir_exists      path
assert_file_contains   path content [label]
assert_file_hash       path expected_sha256
assert_exit            expected_code actual_code [label]
assert_json_path       json_str jq_path expected
assert_count           expected actual [label]   # numeric equality
```

Implementation pattern (one example):

```bash
assert_equal() {
  local expected=$1 actual=$2 label=${3:-}
  if [ "$expected" = "$actual" ]; then
    return 0
  fi
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

Synthesizes hook stdin payloads matching spec/hooks.md §1.1 (the
shape `packages/hook/test/hook.test.ts` already verifies). Two
helpers:

```bash
fire_session_start() {
  local cwd=$1 session_id=$2 source=${3:-startup}
  jq -nc \
    --arg sid "$session_id" \
    --arg cwd "$cwd" \
    --arg src "$source" \
    '{session_id: $sid, cwd: $cwd, hook_event_name: "SessionStart", transcript_path: "/dev/null", source: $src}' \
    | "$HARNESS_HOOK"
}

fire_user_prompt() {
  local cwd=$1 session_id=$2
  jq -nc \
    --arg sid "$session_id" \
    --arg cwd "$cwd" \
    '{session_id: $sid, cwd: $cwd, hook_event_name: "UserPromptSubmit", transcript_path: "/dev/null"}' \
    | "$HARNESS_HOOK"
}
```

Both return the hook's exit code (always 0 per the v0.3 contract;
hooks must not block the user). The hook's side effects are
verified post-fire by reading `.harness/` artifacts.

### `lib-tap.sh`

TAP version 14 output. Each case calls `tap_ok` or `tap_not_ok`;
the runner collects state across cases:

```bash
TAP_TOTAL=0
TAP_PASSED=0
TAP_FAILED=0
TAP_FAILURES=()

tap_plan()      { local n=$1; printf 'TAP version 14\n1..%d\n' "$n"; }
tap_ok()        { local n=$1 desc=$2; printf 'ok %d - %s\n' "$n" "$desc"; TAP_PASSED=$((TAP_PASSED+1)); }
tap_not_ok()    { local n=$1 desc=$2; shift 2
                  printf 'not ok %d - %s\n' "$n" "$desc"
                  printf '  ---\n'
                  printf '  message: %s\n' "$1"
                  printf '  severity: fail\n'
                  if [ $# -gt 1 ]; then
                    printf '  data:\n'
                    shift
                    while [ $# -gt 0 ]; do printf '    %s\n' "$1"; shift; done
                  fi
                  printf '  ...\n'
                  TAP_FAILED=$((TAP_FAILED+1))
                  TAP_FAILURES+=("$desc"); }
tap_summary()   { printf '\n# %d of %d cases passed; %d failed\n' "$TAP_PASSED" "$TAP_TOTAL" "$TAP_FAILED"; }
```

## Case translation: PLAYBOOK → CI

Each existing PLAYBOOK case maps to a CI case function. The
translations below show the human-evaluation pattern → assertion
pattern. Bodies elided; the new session writes them.

### A1: Reset baseline

**Human:** runs `bash reset.sh`, observes "ready" output.

**CI:**
```bash
case_a1_reset() {
  bash "$SCRIPT_DIR/reset.sh" >/dev/null 2>&1 || return 1
  assert_dir_exists "$V04_DIR/.harness/snapshots" || return 1
  assert_file_exists "$V04_DIR/.harness/HEAD" || return 1
  assert_file_exists "$V04_DIR/.claude/skills/notes/SKILL.md" || return 1
  assert_file_exists "$V04_DIR/.claude/settings.json" || return 1
  # Exactly one snapshot post-reset.
  local count
  count=$(find "$V04_DIR/.harness/snapshots" -name "*.json" | wc -l)
  assert_equal 1 "$count" "snapshot count after reset" || return 1
}
```

### A2: Baseline blob shape

**Human:** reads JSON, eyeballs formatVersion, modules, source kinds.

**CI:** parses with jq, asserts each field:
```bash
case_a2_baseline_blob() {
  local blob
  blob=$(find "$V04_DIR/.harness/snapshots" -name "*.json" | head -1)
  assert_json_path "$(cat "$blob")" '.formatVersion' '0.4' || return 1
  assert_json_path "$(cat "$blob")" '.apmLockHash' 'null' || return 1
  assert_json_path "$(cat "$blob")" '.apmLockfile' 'null' || return 1
  assert_json_path "$(cat "$blob")" '.kind' 'init' || return 1
  # 14 modules: 2 hooks + 11 builtins + 1 local skill
  local module_count
  module_count=$(jq '.modules | length' "$blob")
  assert_equal 14 "$module_count" "module count in init blob" || return 1
}
```

### A3: Reproduce no-APM

**CI:**
```bash
case_a3_reproduce_no_apm() {
  cd "$V04_DIR" || return 1
  echo "# corrupted" > .claude/skills/notes/SKILL.md
  local output
  output=$("$HARNESS" reproduce HEAD 2>&1) || true
  assert_contains "$output" "APM phase skipped" || return 1
  assert_contains "$output" "Local-source modules NOT reproduced" || return 1
  assert_contains "$output" "HEAD now at" || return 1
  # File NOT restored — local-source untouched.
  assert_file_contains .claude/skills/notes/SKILL.md "# corrupted" || return 1
}
```

### B3: Synthesized SessionStart hook fires (replaces Claude session)

**Human:** opens `claude`, prompts "what skills are configured here?".

**CI:** fires the hook directly:
```bash
case_b3_synthesized_capture() {
  cd "$V04_DIR" || return 1
  local sid="ci-test-b3-$(date +%s)"
  fire_session_start "$V04_DIR" "$sid" startup || return 1
  fire_user_prompt   "$V04_DIR" "$sid"          || return 1
  # Two attribution events for this session.
  local traj
  traj=$("$HARNESS" sessions "$sid" 2>&1)
  assert_contains "$traj" "session_start" || return 1
  assert_contains "$traj" "user_prompt"   || return 1
  # apm-test must be apm-kind (v0.4.1 enrichment).
  local latest_id
  latest_id=$("$HARNESS" log --limit 1 | awk '{print $1}')
  local blob
  blob=$(find .harness/snapshots -name "${latest_id:2}*.json" | head -1)
  local apm_test_kind
  apm_test_kind=$(jq -r '.modules[] | select(.name=="apm-test") | .source.kind' "$blob")
  assert_equal "apm" "$apm_test_kind" "apm-test source kind" || return 1
}
```

### C2: Hand-edit + capture + reproduce → mismatch (replaces Claude session)

Same translation pattern as B3: edit the file, fire hook to capture,
reproduce, assert on the failure.

### Cases B1, B2, B4, B5, B6, C1, C3, C4, D1, D2, D3, E1

CLI-only — direct shell translation. Each maps assertion-by-
assertion. Cases that already had explicit checks in PLAYBOOK
(B6's HEAD/lockfile/.claude/backup invariants; D3's pathsRemoved
list) translate cleanly.

## New edge cases (CI-only)

These are NOT in PLAYBOOK.md — they require deterministic setups
that are awkward for humans but trivial for a CI script. Add as
X1–X11 after the A/B/C/D/E translations.

### X1: Concurrent hook fires (race-safe)

Fire two `harness-hook` invocations in parallel for the same
session. Both must complete with exit 0. The attributions table
must contain at most 2 rows for that session (not 4) — the hook's
idempotency on `(session_id, observed_at, event_kind)` must hold
under concurrent writes.

```bash
case_x1_concurrent_hooks() {
  cd "$V04_DIR" || return 1
  local sid="ci-x1-$(date +%s)"
  ( fire_session_start "$V04_DIR" "$sid" startup ) &
  ( fire_session_start "$V04_DIR" "$sid" startup ) &
  wait
  local count
  count=$("$HARNESS" sessions "$sid" 2>/dev/null | grep -c session_start)
  # Idempotent: 1 or 2 rows depending on observed_at granularity, never 4.
  [ "$count" -le 2 ] || return 1
}
```

### X2: Blob corruption → reindex recovery

Truncate one snapshot's `.json` file, run `harness reindex`, verify
it surfaces the integrity error AND `harness log` excludes the
corrupted snapshot afterward.

### X3: Deleted parent snapshot detection

Manually delete a snapshot's parent blob, verify the child can
still be read but `harness diff` against the missing parent
surfaces a clear "parent not found" error (not a generic crash).

### X4: Subtractive cleanup boundary (sibling dirs)

Set up `.claude/skills/code/` and `.claude/skills/code-review/`
both as APM-managed in lockfile, target snapshot includes only
`code/`. Reproduce target. Assert: `code-review/` survives,
`code/` is removed (boundary check is `path.startsWith(dir + "/")`,
not just `startsWith(dir)`).

### X5: Subtractive cleanup with symlinks (security)

Inside `.claude/skills/foo/SKILL.md`, replace the file with a
symlink to `/etc/passwd`. Run a reproduce that would remove
`.claude/skills/foo`. Assert: the symlink is removed (the file in
.claude/), but `/etc/passwd` is NOT touched. This is the same
spirit as the existing test 3 (defensive scope filter against
malicious lockfile entries) but at the filesystem-symlink layer.

### X6: Malformed apm.lock.yaml tolerance

Write garbage YAML to `apm.lock.yaml`, fire SessionStart hook.
Assert: hook exits 0 (must not block user); snapshot captures
`apmLockHash` of the bytes (even if entries don't parse); blob's
modules list still includes builtins + locals.

### X7: Empty apm.lock.yaml (zero packages)

Write a valid but zero-dependency lockfile (`packages: []`). Capture.
Reproduce. Assert: APM phase succeeds with `apmModulesExpected = 0`;
no paths removed; HEAD advances.

### X8: HEAD file corruption recovery

Write garbage to `.harness/HEAD`. Run `harness log`. Assert: surfaces
a clear error pointing at HEAD recovery, NOT a generic crash. (Spec
hint: HEAD must contain either a 40-hex id or `ref: refs/heads/<name>`
+ LF.)

### X9: Tag pointing at non-existent snapshot

Manually write `refs/tags/v9.9` containing a non-existent snapshot id.
Run `harness reproduce v9.9`. Assert: surfaces "no snapshot with id"
error, exit code 1, no backup created (abort BEFORE backup since the
ref-resolution failed).

### X10: Reproduce when working tree is partially mutated

Mutate one APM file but not another. Reproduce same snapshot.
Assert: both files end up matching upstream (apm install --force
overwrites both), apmModulesVerified equals expected count.

### X11: Backup directory accumulation

Create 12 dummy `.claude.harness-backup-<ts>/` directories. Run
`harness reproduce HEAD`. Assert: command completes successfully
(backup count is not bounded), 13th backup created.

## Output format

### Default: TAP 14

Per §"The success criterion" above. Compatible with GitHub Actions'
TAP parser, GitLab's JUnit converter, and most local TAP renderers
(e.g. `tappy`, `tap-spec`).

### Optional flags

- `--fail-fast` — exit on first `not ok`. For local iteration.
- `--filter <regex>` — run only cases whose name matches. For
  debugging a specific case.
- `--no-color` — strip ANSI from human-friendly summary line.
- `--leave-state` — skip the on-exit cleanup so the failed run's
  `$V04_DIR` state can be inspected.

## CI integration

### GitHub Actions stub

Drop into `.github/workflows/ci-playbook.yml`:

```yaml
name: CI playbook
on:
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
available when a CI run fails — same spirit as the playbook's
`--leave-state` flag.

## Test gates (for the CI playbook itself)

The CI playbook is also under test. These gates verify it works:

### Gate CIP1: Clean run on green commit

`git checkout main && bash scripts/dogfood-v0_4/ci-playbook.sh` →
exit 0; all 28 cases pass. This gates merging the playbook itself.

### Gate CIP2: Detects a real regression

Manually break one assertion (e.g., revert the v0.4.1 subtractive
commit), re-run. Verify: case D3 (or X4) fails; exit code 1; TAP
output lists the failure with a useful diagnostic.

### Gate CIP3: Idempotent re-run

Run the playbook twice in succession (no manual cleanup). Both
exit 0. The second run's reset.sh cleans up the first run's state.

### Gate CIP4: Selective filter

`bash scripts/dogfood-v0_4/ci-playbook.sh --filter '^D[0-9]+:'` →
runs only D-series cases; other cases neither run nor appear in TAP.

### Gate CIP5: Failure cleanup

When `--leave-state` is OFF and a case fails, the playbook still
cleans up (no leftover backup directories that would interfere with
the next run). When `--leave-state` is ON, the state is preserved.

## What's NOT in scope

- **Translating the v0.3 dogfood playbook (`scripts/dogfood/`).** That
  playbook predates v0.4 and exercises pre-reproducer behavior. CI
  translation of v0.3 is separate work; this prompt is v0.4 only.
- **Property-based / fuzz testing.** This is a deterministic
  scenario playbook, not a test generator. Property-based work
  belongs in `packages/core/test/` as vitest tests, not in the
  observation playbook.
- **CLI changes for testability.** If a case is hard to assert
  because the CLI doesn't expose enough info (e.g., backup path is
  printed but not parseable), file as v0.4.x backlog and write the
  case with the workaround.
- **Performance assertions.** Wall-clock time isn't asserted; CI
  environments vary. If perf regressions become a concern, that's
  separate vitest work.
- **Submission to a CI service.** The GitHub Actions stub is a
  starter; the user/repo owner picks where to actually run it.

## Order of operations

Each step ends in a verifiable state. Pause and commit between steps.

1. **Library scaffolding** (~half day). Author `lib-assert.sh`,
   `lib-hook-fire.sh`, `lib-tap.sh`. Write 3-4 trivial smoke tests
   for each library function (e.g., `assert_equal pass case`,
   `assert_equal fail case`). Run them inline; verify the library
   itself works before any case uses it. Commit.

2. **Runner skeleton** (~2 hours). Author `ci-playbook.sh` with the
   case-runner loop, TAP output, flag parsing, on-exit cleanup. No
   real cases yet — register one trivial case that always passes
   and one that always fails. Verify TAP output shape matches §"The
   success criterion". Commit.

3. **Phase A cases** (~2 hours): A1, A2, A3 translated. Each ends
   with the runner reporting `ok N - <case>`. Commit.

4. **Phase B cases** (~half day): B1–B6. B3 introduces the hook-fire
   library use; verify the synthesized payload produces the same
   snapshot id a real Claude SessionStart would (compare against
   `~/harness-v0_4-observe`'s real captures). Commit.

5. **Phase C cases** (~3 hours): C1–C4. C2's hand-edit case is the
   most subtle — replicates the v0.4.1 mismatch path exactly.
   Commit.

6. **Phase D cases** (~2 hours): D1, D2, D3. D3 must verify
   subtractive contract: removed paths, lockfile removed,
   byte-identity recompute. Commit.

7. **Phase E cases** (~1 hour): E1 audit gate. Parses audit.sh
   output, asserts on the counts. Commit.

8. **Edge cases X1–X11** (~1 day). Implement in dependency order:
   X4, X5, X10 are extensions of subtractive logic (depends on D3);
   X1, X11 are scale tests; X2, X3, X8, X9 are corruption-recovery
   tests; X6, X7 are tolerance tests. Each independent; can pause
   anywhere. Commit per cluster (4 commits).

9. **CI integration** (~half day). Author the GitHub Actions
   workflow. Run it on a PR branch; verify the playbook executes
   end-to-end on the runner. Tune install steps if APM or harness
   have install hiccups in the actions environment. Commit.

10. **CIP1–CIP5 self-gates** (~half day). Verify each gate by
    running the playbook in the gate's prescribed conditions. Fix
    any issues that surface (typically race conditions in cleanup
    or filter regex bugs). Commit.

11. **Documentation** (~2 hours). README in
    `scripts/dogfood-v0_4/` covering: how to run locally, how to
    interpret TAP output, how to add a new case, how to debug a
    failure. Cross-link from PLAYBOOK.md so the human-eval and
    CI versions stay paired. Commit.

## Open questions to surface, NOT settle

The new session should pause and discuss with the user before
making these calls.

1. **Is the synthesized hook fire faithful enough?** A real Claude
   SessionStart includes the full transcript_path and session
   metadata; we synthesize with `/dev/null`. If the hook ever reads
   the transcript (it doesn't today, but might in v0.5+ for
   trajectory enrichment), the CI playbook's payloads need to
   carry real bytes. Surface the risk; default to `/dev/null` with
   a comment in the prompt.

2. **Should X1 (concurrent hooks) test SQLite contention or
   composition deduplication?** Two different properties; pick one
   to assert. Default to deduplication (the spec property); SQLite
   contention is implementation detail.

3. **What's the scope of X5 (symlinks)?** Strict reading of v0.4.1
   §6.1 says "removal restricted to .claude/" — a symlink under
   .claude/ pointing OUT is "in scope" by path but "out of scope"
   by target. Clarify the contract: is the file removal at the
   symlink path (which removes the symlink, not the target) or at
   the resolved path? Default to "removes symlink, NOT target" —
   this is what `rm` does by default.

4. **Should the CI playbook validate against the spec gates too?**
   `python3 scripts/check_schema_agreement.py` and `python3
   scripts/check_format_version_bump.py` already exist. Adding them
   as CI cases (CIP6, CIP7?) gives one entry point for "all
   normative gates"; OR run them separately in a different CI job.
   Default to separate jobs (clearer failure isolation).

5. **Where does the GitHub Actions workflow live?** Stub goes in
   `.github/workflows/ci-playbook.yml`. If the repo doesn't yet
   have `.github/workflows/`, surface that and ask whether to
   create it (might affect other repo conventions).

## Estimated effort

Per the plan above: ~5 days of focused work. Faster than the v0.5
plugin work because it's bash + assertions, not markdown design
work.

## What success looks like (repeating for clarity)

A CI run, on a fresh checkout, against any commit on main, prints:

```
TAP version 14
1..28
ok 1 - A1: reset baseline
[...]
ok 28 - X11: backup directory accumulation
# All 28 cases passed
```

…and exits 0. A CI run on a regression branch prints `not ok`
lines for the broken cases with YAML diagnostics, and exits 1. The
GitHub Actions workflow's PR check is green/red on this single
boolean.

The v0.4 contract is then **enforced**, not just observed. Future
v0.4.x or v0.5 work that breaks an assertion fails the PR check;
the developer sees which assertion and why before merging. The
human PLAYBOOK.md remains as the design-conversation artifact —
read for understanding, not for evaluation.

---

When this prompt is complete, the v0.4.x observation infrastructure
is CI-ready. Future format-spec or CLI changes get a deterministic
gate that catches regressions automatically. New edge cases get
added to the playbook on every patch (per the "playbook accumulates"
discipline established in the v0.4.1 reflection).
