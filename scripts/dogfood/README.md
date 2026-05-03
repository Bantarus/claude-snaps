# Dogfood soak — scripted 2-week scenario (v0.3)

Drive a synthetic-but-real soak of the harness-snaps system end-to-end.
The scripts mutate `.claude/` between sessions; you launch Claude Code
with the cheap Haiku model, do a brief interaction, exit; the hook
fires on **`SessionStart` AND every `UserPromptSubmit`** and records
attribution events (and snapshots, when composition changed). After 10
sessions you have a rich, varied lineage to inspect, plus rich
trajectories per session, plus a couple of free-form `note` events from
direct CLI annotations.

## Why this exists

Three observation goals:

1. **Does the lineage tell a coherent story?** Reading `harness log`
   like a stranger after the soak — do the snapshot kinds, branches,
   and per-row diff summaries (`+1 skill`, `~1 skill (notes)`, etc.)
   match what you remember doing? Is the `harness sessions <id>`
   trajectory output a coherent narrative or noise?
2. **Are the diffs informative?** Pick two snapshots, run
   `harness diff`. Some scenarios are deliberately no-change (tests
   "boring diff" floor), some are 5-thing-at-once (tests "is the diff
   still readable?" ceiling).
3. **Did the v0.3 contract land?** Specifically: (a) `claude --continue`
   produces `user_prompt` attribution rows AND a `session_start` row
   with `source=resume` (per spec/format.md §4.6 — the host fires
   SessionStart on resume too); (b) sessions sharing a composition
   share a snapshot id (dedup); (c) `/clear` produces a new session
   that observes the same snapshot via attribution-only; (d) `harness
   snap "<note>"` attaches a `note` attribution event without writing
   a new snapshot when composition is unchanged, and `harness notes
   <ref>` surfaces every note ever attached.
4. **What features are missing?** The "I wish I could…" list. Keep
   notes throughout.

## Cost

Each session is one Claude Haiku interaction with a brief prompt.
Wall-clock ~1 hour, well under $1 in tokens.

## Prerequisites

- `harness` and `harness-hook` on `$PATH`. Recommended setup:
  ```bash
  pnpm -r build
  mkdir -p ~/.local/bin
  ln -sf "$PWD/packages/cli/bin/harness"        ~/.local/bin/harness
  ln -sf "$PWD/packages/hook/bin/harness-hook"  ~/.local/bin/harness-hook
  which harness && which harness-hook && which claude   # all 3 should resolve
  ```
- A scratch directory you don't mind blowing away. Default:
  `$HOME/harness-dogfood-soak`. Override with `SOAK_DIR=...`.

The dogfood scripts also fall back to absolute monorepo paths if
nothing's on PATH (see `lib.sh`), but Claude Code itself can't —
it needs `harness-hook` resolvable when it spawns the hook from
`settings.json`. So linking is the better path.

**v0.3 cut from v0.2 data:** there is no automated migrator from
v0.2.x to v0.3.0 (spec/format.md §9.6). If you have a prior
`$SOAK_DIR/.harness/` from a v0.2 soak, `reset.sh` blows it away
deliberately — back it up first if you want a forensic record.

## Schedule overview

10 sessions, each scripted. Session N's script sets up state, prints
the suggested Claude prompt, you fire `claude --model
claude-haiku-4-5-20251001`, type the prompt, exit. The hook fires on
session start AND on every prompt within the session.

| # | Day | Mutation | What it tests |
|---|---|---|---|
| 01 | reset | fresh tmpdir, `git init`, `harness init`, `harness install-hook` (dual-event), baseline `.claude/` with 1 skill | empty repo → first `init` snapshot + `session_start` attribution |
| 02 | add-skill | new SKILL.md under `.claude/skills/test-runner/` | additive diff (one new skill); first `auto` snapshot; per-row diff summary in `harness log` shows `+1 skill` |
| 03 | modify-skill | edit existing SKILL.md, optional 2nd unchanged-composition session | configHash drift on existing module; **dedup** (Session 2 attribution-only); `~1 skill (notes)` summary |
| 04 | add-mcp | extend `settings.json` with mcpServers entry | mcp module capture path; `+1 mcp` summary |
| 05 | multi-add + tag-v0.1 + snap-with-note + resume probe | add CLAUDE.md + subagent + slash command, then `harness tag v0.1`, then `harness snap "<note>"`, then `claude --continue` | multi-change diff (`+1 instruction, +1 agent, +1 prompt`); tag-kind snapshot; **`note` attribution** captured against existing snapshot; **resume firing** (UserPromptSubmit AND a `session_start` with source=resume per §4.6) |
| 06 | branch experimental | `harness branch experimental && harness checkout experimental`, then modify a skill differently | branch divergence (no `fork` kind in v0.3 — it's an `auto` snapshot whose new branch ref defines the fork) |
| 07 | restore-main + noop + /clear + resume | manually restore main's composition (working around the v0.3 checkout footgun, see below), no mutations, fire claude with mid-session `/clear`, then later `claude --continue` | empty diff ("boring floor"); `/clear` produces a new session_id; resume produces user_prompt rows |
| 08 | remove-skill | delete the skill from session 02 | removal in diff (`-1 skill (test-runner)`) |
| 09 | bulk-add + multi-session probe | add 2 skills + 1 output-style + 1 command in one go, then 2-3 same-composition sessions | upper-end diff readability (`+2 skills, +1 prompt, +1 style`); **dedup at scale** (multiple sessions, one snapshot) |
| 10 | tag-v0.3 + final reflection + notes query | `harness tag v0.3`, then run `harness log --with-sessions`, `harness sessions`, `harness sessions <id>`, `harness notes <day-5-id>`, `harness diff` | the "stranger reading the lineage" test |

The architect's questions hinge on:
- **Day 03 Session 2** and **Day 09 Sessions 2-3**: dedup readability.
  Two sessions on the same composition should produce **one** snapshot
  and **two** trajectories that point at it. Verify with
  `harness log --with-sessions` (shows `[2 sessions]` next to a row).
- **Day 05 Session 2** and **Day 07 Session 2**: resume firing. After
  `claude --continue`, the resumed session has user_prompt rows and
  may also have a session_start row with `source=resume` (the v0.3
  spec §4.6 documents this; the v0.1-era "resume gap" was a
  measurement bug, not a host behavior gap).
- **Day 05 `harness snap "<note>"`**: an explicit user annotation
  attaches as a `note` attribution event. On unchanged composition
  this writes ZERO new snapshots — only the note row lands. Verify
  with `harness notes <ref>` (Q2: cross-session notes query).
- **Day 07 mid-session `/clear`**: a new session_id is minted; both
  sessions observe the same snapshot via attribution-only writes.
  Verifiable via `harness sessions` (both ids listed).
- **Day 10 final read**: does the lineage + trajectory tell a story?

### Known v0.3 footgun: `harness checkout` does not revert the working tree

This was caught in the v0.2 soak and rolled forward to v0.3.x as a
deferred patch. `harness checkout <branch>` only moves HEAD; the
working tree is left as-is. So if Day 6 leaves the working tree on
experimental's content and Day 7 does `harness checkout main`, the
next hook fire captures experimental's content under `branch=main`.
Day 7's script restores the main-branch test-runner content manually
to work around this — search for "FOOTGUN" in `07-noop-and-clear.sh`.
This is on the v0.4 candidate list (`harness checkout --apply` /
`harness reproduce`).

## How to run

### Reset / start fresh

```bash
bash scripts/dogfood/reset.sh
# Wipes $SOAK_DIR, recreates it with git init, harness init,
# baseline .claude/, and installs harness-hook (both SessionStart
# AND UserPromptSubmit entries). Prints next step.
```

### Each day

```bash
bash scripts/dogfood/02-add-skill.sh
# Mutates .claude/, prints:
#   Next:
#     cd $SOAK_DIR
#     claude --model claude-haiku-4-5-20251001
#     > <suggested prompt>
#     /exit
#   Then:
#     <any post-actions, e.g. harness tag v0.1>
```

The exact prompts to paste live in [`PROMPTS.md`](PROMPTS.md). Some
days have 2-3 sessions (e.g. an extra `claude --continue` to probe
the resume path). They're called out per-day there.

### Audit at the end

```bash
bash scripts/dogfood/audit.sh > soak-report.txt 2>&1
# Prints harness log, harness sessions summary, schema-agreement,
# format-version-bump check, canonical-501 byte-stability, snapshot
# count by kind, attribution event counts (including note rows),
# notes ever attached, and the gitignore-vs-tree audit. This is
# the "did anything quietly drift?" report.
```

## Within the Claude session

Keep prompts short — Haiku is fast and the goal is to fire the hooks,
not have a deep conversation. Every script suggests a prompt; full
list in [`PROMPTS.md`](PROMPTS.md). Type the prompt, let Haiku reply,
optionally one follow-up, then `/exit`. **Don't get into a long
session** — the goal is breadth across days, not depth in any one day.

A session-with-three-prompts produces:
- 1× `session_start` attribution (on launch; `source=startup`/`resume`/etc)
- 3× `user_prompt` attribution (one per prompt)
- 0 or 1 new snapshot (only if composition changed since the last fire
  in this session)

That ratio — many attributions, few snapshots — is the v0.3 norm.

## What to watch for

While you run the soak, keep a side notes file. Some prompts:

- **Lineage coherence (v0.3 should improve over v0.2's "(no message)"
  gap).** When you `harness log` after day 5, can you recover what
  you were doing on day 3 from the per-row diff summary alone?
  v0.3 renders `init` for root snapshots and `summarizeDiff` output
  for the rest (`+1 skill`, `~1 skill (notes)`, `+2 skills, +1 prompt,
  +1 style`, etc.) — computed at read time from
  `(parentIds[0].modules, current.modules)`. The v0.2 soak's top
  finding was that hook-driven snapshots showed `(no message)`; v0.3
  closes that gap. Check whether the summary feels sufficient
  standalone, or whether you still reach for `harness sessions <id>`.

- **Diff signal-to-noise.** Run `harness diff <day-2-id> <day-3-id>`.
  Does the output reflect that you only changed one SKILL.md, or
  is it cluttered with noise from configHashes that shouldn't have
  changed? If the latter — capture is too fine-grained.

- **Trajectory readability.** After day 09 (which fires 2-3 sessions
  on the same composition), run `harness sessions <id>` for one of
  them. The output should be a chronological list of
  `(time, eventKind, →/= snapshot, summary)` rows, with `→` markers
  when the snapshot id changes, `=` markers when it stays the same,
  and `@` markers for any `note` events you attached via `harness
  snap "<text>"`. If the trajectory is unreadable — flag it.

- **Dedup behavior.** After day 09, run `harness log --with-sessions`.
  The day-09 snapshot should show `[3 sessions]` (or however many you
  actually fired). The earlier composition snapshots should show 1
  session each. If a composition that you observed multiple times is
  showing as multiple snapshots — that's a §3.1 strip bug.

- **Resume firing.** After day 05 Session 2 (the `claude --continue`
  probe), run `harness sessions <session-id>`. The trajectory should
  include user_prompt rows from the resumed session. v0.3 §4.6 says
  the host DOES fire SessionStart on resume (`source=resume`); whether
  Claude Code actually does in your install is empirically what you
  observe. Either way the `user_prompt` rows are the load-bearing
  assertion. The v0.1-era "resume gap" framing — that resumed sessions
  produced no observable artifact — was a measurement bug; v0.3
  reframes it accordingly.

- **`/clear` behavior.** After day 07's mid-session `/clear`, run
  `harness sessions`. You should see two sessions listed (the original
  and the post-clear one). Each has its own trajectory. Whether `/clear`
  mints a new session_id is the answer Claude Code's own behavior
  determines; the v0.3 hook treats them as independent sessions either
  way. The shared composition means 1 snapshot, 2 trajectories.

- **Note attribution path.** After day 5 you'll have run `harness snap
  "<note>"` against the day-5 tag (unchanged composition). Run
  `harness notes <day-5-tag-id>` — it should surface the note text
  with `<manual>` as the session id. If the same snapshot ever
  receives more notes (across sessions), they all appear in this
  query. This is Q2 from spec/format.md §2.7.

- **Anything you reach for that doesn't exist.** Three days of
  unfiltered "I wish I could…" is the v0.4 roadmap.

## Resetting mid-soak

If a session goes off the rails:

```bash
bash scripts/dogfood/reset.sh   # back to day 1 baseline
```

Scripts are idempotent on baseline — re-running session 02 after a
reset gives you the day-2 state. You can replay individual days but
not skip ahead, since later days assume cumulative state.

## After the soak

Bring back to the next conversation:

1. **The "I wish I could…" list, unfiltered.**
2. **Surprises in `harness log` / `harness sessions <id>` / `harness
   diff` / `harness notes <ref>`** (good or bad).
3. **The audit results** — `bash scripts/dogfood/audit.sh > soak-report.txt`,
   share the file.
4. **Resume firing status:** what did Claude Code's host actually do
   on `--continue`? user_prompt rows? a session_start with
   `source=resume`? both? note the empirical observation against
   the §4.6 spec narrative.
5. **Dedup status:** confirmed (one snapshot, multiple trajectories)?
   or did you see snapshot inflation?
6. **Auto-summary readability:** did the `harness log` per-row summary
   close the v0.2 "(no message)" gap, or do you still reach for
   `harness sessions <id>` to make sense of the lineage?
