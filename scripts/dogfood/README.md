# Dogfood soak — scripted 2-week scenario

Drive a synthetic-but-real soak of the harness-snaps system end-to-end.
The scripts mutate `.claude/` between sessions; you launch Claude Code
with the cheap Haiku model, do a brief interaction, exit; the hook
fires at session start and snapshots whatever state the script just set
up. After 10 sessions you have a rich, varied lineage to inspect.

## Why this exists

The architect's three observation goals from the post-revert handoff:

1. **Does the lineage tell a coherent story?** Reading `harness log`
   like a stranger after the soak — do the snapshot messages mean
   anything? Do the parent chains match what you remember doing?
2. **Are the diffs informative?** Pick two snapshots, run
   `harness diff`. Some scenarios in this script are deliberately
   no-change (tests "boring diff" floor) and some are 5-thing-at-once
   (tests "is the diff still readable?" ceiling).
3. **What features are missing?** The "I wish I could…" list. Keep
   notes throughout. Three days of those is the prompt-D-and-beyond
   roadmap.

## Cost

Each session is one Claude Haiku interaction with a brief prompt.
10 sessions × ~1 turn × Haiku ≈ well under $1 total. The scripts use
the cheapest configuration on purpose.

## Prerequisites

- `harness` and `harness-hook` on `$PATH`. Two ways:
  - **Symlink to `~/.local/bin/`** (recommended — persistent, simple):
    ```bash
    mkdir -p ~/.local/bin
    ln -sf "$PWD/packages/cli/bin/harness"        ~/.local/bin/harness
    ln -sf "$PWD/packages/hook/bin/harness-hook"  ~/.local/bin/harness-hook
    ```
    `~/.local/bin` is already on PATH on most setups (XDG default).
    This works for `claude` too — it spawns the hook by bare name
    via PATH lookup.
  - Or `pnpm link --global` if you've run `pnpm setup` (less reliable
    across shell restarts; PNPM_HOME has to be in the rc file).
- `claude` CLI installed and authenticated.
- A scratch directory you don't mind blowing away. Default:
  `$HOME/harness-dogfood-soak`. Override with `SOAK_DIR=...`.

```bash
which harness && which harness-hook && which claude   # all 3 should resolve
```

The dogfood scripts also fall back to absolute monorepo paths if
nothing's on PATH (see `lib.sh`), but Claude Code itself can't —
it needs `harness-hook` resolvable when it spawns the hook from
`settings.json`. So linking is the better path.

## Schedule overview

10 sessions, each scripted. Session N's script sets up state, prints
the suggested Claude prompt, you fire `claude --model haiku-4-5-20251001`,
type the prompt, exit. The hook fires on session start and snapshots.

| # | Day | Mutation | What it tests |
|---|---|---|---|
| 01 | reset | fresh tmpdir, `git init`, `harness init`, `harness install-hook`, baseline `.claude/` with 1 skill + 1 hook | empty repo → first auto/init snapshot |
| 02 | add-skill | new SKILL.md under `.claude/skills/test-runner/` | additive diff (one new skill) |
| 03 | modify-skill | edit existing SKILL.md | configHash drift on an existing module |
| 04 | add-mcp | extend `settings.json` with mcpServers entry | mcp module capture path |
| 05 | multi-add + tag-v0.1 | add CLAUDE.md + subagent + slash command in one go, then `harness tag v0.1` | multi-change diff (5 things at once); tag-kind snapshot |
| 06 | fork-experimental | `harness branch experimental && harness checkout experimental`, then modify a skill differently | fork-kind snapshot; divergent branch |
| 07 | noop on main | `harness checkout main`, no mutations, fire claude, mid-session `/clear` | no-change diff (the "boring floor"); /clear behavior probe |
| 08 | remove-skill | delete the skill from session 02 | removal in diff (-skill) |
| 09 | bulk-add | add 2 skills + 1 output-style + 1 command in one go | upper-end diff readability; module count growth |
| 10 | tag-v0.2 + final reflection | `harness tag v0.2`, then run `harness log` / `harness sessions` / `harness diff` to inspect | the "stranger reading the lineage" test |

Sessions 5, 7, and 10 are the ones the architect's questions hinge on:
multi-add (informative diff?), no-change (empty diff?), final read (does
it tell a story?).

## How to run

### Reset / start fresh

```bash
bash scripts/dogfood/reset.sh
# Wipes $SOAK_DIR, recreates it with git init, harness init,
# baseline .claude/, and installs harness-hook. Prints next step.
```

### Each day

```bash
bash scripts/dogfood/02-add-skill.sh
# Mutates .claude/, prints:
#   Next:
#     cd $SOAK_DIR
#     claude --model haiku-4-5-20251001
#     > <suggested prompt>
#     /exit
#   Then:
#     <any post-actions, e.g. harness tag v0.1>
```

### Audit at the end

```bash
bash scripts/dogfood/audit.sh
# Prints harness log, schema-agreement, format-version-bump check,
# canonical-501 byte-stability, snapshot count, branch tips, etc.
# This is the "did anything quietly drift?" report.
```

## Within the Claude session

Keep prompts short — Haiku is fast and the goal is to fire the hook,
not have a deep conversation. Every script suggests a prompt. They
look like:

> "what skills are configured in this project?"
>
> "show me the SKILL.md for test-runner"
>
> "summarize what changed since the last snapshot — run `harness log`"

Type the prompt, let Haiku reply, then `/exit`. **Don't get into a
long session** — the goal is breadth across days, not depth in any
one day.

## What to watch for

While you run the soak, keep a side notes file. Some prompts:

- **lineage coherence.** When you `harness log` after day 5, can you
  recover what you were doing on day 3 from the snapshot message
  alone? Or is everything `auto · session ab12cd34` and useless? If
  the latter — that's a real v0.2 feature gap (snapshot message
  extraction from session activity).

- **diff signal-to-noise.** Run `harness diff <day-2-id> <day-3-id>`.
  Does the output reflect that you only changed one SKILL.md, or
  is it cluttered with noise from configHashes that shouldn't have
  changed? If the latter — capture is too fine-grained.

- **session_id behavior.** After day 7's `/clear`, look at the
  resulting JSONL: did Claude Code generate a new session_id, or
  reuse the previous one? The harness hook's idempotency depends on
  the answer. The CONTRIBUTING.md JSONL hook-audit recipe is the
  surgical instrument for this.

- **CLI ergonomics.** From $SOAK_DIR run `harness log`,
  `harness log --with-sessions`, `harness sessions`,
  `harness sessions <id>`, and `harness diff <a> <b>` against various
  snapshots. Note specifically: log readability with 10 snapshots,
  whether trajectory output for a multi-fire session reads as a
  coherent story or as noise, and how the dedup behavior surfaces
  when several sessions share a composition.

- **anything you reach for that doesn't exist.** This is the most
  valuable observation. Three days of unfiltered "I wish I could…"
  is the roadmap.

## Resetting mid-soak

If a session goes off the rails (Claude Code crashes, you accidentally
edit something the script will manage, etc.):

```bash
bash scripts/dogfood/reset.sh   # back to day 1 baseline
```

The scripts are idempotent on baseline — re-running session 02 after a
reset gives you the day-2 state. You can replay individual days but
not skip ahead, since later days assume the cumulative state.

## After the soak

Bring back to the next conversation:

1. **The "I wish I could…" list, unfiltered.**
2. **Surprises in `harness log` / `harness diff`** (good or bad).
3. **The audit results** — `bash scripts/dogfood/audit.sh > soak-report.txt`,
   share the file.

Then prompt D, on a foundation re-validated by real use.
