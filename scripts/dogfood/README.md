# Dogfood soak — scripted 2-week scenario (v0.2)

Drive a synthetic-but-real soak of the harness-snaps system end-to-end.
The scripts mutate `.claude/` between sessions; you launch Claude Code
with the cheap Haiku model, do a brief interaction, exit; the hook
fires on **`SessionStart` AND every `UserPromptSubmit`** and records
attribution events (and snapshots, when composition changed). After 10
sessions you have a rich, varied lineage to inspect, plus rich
trajectories per session.

## Why this exists

Three observation goals:

1. **Does the lineage tell a coherent story?** Reading `harness log`
   like a stranger after the soak — do the snapshot kinds and parent
   chains match what you remember doing? Is the `harness sessions <id>`
   trajectory output a coherent narrative or noise?
2. **Are the diffs informative?** Pick two snapshots, run
   `harness diff`. Some scenarios are deliberately no-change (tests
   "boring diff" floor), some are 5-thing-at-once (tests "is the diff
   still readable?" ceiling).
3. **Did the v0.2 contract land?** Specifically: (a) `claude --continue`
   produces `user_prompt` attribution rows even though SessionStart
   didn't fire (the resume gap is closed); (b) sessions sharing a
   composition share a snapshot id (dedup); (c) `/clear` produces a
   new session that observes the same snapshot via attribution-only.
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

## Schedule overview

10 sessions, each scripted. Session N's script sets up state, prints
the suggested Claude prompt, you fire `claude --model
claude-haiku-4-5-20251001`, type the prompt, exit. The hook fires on
session start AND on every prompt within the session.

| # | Day | Mutation | What it tests |
|---|---|---|---|
| 01 | reset | fresh tmpdir, `git init`, `harness init`, `harness install-hook` (dual-event), baseline `.claude/` with 1 skill | empty repo → first `init` snapshot + `session_start` attribution |
| 02 | add-skill | new SKILL.md under `.claude/skills/test-runner/` | additive diff (one new skill); first `manual` snapshot |
| 03 | modify-skill | edit existing SKILL.md, optional 2nd unchanged-composition session | configHash drift on existing module; **dedup** (Session 2 attribution-only) |
| 04 | add-mcp | extend `settings.json` with mcpServers entry | mcp module capture path |
| 05 | multi-add + tag-v0.1 + resume probe | add CLAUDE.md + subagent + slash command, then `harness tag v0.1`, then `claude --continue` | multi-change diff; tag-kind snapshot; **resume-gap closure** (UserPromptSubmit fires on continue) |
| 06 | branch experimental | `harness branch experimental && harness checkout experimental`, then modify a skill differently | branch divergence (no `fork` kind in v0.2 — it's a `manual` on a new branch) |
| 07 | noop on main + /clear + resume | `harness checkout main`, no mutations, fire claude with mid-session `/clear`, then later `claude --continue` | empty diff ("boring floor"); `/clear` produces a new session_id; resume produces user_prompt rows |
| 08 | remove-skill | delete the skill from session 02 | removal in diff (−skill) |
| 09 | bulk-add + multi-session probe | add 2 skills + 1 output-style + 1 command in one go, then 2-3 same-composition sessions | upper-end diff readability; **dedup at scale** (multiple sessions, one snapshot) |
| 10 | tag-v0.2 + final reflection | `harness tag v0.2`, then run `harness log --with-sessions`, `harness sessions`, `harness sessions <id>`, `harness diff` | the "stranger reading the lineage" test |

The architect's questions hinge on:
- **Day 03 Session 2** and **Day 09 Sessions 2-3**: dedup readability.
  Two sessions on the same composition should produce **one** snapshot
  and **two** trajectories that point at it. Verify with
  `harness log --with-sessions` (shows `[2 sessions]` next to a row).
- **Day 05 Session 2** and **Day 07 Session 2**: resume gap. After
  `claude --continue`, the resumed session has no `session_start`
  attribution but accumulates `user_prompt` rows starting from the
  first prompt. This is the v0.2 closure of the original soak finding.
- **Day 07 mid-session `/clear`**: a new session_id is minted; both
  sessions observe the same snapshot via attribution-only writes.
  Verifiable via `harness sessions` (both ids listed).
- **Day 10 final read**: does the lineage + trajectory tell a story?

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
# count by kind, attribution event counts, and the gitignore-vs-tree
# audit. This is the "did anything quietly drift?" report.
```

## Within the Claude session

Keep prompts short — Haiku is fast and the goal is to fire the hooks,
not have a deep conversation. Every script suggests a prompt; full
list in [`PROMPTS.md`](PROMPTS.md). Type the prompt, let Haiku reply,
optionally one follow-up, then `/exit`. **Don't get into a long
session** — the goal is breadth across days, not depth in any one day.

A session-with-three-prompts produces:
- 1× `session_start` attribution (on launch)
- 3× `user_prompt` attribution (one per prompt)
- 0 or 1 new snapshot (only if composition changed since the last fire
  in this session)

That ratio — many attributions, few snapshots — is the v0.2 norm.

## What to watch for

While you run the soak, keep a side notes file. Some prompts:

- **Lineage coherence.** When you `harness log` after day 5, can you
  recover what you were doing on day 3 from the snapshot kind and
  branch alone? In v0.2, hook-driven snapshots have **null messages**
  (you'll see `(no message)` in `harness log`); only manual `harness
  snap -m "..."` and tag operations carry text. Is that enough? Or
  does the lineage need `harness sessions <id>` to make sense? If the
  latter — that's the right answer; the trajectory IS the readable
  view. If even with sessions output it's noisy — feature gap.

- **Diff signal-to-noise.** Run `harness diff <day-2-id> <day-3-id>`.
  Does the output reflect that you only changed one SKILL.md, or
  is it cluttered with noise from configHashes that shouldn't have
  changed? If the latter — capture is too fine-grained.

- **Trajectory readability.** After day 09 (which fires 2-3 sessions
  on the same composition), run `harness sessions <id>` for one of
  them. The output should be a chronological list of
  `(time, eventKind, →snapshot, message)` rows, with `→` markers when
  the snapshot id changes and `=` markers when it stays the same.
  If the trajectory is unreadable — flag it.

- **Dedup behavior.** After day 09, run `harness log --with-sessions`.
  The day-09 snapshot should show `[3 sessions]` (or however many you
  actually fired). The earlier composition snapshots should show 1
  session each. If a composition that you observed multiple times is
  showing as multiple snapshots — that's a §3.1 strip bug.

- **Resume gap closure.** After day 05 Session 2 (the `claude
  --continue` probe), run `harness sessions <session-id>`. The
  trajectory should show:
  - **No** `session_start` row (resumed sessions skip SessionStart).
  - One or more `user_prompt` rows from the resumed session.
  This is the v0.2 fix for the original soak finding. Confirm.

- **`/clear` behavior.** After day 07's mid-session `/clear`, run
  `harness sessions`. You should see two sessions listed (the original
  and the post-clear one). Each has its own trajectory. Whether `/clear`
  mints a new session_id is the answer Claude Code's own behavior
  determines; the v0.2 hook treats them as independent sessions either
  way. The shared composition means 1 snapshot, 2 trajectories.

- **Anything you reach for that doesn't exist.** Three days of
  unfiltered "I wish I could…" is the v0.3 roadmap.

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
   diff`** (good or bad).
3. **The audit results** — `bash scripts/dogfood/audit.sh > soak-report.txt`,
   share the file.
4. **Resume-gap status:** confirmed closed (user_prompt rows on
   `--continue`)? or still buggy?
5. **Dedup status:** confirmed (one snapshot, multiple trajectories)?
   or did you see snapshot inflation?
