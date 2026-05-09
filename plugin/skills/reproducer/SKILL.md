---
name: harness-reproducer
description: "The §6.1 reproducer contract — what `harness reproduce <ref>` does, what it touches, what it never touches, and how to read its outcomes. Subtractive within scope (v0.4.1): APM-managed and builtin paths reproduced; local-source NEVER touched; backup unconditional. Use when the user asks to 'go back to v0.X', 'restore that state', 'reproduce a snapshot', 'roll back .claude/', 'will my CLAUDE.md survive', 'will my local edits survive', 'is reproduce safe', 'what does subtractive mean here', 'configHash mismatch — what does that mean', or any question about the safety/scope/recovery of `harness reproduce`."
---

# harness reproducer — the §6.1 contract

`harness reproduce <ref>` materializes a snapshot's harness composition
into the working `.claude/` directory. This is the load-bearing
operation in the harness lifecycle — it's how a project travels back to
a prior state. The contract is small and exact; deviations from it
break the safety guarantee.

The full normative spec is at
[spec/format.md §6.1](../../../spec/format.md#61-reproducer-contract-v040).
This skill is the user-facing distillation.

## The contract in one paragraph

Reproduce restores **APM-managed** and **builtin** paths to the target
snapshot's state. **Local-source paths are NEVER touched.** Backup
happens unconditionally at `.claude.harness-backup-<ISO timestamp>/`.
Reproduction is **subtractive within scope** (v0.4.1, §6.1) — APM-
managed paths NOT in the target snapshot are removed, and the project's
`apm.lock.yaml` is restored to match the snapshot's recorded
`apmLockfile`. If the APM phase fails, HEAD is NOT advanced and the
backup is retained; recover by `mv` of the backup back over `.claude/`.

If the user wants the full safety wrap (dry-run + interpretation +
confirmation), route through `/harness:restore <ref>` — it activates
the reproducer-pilot subagent which handles the conversation.

## What is reproduced

- **APM-managed modules** (`source.kind = "apm"`). The reproducer:
  1. Writes the snapshot's recorded `apmLockfile` content to
     `apm.lock.yaml` (any existing file is backed up to
     `apm.lock.yaml.harness-backup`).
  2. Invokes `apm install --force` (lockfile-honoring; reuses the
     locked commits; `--force` overwrites a drifted `.claude/`).
  3. Recomputes `configHash` for each APM-source module against the
     deployed file and verifies equality with the recorded value.
- **Builtin modules** (`source.kind = "builtin"`). Verified to be
  present in the host's known-builtin set. **No filesystem write** —
  builtins are runtime-defined.

## What is reported but NOT materialized

- **Local-source modules** (`source.kind = "local"`). The reproducer
  prints the list with their recorded `configHash` and source path.
  v0.4.0 snapshots **do not store local-source content** — the
  reproducer cannot recreate a local file from a snapshot. Users who
  want full reproducibility on a local module promote it to APM. (The
  `harness-fundamentals` skill covers source kinds.)

This is why `CLAUDE.md` survives: it's local-source. So is anything
hand-edited in `.claude/` that isn't APM-managed.

## Subtractive within scope (v0.4.1)

This is the part users misread most often. The reproducer:

- **Materializes** APM-managed paths and builtin verifications recorded
  in the target snapshot exactly.
- **Removes** APM-managed paths that are NOT recorded in the target
  snapshot but are present in the working `.claude/` (e.g. an APM
  module that exists today but didn't exist at snapshot time).
- **Restores** the project's `apm.lock.yaml` — written if the snapshot
  recorded a non-null `apmLockfile`, or removed if the snapshot
  recorded no APM state.
- **Does NOT touch** local-source paths.

Rationale: reproduction's value depends on the post-reproduce working
tree being byte-equivalent (modulo local-source) to a fresh capture of
the target. An additive-only reproducer leaves files behind from the
prior state and silently breaks that equivalence. The unconditional
backup, NOT the absence of deletion, is the safety mechanism.

## Side effects

- `.claude/` is backed up to `.claude.harness-backup-<ISO timestamp>/`
  before any write. **Unconditional** (no `--no-backup` flag) and not
  auto-deleted. The backup path is printed on every invocation,
  including dry-run.
- `apm.lock.yaml` is rewritten or removed (per the subtractive rules
  above).
- `apm install --force` writes APM-managed files into `.claude/`
  (subject to APM's own deployment rules).
- `.harness/HEAD` advances to the reproduced snapshot id **on success**
  (whether the snapshot is a branch tip or a detached id). The
  reproducer does NOT rewrite branch refs.
- The user's git state is **not modified**. `codePin` is preserved as
  alignment metadata; aligning project git is a separate
  `git checkout <codePin>` the user can run independently.

## Failure modes (read these before debugging "✗ APM phase failed")

| Failure | Behavior |
|---|---|
| Snapshot's `apmLockfile` is null (no APM at capture, or v0.3.x snapshot) | APM phase **skipped**. Builtins verified. Local-source reported. HEAD advances. The reproducer prints "no APM lockfile recorded" — this is the contract, not a bug. |
| `apm install` exits non-zero (network failure, missing package, version conflict, deleted upstream commit) | Reproducer **aborts BEFORE advancing HEAD**. Backup retained. APM stderr surfaced with the backup path. |
| APM module verification fails (installed but `configHash` mismatch) | Reproducer **aborts BEFORE advancing HEAD**. Backup retained. The mismatched modules are listed with expected vs. actual `configHash`. |
| Builtin missing from host | Reported but does NOT abort — builtins are advisory metadata, not load-bearing. |
| `apm` binary not found on PATH | Reproducer aborts **BEFORE backup**. Clear error pointing at the APM install URL. |

## Recovery from failure

If the APM phase fails partway, `.claude/` may be in a partial state
(some modules deployed, some not). The reproducer does NOT auto-
restore. Manual restoration is one command:

```bash
rm -rf .claude && mv .claude.harness-backup-<ISO timestamp> .claude
```

This is deliberate. A partially-deployed install is not necessarily
wrong (you may want to inspect it), and an auto-rollback would itself
need a recovery path.

## configHash mismatch — interpretation

A `configHash` mismatch on an APM-source module means **the snapshot
recorded a local edit on top of an APM-installed file**. The hashed
bytes (typically SKILL.md frontmatter or settings.json fragment) at
snapshot time differ from what `apm install --force` produces today.

Reproduce can recreate the upstream APM file, but it cannot recreate
"upstream + your edit." Two choices:

- **Commit the edit upstream** (push it into the APM package) and
  re-run reproduce — the upstream now matches the snapshot's hash.
- **Accept being snapped back** to the upstream-only version. Local
  edits live in the backup; manual cherry-pick from there if wanted.

Pretending this isn't a tradeoff would defeat the contract.

## Dry-run discipline

`harness reproduce <ref> --dry-run` performs all reads (loading the
snapshot, parsing the lockfile, listing planned actions) **without
side effects**. `.claude/`, `apm.lock.yaml`, HEAD, and APM's
`apm_modules/` are unchanged. The dry-run output describes what
would happen.

**Always run `--dry-run` first when the situation has nuance:**

- Non-APM project (target snapshot has `apmLockfile = null`) — to
  confirm the reproduce is a no-op-for-content (only subtractive
  cleanup).
- Hand-edited APM files in working `.claude/` — to surface
  configHash mismatches before they fail mid-reproduce.
- Ancestor reproductions across composition changes — to see what
  APM-managed paths will be removed and confirm intent.
- Detached HEAD — to confirm the reproducer behaves as expected
  (it does, but checking is cheap).

The `/harness:restore` slash command always runs `--dry-run` first
and asks for confirmation before the real reproduce. **For non-trivial
cases, prefer `/harness:restore <ref>` over a direct `harness reproduce`.**

## When to use this skill

Trigger this skill when the user asks anything in the safety/scope
domain:

- "Will my CLAUDE.md / settings / hand-edited skills survive a
  reproduce?" → **Yes — local-source paths are never touched.**
- "What does subtractive mean here?" → §6.1 + the rationale above.
- "Reproduce failed — what do I do?" → Match against the failure-
  modes table; explain backup recovery.
- "configHash mismatch — what does that mean?" → The interpretation
  section above.
- "Is `--dry-run` necessary?" → Yes for non-trivial cases; route
  through `/harness:restore` for the wrapped flow.

The reproducer-pilot subagent (behind `/harness:restore`) handles the
interactive flow. This skill is the reference doc that backs both
direct CLI use and the pilot's reasoning.
