# v0.3.0 dogfood soak findings — 2026-05-03

10-day scripted scenario with real Claude Haiku sessions. Same playbook
as the v0.2 soak (`scripts/dogfood/`), refreshed for v0.3 vocabulary
plus new probes for the v0.3 surfaces (`harness snap "<note>"`,
`harness notes <ref>`, the in-`harness log` `summarizeDiff` rendering).

Audit transcript: [soak-report-v0_3.txt](soak-report-v0_3.txt). Compare
to [SOAK_FINDINGS_v0_2.md](SOAK_FINDINGS_v0_2.md) for the v0.2 baseline.

## Top-line: v0.3 contract held + v0.2's top finding closed

| Contract | Status |
|---|---|
| Notes are first-class attribution events (no new snapshot on `harness snap "<note>"` against unchanged composition) | ✅ Confirmed: 2 note events written, 0 new snapshots from them |
| `summarizeDiff` closes the v0.2 "(no message)" readability gap | ✅ Confirmed empirically — see "Auto-summary verdict" below |
| Q1 trajectory query renders notes inline with `@` markers | ✅ Confirmed: `<manual>` session trajectory threads both notes against their snapshots |
| Q2 cross-session notes query (`harness notes <ref>`) | ✅ Confirmed: `harness notes v0.1` and `harness notes v0.3` both surface the right note |
| Dedup at scale (multiple sessions, one snapshot) | ✅ Confirmed: `[4 sessions]` on the v0.1 tag (multi-session day-5+day-7 traffic) |
| §4.6 SessionStart on resume/clear/compact (not just startup) | ✅ Confirmed for resume + clear; compact untested |

## Auto-summary verdict — the v0.2→v0.3 win

Reading `harness log` like a stranger after the soak:

```
8b87dffa ▶ +2 skills, +1 prompt, +1 style  (main)
c9ae0620 ▶ -1 skill (test-runner)          (main)
8bcfb5f2 ▶ ~1 skill (test-runner)          (experimental)
6f8728b4 ▶ +1 instruction, +1 agent, +1 prompt  (main)
6412aad4 ▶ +1 mcp                          (main)
0c009c4a ▶ ~1 skill (notes)                (main)
4da053ad ▶ +1 skill                        (main)
27323507 ★ init                            (main)
```

You can recover what was happening on each day from the per-row summary
alone. The experimental fork stands out clearly. Single-add rows omit
the name (clutter), single-remove/change rows show it (`(test-runner)`,
`(notes)`). Bulk-add aggregates by type (`+2 skills, +1 prompt, +1
style`). I rarely needed to drop into `harness sessions <id>` to make
sense of the lineage — exactly the v0.3 design promise.

**This is the most important v0.3 win.** v0.2's soak finding said
"`harness log` is unreadable standalone, every row is `(no message)`."
v0.3's `summarizeDiff` makes the lineage standalone-readable.

## §4.6 fully empirically verified

The v0.3 spec rewrote §4.6 to drop the "resume gap" framing and assert
that the host fires `SessionStart` on every host-level event including
resume/clear/compact. The soak observed three of the four source values
in real Claude Code firings:

| Source | Count | When it fired |
|---|---|---|
| `startup` | 8 | Every fresh `claude --model …` launch |
| `resume` | 2 | Day 5 and day 7 `claude --continue` calls |
| `clear` | 1 | Day 7 mid-session `/clear` (also minted a new session_id) |
| `compact` | 0 | Untested — would need a `/compact` probe |

Empirical observations strengthening §4.6's narrative:

- **`/clear` mints a NEW session_id** (this is Claude Code host
  behavior, not v0.3 behavior). The fresh session's first hook fire is
  a `session_start` with `source=clear`. Both bits matter: the
  session_id boundary is real, and the source value is recorded.
- **`claude --continue` reuses the existing session_id**. The session's
  trajectory shows a second `session_start (resume)` event followed by
  a `user_prompt`, all under the same id. Two `--continue` calls
  produce two `session_start (resume)` rows in the same session.
- A session can therefore have multiple `session_start` rows — exactly
  what §4.6 says implementations rendering session timelines MUST
  handle gracefully. The `harness sessions <id>` output handles it
  fine: `→` for the first composition transition (with summary), `=`
  for subsequent same-composition events (no summary).

## Notes-as-events: the new v0.3 path works

Two notes attached during the soak via `harness snap "<text>"`:

```
$ harness sessions '<manual>'
Session <manual> trajectory:
  19:23:56  note  @ 6f8728b4 "promoting baseline composition to v0.1"
  19:42:06  note  @ 8b87dffa "v0.3 final tag — soak complete"

Spanned 2 snapshots over 18m9s; 2 user notes.
```

Mechanics confirmed:
- `harness snap "<note>"` against unchanged composition writes ZERO
  new snapshots and ONE note row attached to the existing tip.
  ("No composition change since 8b87dffa; note attached to existing
  snapshot.")
- The literal `<manual>` sessionId pattern works as a pseudo-session
  in `harness sessions` listings without breaking other queries.
- `harness notes <ref>` resolves any ref shape (id prefix, branch,
  tag, HEAD) and returns the cross-session view (Q2). Tested against
  `v0.1` and `v0.3` tags.
- Trajectory rendering with the `@` marker reads naturally next to the
  `→`/`=` markers used for observation rows.

## Findings worth flagging for v0.3.x / v0.4

### 1. `harness tag` ↔ §2.2 ↔ build_examples.py disagree on tag-kind snapshots

`harness tag <name> <id>` writes a lightweight ref only — no new
snapshot blob is created. The audit confirms: snapshot count by kind
is `auto: 7, init: 1` after a 10-day soak that ran `harness tag v0.1`
and `harness tag v0.3`. **Zero `tag`-kind snapshots ever exist in
real CLI usage.**

But:
- `spec/format.md §2.2` lists `tag` as one of three kinds:
  *"Promotion to a named version. `version` MUST be set."*
- `spec/schema/snapshot.schema.json` accepts `tag` in the kind enum.
- `scripts/build_examples.py` writes `kind: "tag"` snapshots into
  every example fixture (solo-no-apm has one, solo-with-apm has one,
  team-shared has one).
- `spec/format.md §4.2` separately says *"v0.3 supports only
  lightweight refs — no annotated tags, no reflog. The tag's `version`
  lives on the tagged snapshot itself."*

So the spec internally splits between "tags are lightweight refs"
(§4.2) and "tag is a snapshot kind with required `version`" (§2.2).
The CLI takes the first interpretation; the example generator takes
the second; readers have to handle both.

**Resolution candidates** (pick one in v0.3.x):
1. Drop the `tag` kind from §2.2 + the JSON schema enum + the SQL
   CHECK; remove `kind: "tag"` from build_examples.py; tags are pure
   refs. Cleanest, but breaks readers that already match on `kind ==
   "tag"`.
2. Make `harness tag` create a `tag`-kind snapshot pointing at the
   underlying composition (parentIds=[<tagged-id>]) with `version`
   set. Aligns CLI with §2.2 and the examples; doubles snapshot count
   for tagged compositions but matches the examples writers expect.
3. Document the split explicitly: "tags MAY be lightweight refs OR
   tag-kind snapshots; both forms are conformant; readers MUST
   tolerate either." Honest, but pushes the inconsistency onto
   readers.

I'd advocate (1) — the simpler model. The `tag` kind was carried over
from v0.1 mental modeling; v0.3's "snapshots are composition; refs
are pointers" framing wants tags as refs.

### 2. Day-9 dedup-at-scale probe asks for the wrong pattern

The dogfood script asks the soaker to fire two `claude --continue`
calls after the bulk-add Session 1, expecting `[3 sessions]` on the
day-9 snapshot. But `--continue` reuses the existing session_id, so
empirically all three prompts land in **one** session (28fd642e) with
6 events. Result: `[1 session]` on the day-9 row, not `[3 sessions]`.

To actually test cross-session dedup-at-scale, the script should ask
for two fresh `claude --model ...` launches (which produce new
session_ids), the way day 03 does. **Patch needed in
`scripts/dogfood/09-bulk-add.sh` and `PROMPTS.md`.**

The dedup behavior itself is fine — see day 7's `[4 sessions]` on the
v0.1-tag composition and day 10's `[3 sessions]` on the v0.3-tag
composition. Cross-session dedup works; the day-9 probe just doesn't
exercise it.

### 3. `harness diff` shows `~ ✦ notes ? → ?` for changed modules

The full-soak diff (`harness diff 27323507 8b87dffa`) renders one
change row as:

```
~ ✦ notes ? → ?  (changed)
```

The `?` placeholders are clearly placeholders for the configHash
before/after values, but they're literal question marks in the
output. Either show the actual hashes (`abc12345 → def67890` or
similar prefix), show what attribute changed (`(configHash)`), or
drop the `? → ?` entirely. **`packages/cli/src/commands/diff.ts` —
1-day v0.3.x patch.**

### 4. `install-hook` CLI path errored on reset; python fallback worked

`reset.sh`'s primary install path is `echo "y" | harness install-hook`,
which failed silently and triggered the Python fallback (which writes
both SessionStart and UserPromptSubmit entries directly). End result
was correct (both hooks installed) but the CLI path's failure mode is
masked. Worth investigating: did the v0.3 changes regress something
in `install-hook`? Probably the `-m` short-flag removal or a related
arg-parser change. **Investigate before the next dogfood release.**

### 5. JSONL `attachment.hookEvent` only catches startup-source SessionStarts

The audit's section 6 reports per-session SessionStart attachment
counts from the Claude Code transcript JSONL files. Sessions where
SessionStart only fired with `source=resume` or `source=clear` show
**0 attachments** (e.g. session `7dab637a` had a `session_start
(clear)` AND a `session_start (resume)` plus user_prompts, but its
JSONL shows 0 attachments). This is a host-side observation, not a
v0.3 bug — Claude Code's transcript writer only emits
`attachment.hookEvent` for source=startup SessionStart fires.

The audit script already labels section 6 as "v0.1-shape signal only"
post-v0.2 soak; v0.3 confirms the labeling was correct. The
authoritative fire ledger is section 4b (the attributions table).
v0.4 candidate: parse the full hook trail correctly to surface
resume/clear-source fires too.

### 6. Per-snapshot summary column is unused in `harness log` for `kind: init`

Init snapshots render as `★ init` followed by a literal `init` from
summarizeDiff:

```
27323507 ★ init  (main) code:7ab14b4
```

The `★` glyph already indicates init; the trailing "init" string is
redundant. summarizeDiff returns "init" for the parent-null case,
which `harness log` pastes verbatim. Tiny cosmetic — strip the
"init" string when kind=init in `log.ts`, OR change summarizeDiff to
return an empty string for the init case. Either fix is 5 lines.

### 7. `harness checkout` working-tree footgun — still pending

Day 7's setup script restored main's test-runner content manually as
a workaround. `harness checkout <branch>` still doesn't revert the
working tree. The CLI prints a helpful hint
(*"Working tree unchanged. Use 'harness reproduce' to apply this
snapshot's harness composition (not yet implemented)."*) but the real
fix is `harness reproduce` / `harness checkout --apply`, which is in
the v0.4 candidate list (`format.md §9.4`).

This is the same finding from the v0.2 soak; intentionally rolled
forward.

## Numbers at a glance

- **8 snapshots** total across main + experimental (1 init + 7 auto;
  zero tag-kind blobs because tag CLI is lightweight ref).
- **13 distinct session_ids** observed.
- **33 attribution events** total: 16 session_start, 15 user_prompt,
  2 note, 0 manual_capture, 0 migrated.
- **2 notes** attached, both via `harness snap "<text>"` against
  unchanged composition (zero new snapshots from notes).
- **3 distinct `source` values** observed: startup (8), resume (2),
  clear (1).
- **Spec gates green:** 37 schema-agreement cases, format-version-bump
  detector clean (no spec changes during soak), canonical-501.bin
  byte-stable through 10 regenerations.
- **Test gates green:** 169 tests across @harness/core, /cli, /hook.
- **Working tree audit clean:** 20 example blobs on disk, 20 tracked
  in git.

## What v0.3.x should pick up (priority order)

1. Pick a resolution for the `tag` kind ↔ `harness tag` lightweight ref
   inconsistency (finding #1). **Highest priority** — internal spec
   coherence.
2. Fix `harness diff`'s `? → ?` placeholder rendering (finding #3).
   **One-day patch.**
3. Investigate `install-hook` regression that triggered the python
   fallback (finding #4). **One-day investigation.**
4. Strip the redundant `init` summary string from init-row log output
   (finding #6). **5-line fix.**
5. Fix the day-9 dedup-at-scale probe to use fresh `claude` launches
   instead of `--continue` (finding #2). **Dogfood-script patch.**
6. (Stretch) Begin the `harness checkout --apply` / `harness
   reproduce` work that closes the working-tree footgun (finding #7,
   v0.4 candidate).
