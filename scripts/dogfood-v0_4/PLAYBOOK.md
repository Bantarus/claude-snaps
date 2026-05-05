# v0.4 observation playbook

A live walkthrough that exercises every load-bearing case the v0.4.0
+ v0.4.1 cycle introduced and surfaces the edge cases that have
realistic real-use triggers. Designed to be **read top-to-bottom while
running each step**, with a separate side observation pass at the end
(Phase E).

Scope: `harness reproduce` (§6.1), local-path APM enrichment (§2.3),
checkout divergence warning, audit-recipe behavior. v0.3 features are
assumed already-soaked (see `scripts/dogfood/`); this playbook does
not retread them.

## Conventions

Every step has four lines:

- **Pre.** What's true on disk before you act.
- **Action.** A command, or a Claude Code session prompt. Mine = the
  CLI commands run in this terminal. Yours = a Claude Code session you
  drive.
- **Expected.** The user-visible outcome to look for in the output.
- **Verify.** A follow-up command that confirms the expected state by
  reading durable artifacts (`.harness/`, `.claude/`, `apm.lock.yaml`).

If a verify command's output diverges from what's stated, **stop and
investigate** before moving on — the playbook is a contract, not a
ritual.

`$V04_DIR` defaults to `~/harness-v0_4-observe`. `$APM_FIXTURE_DIR`
defaults to `~/harness-v0_4-apm-fixture`. Override before sourcing
either if you want different paths.

---

## Phase A — Foundation (no APM)

### A1. Reset

**Pre.** Anything (or nothing) in `$V04_DIR`.

**Action (mine):**
```bash
bash scripts/dogfood-v0_4/reset.sh
```

**Expected.** Output ends with `ready`. The script:
- wipes `$V04_DIR`
- runs `git init`
- writes a baseline `.claude/skills/notes/SKILL.md` and a
  `.claude/settings.json` with a `model` field
- runs `harness init` and `harness install-hook` (the latter exercises
  the v0.3.x untracked-settings-json fix path)
- captures one `<manual>` baseline snapshot

**Verify:**
```bash
cd "$V04_DIR" && harness log
```
One row: `★  (main) v0.4-baseline-...` (init kind; `★` glyph; no
parent diff summary). HEAD points at `refs/heads/main`. The note
attached is `"v0.4 observe baseline"`.

### A2. Inspect the baseline blob

**Pre.** A1 done.

**Action (mine):**
```bash
cd "$V04_DIR" && harness log --limit 1 | awk '{print $1}' | xargs -I{} cat .harness/snapshots/{:0:2}/{:2:38}.json 2>&1 | head -25
```

(That's clumsy — easier:)
```bash
cd "$V04_DIR" && find .harness/snapshots -name "*.json" -exec head -30 {} \;
```

**Expected.**
- `formatVersion: "0.4"` (writer is bumped).
- `apmLockHash: null` and `apmLockfile: null` — no APM in the
  project yet.
- `modules` includes one `local` skill (`notes`), one `local`
  instruction (none in this baseline because no `CLAUDE.md`),
  builtins, and the hook the install-hook step merged.

**Verify:** the snapshot blob byte size should be small (~1-2 KB).

### A3. Reproduce a v0.4 snapshot with no APM

**Pre.** A1–A2 done. HEAD on main; baseline snapshot is the only one.

**Action (mine):**
```bash
cd "$V04_DIR"
echo "# corrupted by hand" > .claude/skills/notes/SKILL.md
harness reproduce HEAD
```

**Expected.**
```
HEAD → <id>
Backed up .claude/ to .claude.harness-backup-...
— APM phase skipped (no apmLockfile recorded on this snapshot)
✓ N builtin(s) verified
— Local-source modules NOT reproduced (per §6.1; APM only):
    skill notes (.claude/skills/notes/SKILL.md)
    [other locals]
HEAD now at <id> (detached)
Backup retained at ...
```

**Verify.** The mutated SKILL.md is **not** restored (local-source is
honest about what it can do). Cat it:
```bash
cat "$V04_DIR/.claude/skills/notes/SKILL.md"
```
You should still see `# corrupted by hand`. The backup directory
contains the pre-mutation state:
```bash
diff "$V04_DIR/.claude.harness-backup-"*"/skills/notes/SKILL.md" - <<<'baseline'
```
…actually the backup contains the *mutated* file (the backup happens
right before the reproducer would write, but reproduce here doesn't
write because APM phase is skipped and locals aren't materialized).
Restore manually if you want to continue:
```bash
cat > "$V04_DIR/.claude/skills/notes/SKILL.md" <<'EOF'
---
name: notes
description: Local notes skill — fixture for v0.4 observation
---
# Notes

Baseline local skill installed before harness is initialized.
EOF
harness checkout main  # back to symbolic main
```

**Observation worth flagging.** This is the case the user reflection
called out as a sharp UX corner: `harness reproduce` on a non-APM
project reports without restoring. The contract is honest, but a
real user will probably ask "then what's the point?" Phase B answers
that — bring an APM lockfile and the reproducer earns its name.

---

## Phase B — Reproducer with APM (the load-bearing path)

### B1. Set up the APM fixture

**Pre.** A1 done.

**Action (mine):**
```bash
bash scripts/dogfood-v0_4/setup-apm-fixture.sh
```

**Expected.** A real git repo at `$APM_FIXTURE_DIR` with one APM
skill (`apm-test`) at HEAD. The script prints the commit SHA.

**Verify:**
```bash
git -C "$APM_FIXTURE_DIR" log --oneline
ls "$APM_FIXTURE_DIR/.apm/skills/"
```

### B2. Add a local-path APM dep + first install

**Pre.** A1 + B1 done.

**Action (mine):**
```bash
cd "$V04_DIR"
cat > apm.yml <<APMYML
name: v0_4-observe-project
version: 1.0.0
dependencies:
  apm:
    - $APM_FIXTURE_DIR
APMYML
apm install
```

**Expected.** APM output ends with `Installed 1 APM dependency.` and
`.claude/skills/apm-test/SKILL.md` lands. APM also writes
`apm.lock.yaml` with a `source: local` entry pointing at
`$APM_FIXTURE_DIR`.

**Verify:**
```bash
ls "$V04_DIR/.claude/skills/"
cat "$V04_DIR/apm.lock.yaml"
```
Lockfile shape (the v0.4.1 case):
```yaml
dependencies:
- repo_url: _local/...
  source: local
  local_path: /home/.../harness-v0_4-apm-fixture
  deployed_files:
    - .claude/skills/apm-test
```
Note: `deployed_files` lists the **directory**, not the SKILL.md file.
This is the shape v0.4.1's directory-prefix matcher handles.

### B3. Capture: APM enrichment in action

**Pre.** B2 done. `apm.lock.yaml` exists, `.claude/skills/apm-test/`
exists. Harness has not yet observed the new state.

**Action (yours — Claude session triggers SessionStart capture):**
```bash
cd "$V04_DIR"
claude --model claude-haiku-4-5-20251001
```
At the prompt, paste:
> what skills are configured in this project? brief.

Then `/exit`. Tell me when done.

**Expected.** SessionStart fires; harness writes a new auto snapshot
parented on the baseline. The new snapshot has `apmLockfile` populated
and the `apm-test` skill recorded as `apm`-kind, NOT `local`-kind
(the v0.4.1 fix).

**Verify:**
```bash
harness log --limit 3
```
The new row should read like:
```
<id> ▶ +1 skill (apm-test)  (main) ...
```
And inspect the snapshot's modules:
```bash
LATEST=$(harness log --limit 1 | awk '{print $1}')
find .harness/snapshots -name "${LATEST:2}*.json" -exec python3 -c '
import json, sys
b = json.load(open(sys.argv[1]))
print("apmLockfile bytes:", len(b.get("apmLockfile") or ""))
for m in b["modules"]:
  if m["type"] == "skill":
    print(f"  {m[\"name\"]}: source={m[\"source\"][\"kind\"]}",
          f"package={m[\"source\"].get(\"package\",\"-\")}")
' {} \;
```
You should see `apm-test: source=apm package=_local/...` — the v0.4.1
synthesis. If it shows `source=local`, the enricher regressed; stop
and investigate.

### B4. Mutate APM file → reproduce → restored + verified

**Pre.** B3 done. The latest snapshot has `apm-test` as apm-kind.

**Action (mine):**
```bash
cd "$V04_DIR"
echo "# locally corrupted" > .claude/skills/apm-test/SKILL.md
LATEST=$(harness log --limit 1 | awk '{print $1}')
harness reproduce "$LATEST"
```

**Expected.**
```
<id> → <id>
Backed up .claude/ to ...
✓ apm install --force succeeded; verified 1 of 1 APM module(s)
✓ N builtin(s) verified
— Local-source modules NOT reproduced (per §6.1; APM only):
    skill notes (...)
    [other locals]
HEAD now at <id> (detached)
```

**Verify.** SKILL.md content matches the fixture's content (file
restored):
```bash
diff "$V04_DIR/.claude/skills/apm-test/SKILL.md" \
     "$APM_FIXTURE_DIR/.apm/skills/apm-test/SKILL.md"
```
No output = identical. The reproducer's `verified 1 of 1` line
confirms the configHash was recomputed and matched.

### B5. Tag the v0.4 snapshot, reproduce by tag

**Pre.** B3 done.

**Action (mine):**
```bash
cd "$V04_DIR"
harness checkout main      # back to symbolic ref before tagging
LATEST=$(harness log --branch main --limit 1 | awk '{print $1}')
harness tag v0.4-apm "$LATEST"
echo "# corrupted again" > .claude/skills/apm-test/SKILL.md
harness reproduce v0.4-apm
```

**Expected.** The `v0.4-apm → <id>` resolution renders; otherwise
identical to B4. The tag works as a ref shape for `harness reproduce`.

**Verify.** `harness log` should show the row with `(main) v0.4-apm`
inline (lightweight tag rendering).

### B6. `--dry-run` produces no side effects

**Pre.** B4 or B5 done. `.claude/` is in the reproduced (clean) state.

**Action (mine):**
```bash
cd "$V04_DIR"
echo "# pre-dry-run mutation" > .claude/skills/apm-test/SKILL.md
LATEST=$(harness log --limit 1 | awk '{print $1}')

# Capture pre-state.
HEAD_BEFORE=$(cat .harness/HEAD)
LOCK_BEFORE=$(sha256sum apm.lock.yaml)
CLAUDE_BEFORE=$(find .claude -type f -exec sha256sum {} \; | sort | sha256sum)

harness reproduce "$LATEST" --dry-run

HEAD_AFTER=$(cat .harness/HEAD)
LOCK_AFTER=$(sha256sum apm.lock.yaml)
CLAUDE_AFTER=$(find .claude -type f -exec sha256sum {} \; | sort | sha256sum)

[ "$HEAD_BEFORE" = "$HEAD_AFTER" ] && echo "✓ HEAD unchanged" || echo "✗ HEAD CHANGED"
[ "$LOCK_BEFORE" = "$LOCK_AFTER" ] && echo "✓ apm.lock.yaml unchanged" || echo "✗ LOCK CHANGED"
[ "$CLAUDE_BEFORE" = "$CLAUDE_AFTER" ] && echo "✓ .claude/ unchanged" || echo "✗ CLAUDE CHANGED"
ls -d .claude.harness-backup-*-after-dry-run 2>/dev/null && echo "✗ backup created!" || echo "✓ no new backup"
```

**Expected.** All four checks print `✓`. Output prefixes every
action line with `Would ...` and ends with `(No changes made.)`.

**Verify.** The mutation we made before the dry-run is still there:
```bash
cat .claude/skills/apm-test/SKILL.md   # still "# pre-dry-run mutation"
```
Restore it via a real reproduce when you're ready to continue:
```bash
harness reproduce "$LATEST"
```

---

## Phase C — Edge cases (real triggers)

### C1. Reproduce when working tree already matches

**Pre.** B4 done; `.claude/` matches the latest snapshot.

**Action (mine):**
```bash
cd "$V04_DIR"
LATEST=$(harness log --limit 1 | awk '{print $1}')
harness reproduce "$LATEST"
```

**Expected.** APM phase succeeds (idempotent). `verified 1 of 1`.
HEAD detaches at the same id (no-op effectively, but explicit). A
new backup directory IS created — backup is unconditional per §6.1
(same shape as the live `.claude/`).

**Verify.**
```bash
ls -d .claude.harness-backup-*  # at least 2 by now
diff -r .claude.harness-backup-*-most-recent .claude  # should be empty (note: pseudo-path)
```

**Observation.** Backup-on-no-op is a deliberate UX call: the
reproducer can't know in advance whether the user's `.claude/` is the
"clean" state or a coincidental match. The backup is cheap (one cp
-r); the alternative ("skip backup if no change") would require a
diff first, which costs more than the cp.

### C2. Hand-edit an APM file, capture, reproduce

**Pre.** C1 done.

**Action (mine + yours):**
```bash
cd "$V04_DIR"
harness checkout main
echo -e "\n## Locally added section\n\nA hand-edit on top of the APM file." \
  >> .claude/skills/apm-test/SKILL.md
```

**Action (yours):**
```bash
claude --model claude-haiku-4-5-20251001
```
Prompt:
> what does the apm-test skill say now?

`/exit`. Tell me when done.

**Action (mine, after your session):**
```bash
LATEST=$(harness log --limit 1 | awk '{print $1}')
harness reproduce "$LATEST"
```

**Expected.** The capture during your session records the skill as
`apm`-kind with a configHash that reflects the **local edit**'s bytes
(per spec/apm-integration.md §2.1). `harness diff` against the
previous snapshot shows `~ ✦ apm-test (configHash) (changed)`. When
the reproducer runs, `apm install --force` overwrites the local edit
with the upstream content, and the post-install configHash will
**not** match the snapshot's recorded value (which captured the local
edit). Result:
```
✗ APM phase failed
  • skill apm-test: configHash mismatch (expected sha256:..., observed sha256:...)
! HEAD NOT advanced
```

**Verify.** HEAD is at the previous id (NOT the LATEST):
```bash
cat .harness/HEAD
```
SKILL.md content matches the upstream (local edit overwritten):
```bash
diff .claude/skills/apm-test/SKILL.md "$APM_FIXTURE_DIR/.apm/skills/apm-test/SKILL.md"
```
No diff = APM overwrote the local edit. The configHash mismatch is
the spec working as intended: the snapshot recorded a state where
the file had the local edit; reproduction returns the file to APM's
upstream content; those don't match, and the reproducer flags it.

**Observation worth flagging.** This is the most important edge case
in the playbook. The spec's "APM source wins for reproducibility,
configHash captures local divergence for honesty" choice means the
reproducer can re-create the upstream but cannot re-create
"upstream + your local edit" — there's no place in the format to
store that edit. Users who hand-edit APM files MUST commit the change
upstream (via APM) or accept that reproduction snaps them back to
upstream.

### C3. Reproduce on detached HEAD

**Pre.** C2 done; HEAD is at the last successful reproduce id (NOT
the LATEST snapshot, since C2 failed).

**Action (mine):**
```bash
cd "$V04_DIR"
# Currently detached. Verify:
cat .harness/HEAD   # 40-hex, not "ref: ..."
PREV=$(harness log --limit 2 | awk 'NR==2 {print $1}')
harness reproduce "$PREV"
```

**Expected.** Reproducer runs normally; HEAD detaches at `$PREV`. No
"refused on detached HEAD" error (unlike `observe()` which refuses).

**Verify.**
```bash
cat .harness/HEAD   # now equals $PREV
```

**Observation.** The reproducer's contract is symmetric with checkout
— both work on any HEAD state. Only the writers (`observe` and
`note`) refuse detached HEAD because attribution events need a branch
to advance.

### C4. apm not on PATH → abort BEFORE backup

**Pre.** Anything. The current `.claude/` content doesn't matter.

**Action (mine):**
```bash
cd "$V04_DIR"
LATEST=$(harness log --limit 1 | awk '{print $1}')

# Strip apm from PATH for this one call.
ORIG_PATH="$PATH"
export PATH="/nonexistent"
harness reproduce "$LATEST" 2>&1 || true   # expect non-zero exit
export PATH="$ORIG_PATH"
```

**Expected.** Error message:
```
harness: IntegrityError: harness: apm not found on PATH; install APM (https://github.com/microsoft/apm) ...
```
Exit code 1.

**Verify.**
```bash
ls -d .claude.harness-backup-*-just-now 2>/dev/null && echo "✗ backup created" || echo "✓ no backup created"
```
No new backup directory. The abort happened before the backup step.
This is the spec §6.1 promise: PATH check is the FIRST side-effect
gate.

---

## Phase D — Cross-feature

### D1. Checkout divergence warning fires

**Pre.** C3 done; `.claude/` matches the previous snapshot's
composition.

**Action (mine):**
```bash
cd "$V04_DIR"
echo "# manual mutation" > .claude/skills/apm-test/SKILL.md
LATEST=$(harness log --limit 1 | awk '{print $1}')
harness checkout "$LATEST"
```

**Expected.**
```
HEAD now at <id>. Working tree unchanged.
! Working tree DIVERGED from <id>: your .claude/ composition does not match this snapshot.
   Run harness reproduce <ref> to materialize the snapshot's composition (backed up first).
```

**Verify.** No files were touched (checkout is HEAD-only):
```bash
cat .claude/skills/apm-test/SKILL.md   # still "# manual mutation"
```

### D2. Checkout clean match doesn't warn

**Pre.** D1 done.

**Action (mine):**
```bash
cd "$V04_DIR"
LATEST=$(harness log --limit 1 | awk '{print $1}')
harness reproduce "$LATEST"   # restore .claude/ to match LATEST
harness checkout main         # back to symbolic, then check the warning
```

**Expected.** After the reproduce, `.claude/` matches the latest
snapshot. The subsequent `harness checkout main` should print:
```
HEAD now at <id>. Working tree unchanged.
Working tree matches <id>; no reproduce needed.
```
(No `DIVERGED` line.)

**Verify.** The "matches" line is rendered in dim color; if your
terminal supports color you'll see it muted; either way it appears.

### D3. Capture history → reproduce an ancestor (subtractive contract)

**Pre.** A1–B5 done. There should be ≥3 snapshots: the baseline init
(A1), the APM-enriched auto (B3), maybe the C2 hand-edit auto.

**Action (mine):**
```bash
cd "$V04_DIR"
harness log --limit 5

# Pick the FIRST snapshot (the init from A1).
INIT=$(harness log --limit 99 | tail -1 | awk '{print $1}')
harness reproduce "$INIT"
```

**Expected.** The reproducer rolls `.claude/` back to the init
state. Per §6.1's subtractive contract (v0.4.1):

- `apm-test/` skill directory is **removed** (it's in the project's
  current APM scope but not in init's modules).
- `apm.lock.yaml` is **removed** (init recorded no APM state;
  target `apmLockfile` is null). Backup retained at
  `apm.lock.yaml.harness-backup`.
- Local-source files (`notes/SKILL.md`, hooks in `settings.json`,
  etc.) are **untouched**.
- HEAD detaches at the init id.

The CLI output shows the cleanup explicitly:
```
− Removed (subtractive scope, 1 path):
    − .claude/skills/apm-test
    − apm.lock.yaml (target recorded no APM state; backup at apm.lock.yaml.harness-backup)
```

**Verify.**
```bash
ls .claude/skills/      # should NOT include apm-test/
ls apm.lock.yaml 2>&1   # should NOT exist
ls apm.lock.yaml.harness-backup 2>&1  # backup retained
cat .harness/HEAD       # equals $INIT
```

The byte-identity claim: a fresh re-capture against this state
must produce the same snapshot id as `$INIT`. The reproduce gate
in `packages/core/test/reproduce.test.ts` asserts this directly.

**Observation.** The v0.4.0 ship ran this case and observed the
*additive* behavior (apm-test/ stayed, apm.lock.yaml stayed). That
was the v0.4.1 finding — fixed via §6.1's subtractive amendment.
If you see the additive behavior now, the subtractive logic
regressed; stop and investigate.

---

## Phase E — Audit

### E1. End-of-playbook audit

**Pre.** All phases done.

**Action (mine):**
```bash
bash scripts/dogfood-v0_4/audit.sh > /tmp/v0_4-observe-report.txt 2>&1
cat /tmp/v0_4-observe-report.txt
```

**Expected.** A multi-section report:
1. `harness log` — every snapshot in chronological order.
2. `harness sessions` — every session that observed snapshots,
   with attribution counts.
3. APM-kind module counts vs local-kind: gives the v0.4.1 enrichment
   a hard number ("X of Y modules attributed to APM").
4. Backup-directory inventory: how many backups accumulated.
5. Tag refs.
6. Schema/format gates.
7. Test counts (regression check that we didn't break anything).

**Verify.** All gates green; APM-kind count > 0 (proves v0.4.1 fix
held); backup count matches the number of real reproduces we ran.

### E2. Cleanup

**Pre.** E1 done. Decide whether to keep the soak repo for forensic
reference.

**Action (mine, if cleaning up):**
```bash
rm -rf "$V04_DIR" "$APM_FIXTURE_DIR"
```

Or leave them; they're small (<5 MB) and useful as data when
something later regresses.

---

## What this playbook does NOT cover

Out of scope:

- **Multi-package APM lockfiles** (transitive deps via real github URLs).
  Requires network; not a local-fixture story. v0.4.1's directory-
  prefix matcher handles transitives correctly per the unit tests
  (capture.test.ts), but observing it end-to-end needs a real
  multi-package APM source — pull a small public package if you want
  to extend.
- **`compact` SessionStart source.** Spec §4.6 lists `compact` as one
  of four trigger sources but the v0.3 soak couldn't reproduce one.
  Out of v0.4 scope; track separately.
- **Multi-machine reproducer.** Local-path APM deps don't roundtrip
  across machines (local_path is absolute). For now the contract is
  same-machine reproduce; cross-machine is a v0.5+ candidate.

## When the playbook reveals a regression

The pattern from the v0.3 soak still applies (see
`memory/feedback_soak_misdiagnosis.md`):

1. Reproduce the failure deterministically with the smallest case
   that triggers it (often a single command from this playbook).
2. Check `git log` to verify your hypothesis isn't a misdiagnosis.
3. Fix the root cause; add a unit test that pins the new behavior.
4. Update the playbook step's Expected line if the contract genuinely
   changed.
