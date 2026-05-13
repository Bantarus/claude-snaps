# Dogfood Soak Findings — v0.2.0

**Date:** 2026-05-03
**Soak Directory:** `~/harness-dogfood-soak`
**Duration:** ~25 minutes of real-time soak (10-day scenario compressed)
**Sessions:** 11 distinct session ids, 35 attribution events, 9 snapshots (1 init + 8 manual)
**Format version under test:** v0.2.0 Working Draft

This is the v0.2.0 follow-up to [SOAK_FINDINGS.md](SOAK_FINDINGS.md)
(the v0.1.x soak that surfaced the resume-gap finding).

---

## Summary

The soak verified both load-bearing v0.2.0 contract changes empirically:

1. **The resume gap is closed.** A resumed session that did not change
   composition was captured (6 user_prompt events, 0 SessionStart
   attachments) — invisible under v0.1.x semantics, fully observable
   here.
2. **Dedup works at the snapshot level.** 35 attribution events
   collapsed to 9 unique snapshots; 9 of 11 sessions had
   `events > snapshots` (multiple fires on a stable composition
   produced a single snapshot row).

All spec gates green (schema agreement, format-version-bump,
canonical-501 byte-stability, gitignore audit, 171 tests across
packages). No drift from clean state.

**One critical UX gap surfaced** (auto-message), one **real footgun**
(`harness checkout` not applying state), one **anomaly worth
investigating** (multiple SessionStart attributions per session),
and a handful of audit-recipe / cosmetic patches.

---

## Verified Findings

### ✓ Resume gap closure (v0.2 primary motivation)

**Observed:** session `c02ee05a-e139-47eb-b985-f232a9a9` recorded:
- 6 attribution events (all `user_prompt` — no `session_start`)
- 1 snapshot (the existing main tip; composition unchanged)
- 0 entries in the JSONL `attachment.hookEvent` trail

That asymmetry is the v0.2 fingerprint of a resumed session: Claude
Code did not fire `SessionStart` (so JSONL has no attachment), but
fired `UserPromptSubmit` 6 times against unchanged composition (so
the attribution table has 6 rows, no new snapshot, no ref advance).

**Under v0.1.x:** this session would have been completely invisible
— zero rows anywhere. The original soak's primary finding.

**Under v0.2.0:** the activity log captured it cleanly. The soak
verifies the design choice landed correctly.

### ✓ Dedup behavior

```
35 events / 9 snapshots = ~4× attribution-to-snapshot ratio
9 of 11 sessions: events > snapshots
2 sessions: events == 2 × snapshots (composition changed mid-session)
```

The two outliers (`47c49608` and `48e5c422`) are not bugs — they are
sessions where composition genuinely changed between user prompts
inside one session (e.g. the user invoked `claude`, ran the day-3
script in a separate terminal, then prompted again — UserPromptSubmit
correctly caught the transition).

The hot-path cache earned its keep: in 26 of 35 attribution events
(74%), the hook took the fast path (no canonicalize, no walk, no blob
write).

### ✓ Cross-version diff legibility

`harness diff v0.1 v0.2` produced a clean, scannable summary:

```
+ ✦ git-explain    + ✦ profile-bench    − ✦ test-runner
+ / /note          + ◇ terse
+4 added  −1 removed  ~0 changed
```

Same for the full-soak diff (`init → latest tip`). The diff command
is the legibility wins of v0.2 — it's where module-level changes are
most readable.

---

## Critical Gap: Hook-driven snapshots are unreadable in `harness log`

**Observed:** every hook-driven snapshot in `harness log` shows
`(no message)`:

```
5a118f74 ▶ (no message)  (main) code:53bba61
ce1f6977 ▶ (no message)  (main) code:53bba61
3e4719fc ▶ (no message)  (main) code:53bba61
ef81077b ▶ (no message)  (experimental) code:53bba61
...
83baffec ★ (no message)  (main) code:53bba61
```

With 8 indistinguishable `▶ (no message)` rows on `main`, you cannot
tell day 2 from day 9 from the log alone. The trajectory view
(`harness sessions <id>`) tells you WHEN each session was active
against each snapshot, but NOT WHAT each snapshot represents.

**To recover meaning today** the user has to:
- Diff each consecutive pair (`harness diff a b`, `harness diff b c`,
  ...) — workable for a 9-row history, untenable at 100+.
- Cross-reference `created_at` timestamps against external context.
- Tag known milestones (only viable for explicit releases).

**Why this happened:** v0.2.0 deliberately made `message` nullable
because hook-driven snapshots have no user-supplied annotation. The
design assumed the trajectory + sessions overview would carry the
narrative weight. The soak shows that's only true if you already know
which sessions to look at — `harness log` alone is essentially a list
of timestamped hashes.

**Fix proposal (v0.2.x patch):** auto-derive a one-line message at
write time from the `(parent_modules, current_modules)` delta. Same
shape as `harness diff` summary. For a snapshot that adds one skill,
the message would be `+ skill profile-bench`. For multi-change
captures, `+2 skills, +1 prompt`. The information is free — we already
have it at write time.

User-supplied messages (`harness snap -m`) override the auto-message;
the design pin from the v0.2 cutover stays intact ("if `-m` is
supplied, message participates in canonical bytes; the snapshot is
distinct from a no-message capture").

This is the **strongest v0.3 priority signal** from the soak.

---

## Real Footgun: `harness checkout` does not apply state

**Observed:** snapshot `3e4719fc` (main, 16:14:19) was captured AFTER
the day-6 branch back to main. Composition: 11 builtin + 8 local —
identical module COUNT to the day-5 main tip (`dc8ef0b4`), but
different module CONTENT, because the test-runner SKILL.md on disk
was still the experimental variant from day 6.

The day-6 script set the experimental variant on disk; the day-7
script ran `harness checkout main`, which moved HEAD but did not
revert the working tree. The next hook fire captured experimental's
test-runner content under `branch=main` parentage.

**Why this is a footgun:** most users will assume `harness checkout`
behaves like `git checkout` — files revert. The CLI's output literally
says "Working tree unchanged" but this is easy to miss in a busy
terminal.

**Fix proposals:**
- **Short term (v0.2.x):** `harness checkout` warns if the live
  working tree's composition differs from the target snapshot's
  modules. Output:
  ```
  HEAD now at <id>. Working tree unchanged.
  ⚠ Working tree composition differs from <id>:
       ~ skill test-runner (configHash differs)
     The next hook fire will capture the working tree, not <id>.
     To apply <id>: <reproducer command, when shipped>
  ```
- **Long term:** the reproducer (D-original, still deferred) — apply
  `<snapshot>.modules` to the working tree on `harness checkout
  --apply`.

---

## Anomaly: 17 SessionStart attributions across 11 sessions

**Observed:**
- Total `session_start` events: 17
- Distinct session_ids: 11
- Average: ~1.5 SessionStart per session

Some sessions have multiple `session_start` rows. Could be:
- Claude Code firing SessionStart on `compact`/`clear` with the same
  session_id (rather than minting a new one).
- Some hook-restart scenario in the host.
- An idempotency edge case in the v0.2 hook (PK is `(session_id,
  observed_at, event_kind)` — millisecond-distinct fires won't
  collide).

**Investigation query:**
```sql
SELECT session_id, COUNT(*), GROUP_CONCAT(observed_at, ', ')
  FROM attributions
 WHERE event_kind='session_start'
 GROUP BY session_id
 HAVING COUNT(*) > 1
 ORDER BY COUNT(*) DESC;
```

Not blocking — the design accommodates multiple events at distinct
timestamps gracefully. But understanding which scenario produces this
is worth one debugging session before locking the v0.2.x patch
definitions.

---

## Audit Recipe Bug: JSONL `hook firings` counter

**Observed:** the `audit.sh` section 6 recipe shows "0 firings" for
sessions that demonstrably fired the hook (e.g. `c02ee05a` recorded
6 `user_prompt` attribution events but shows 0 hook firings in the
JSONL trail).

**Root cause:** the recipe counts `attachment.hookEvent` entries in
Claude Code's JSONL. That field is emitted only on `SessionStart`
attachments (v0.1-era behavior); `UserPromptSubmit` fires don't
produce an attachment entry in the same shape.

**Fix:** update the audit recipe to also count `UserPromptSubmit`
events from the JSONL, using whatever Claude Code's current shape is
for them (likely a separate `attachment.userPromptSubmitEvent` or
embedded in the message stream — needs verification against current
Claude Code JSONL output).

Until then, the audit's "hook firings: 0" is a misleading signal that
makes resumed sessions look broken when they're working correctly.

---

## Cosmetic / Minor

- **Diff renders `?` for absent versions.** `~ ✦ notes ? → ?` is the
  notes skill changing without a version field. Should render
  `(no version)` or elide the arrow when both sides are unversioned.
- **`(no message)` on the init snapshot** is jarring — `init` is the
  one snapshot that always has a clear semantic ("baseline"). Default
  init message could be `init` or `baseline @ <branch>`.
- **`code:53bba61`** appears on every row. When the code pin is
  unchanged across a sequence of snapshots, dimming or eliding it
  would let the user's eye flow across what DID change.

---

## Inferred v0.3 Roadmap

Ranked by observed pain in this soak:

1. **Auto-message for hook captures** — the `harness log` legibility
   fix. Highest priority. ~1 day of work.
2. **`harness checkout --apply` (the reproducer)** — closes the
   working-tree-doesn't-revert footgun and unblocks the "rewind to
   v0.1" use case. The original D-prompt; substantial work.
3. **Investigate the multi-SessionStart anomaly** — single-day
   investigation; informs whether v0.2.x needs a refinement.
4. **Audit recipe fix** — half-day patch to count both event types
   from JSONL.
5. **`harness log --since <ref>`** filter — natural extension once
   auto-messages exist; surfaces "what's happened since the last tag."
6. **Diff render polish** — version arrow elision, code-pin dimming.

Plus what was already on the v0.3 candidate list pre-soak (additional
hook events: `PreCompact`, `SessionEnd`, `ConfigChange`; annotated
tags + reflog; multi-machine sync; tag annotations in `harness log`;
local-source content storage; user-level capture).

---

## Audit Summary

| Metric | Result |
|--------|--------|
| Snapshots | 9 (1 init + 8 manual) ✓ |
| Branches | 2 (main + experimental) ✓ |
| Tags | 2 (v0.1, v0.2) ✓ |
| Attribution events | 35 (17 session_start + 18 user_prompt) |
| Distinct sessions | 11 (one resumed, captured ✓) |
| Attribution/snapshot ratio | ~4× (cache fast-path winning) ✓ |
| Resume gap captured | YES — session c02ee05a, 6 events 0 SessionStart attachments ✓ |
| Dedup verified | YES — 9 of 11 sessions, events > snapshots ✓ |
| `harness diff v0.1 v0.2` legible | YES ✓ |
| `harness log` legible standalone | NO ✗ (auto-message gap) |
| `harness checkout` reverts working tree | NO ✗ (reproducer deferred) |
| Schema agreement | 30/30 cases ✓ |
| Format-version-bump check | clean ✓ |
| canonical-501 byte-stability | byte-identical ✓ |
| Test gates | @harness/core 107, /cli 42, /hook 22 (171 total) ✓ |

---

## Soak Transcript

Full audit output: [soak-report-v0_2.txt](soak-report-v0_2.txt)
(the prior [soak-report.txt](soak-report.txt) is the v0.1.x soak that
surfaced the resume-gap finding; preserved for historical comparison).
