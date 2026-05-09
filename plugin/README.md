# `harness` — Claude Code plugin

Snapshot and reproduce your `.claude/` composition. Tracks every change
to skills, agents, settings.json, and APM-managed primitives via
content-addressable lineage. APM-driven reproducer with a subtractive
contract (spec/format.md §6.1). v0.5.0 adds session-metrics ingestion
with a strict privacy whitelist (§10.2).

This plugin is a thin orchestration layer on top of the
[`@harness/cli`](https://www.npmjs.com/package/@harness/cli) (the
`harness` and `harness-hook` binaries). The plugin removes the "user
must know what to type" friction by routing natural-language questions
to the right CLI verb via skills, subagents, and slash commands.

## Install

Two pieces, installed separately.

### 1. The CLI

```bash
npm install -g @harness/cli
```

Verify with `harness --help` and `harness-hook --version`. Both binaries
must be on `PATH` before the plugin's hooks can fire.

### 2. The plugin

**Local development:**

```bash
claude --plugin-dir /path/to/claude-snaps/plugin
```

Loads the plugin for that session only. Repeat the flag to layer
multiple plugins.

**Persistent (Claude Code marketplace, recommended):**

```
> /plugin install bantarus/harness
```

Distribution is currently `--plugin-dir`-only and Claude Code
marketplace; APM hybrid distribution is deferred (APM 0.8.x doesn't
deploy plugin-format primitives — see
[docs/plugin-kickoff-prompt.md "Probe 8"](../docs/plugin-kickoff-prompt.md)).
Re-evaluate when APM 0.9+ ships.

## Quick start

Open Claude Code in a project where `.harness/` exists:

```
> /harness:status
```

Returns a single-screen status report — HEAD, recent lineage, branches,
tags, working-tree divergence, backup count.

If the project doesn't have `.harness/` yet:

```bash
harness init
```

Then any prompt or session start fires `harness-hook` and records the
first snapshot.

## What ships

| Type | Name | Surface | Purpose |
|---|---|---|---|
| Skill | `harness-fundamentals` | `/harness:fundamentals` + auto-trigger | Format basics, content addressing, snapshots-vs-attribution, refs, source kinds, v0.5 privacy whitelist. |
| Skill | `harness-cli` | `/harness:cli` + auto-trigger | Per-command guide for every harness verb. |
| Skill | `harness-reproducer` | `/harness:reproducer` + auto-trigger | The §6.1 reproducer contract — pinned verbatim, load-bearing. |
| Skill | `harness-archeology` | `/harness:archeology` + auto-trigger | Query map: lineage and economics questions → harness commands. |
| Subagent | `harness-archeologist` | description-routed (haiku, read-only) | Multi-step lineage investigations; returns prose, keeps raw output out of main context. |
| Subagent | `harness-reproducer-pilot` | description-routed + `/harness:restore` (sonnet) | Dry-run → summarize → confirm → execute the reproduce flow. |
| Slash | `/harness:snap "<note>"` | user-only | Capture composition + attach a note. |
| Slash | `/harness:status` | user-only | Aggregate status (HEAD, lineage, refs, backups). |
| Slash | `/harness:trajectory <session-id>` | user-only | Chronological session timeline. |
| Slash | `/harness:explain <ref>` | user + auto | Plain-prose snapshot explanation. |
| Slash | `/harness:restore <ref>` | user-only | Wrapped reproduce via the pilot subagent. |
| Slash | `/harness:cost [<id>] [--all]` | user + auto (v0.5.0+) | Per-session or project-wide token cost. |

User-only commands (`disable-model-invocation: true`) won't be auto-
invoked by the model — the user types them directly. The other commands
and all skills are model-routable from natural-language questions.

## Permission grants — important caveat

The plugin's slash commands declare `allowed-tools: Bash(harness *)`
patterns to pre-approve harness command invocations. **In Claude Code
2.1.128 those frontmatter pattern grants are not honored** — the
permission gate still prompts. (See
[docs/plugin-kickoff-prompt.md "Probe 6"](../docs/plugin-kickoff-prompt.md)
for the full empirical finding; locked as drift detector L3.8.) Two
workarounds:

**One-shot (per-session):**

```bash
claude --allowed-tools Bash --plugin-dir /path/to/plugin
```

The bare `Bash` grant works at the CLI flag layer; the parenthesized
pattern form does not in 2.1.128.

**Persistent (per-project):**

Add to `.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["Bash(harness *)", "Bash(harness-hook *)"]
  }
}
```

Re-verify when upgrading Claude Code. The drift detector L3.8 will turn
red when the host fixes this; at that point the workarounds become
optional.

## Session metrics (v0.5.0+)

Two slash commands surface the v0.5 economics layer:

```
> /harness:cost <session-id>           # per-session breakdown
> /harness:cost --all --by-model       # project-wide, per-model totals
> /harness:cost --all --by-tool        # call counts per tool (NOT tokens)
```

Both run on top of the `harness ingest-session` and `harness
session-cost` CLI commands. The first time you ask about a session's
cost, the wrapper will suggest `harness ingest-session <id>` (or
`--all` to backfill every session with a transcript on disk) before
the cost query.

### Privacy whitelist (NORMATIVE — spec §10.2)

`harness ingest-session` reads the per-session JSONL transcript Claude
Code already writes and copies ONLY whitelisted fields to harness
storage:

| Stored | Not stored |
|---|---|
| session id, turn index, turn type | prompt text |
| model id, token counts (input/output/cache) | tool inputs |
| tool names (just names — never tool inputs) | tool results |
| sidechain flag, attribution skill, request id | system prompts, thinking blocks |
| | `last_assistant_message` (Stop event payload) |

The whitelist is locked by two test gates that run in CI:

- **W12.5** — `packages/core/test/privacy_fuzz.test.ts` injects random
  byte sequences into every forbidden field, ingests, then greps the
  raw `lineage.sqlite` bytes for those sequences. None must be found.
- **L2.6** — `scripts/dogfood-v0_4/local_cases/l2_session_metrics.sh`
  runs the same gate against a real `claude -p` session.

If a user asks "is harness reading my prompts," the
`harness-fundamentals` skill (auto-loaded) answers with the whitelist
+ gate citation. The answer is "no — by spec, by gate, by design."

### Per-tool token attribution is impossible

`/harness:cost --by-tool` reports **call counts only**. The JSONL
`usage` block is per-assistant-turn, not per-tool-call (§10.3). Don't
report estimated per-tool costs — the limitation is intentional and
the `harness-cli` skill surfaces it on every `--by-tool` invocation.

## Migration from `harness install-hook`

If a project already ran `harness install-hook` (writing the hook
config to `.claude/settings.json`) BEFORE installing this plugin, both
the project-level config AND the plugin's `hooks/hooks.json` define
`SessionStart` and `UserPromptSubmit`. **Both fire.** This is harmless
— the hook is idempotent on snapshot id (same composition → same
blob, dedup applies) — but produces duplicate attribution rows. You'll
see `[2 sessions]` instead of `[1 session]` per row in
`harness log --with-sessions` for sessions that fired through both.

To deduplicate, remove the harness entries from `.claude/settings.json`
after installing the plugin. The original config is at
`.claude/settings.json.harness-backup` (created by `install-hook`).

You don't need to migrate before installing the plugin. The
`harness-fundamentals` skill surfaces this only when relevant; the
plugin install itself is non-destructive.

## When to use which surface

- **Question about lineage history** ("what changed today", "when was
  X added", "show me session trajectories") → `harness-archeology`
  skill auto-loads; deep investigations route to the
  `harness-archeologist` subagent.
- **Question about session economics** ("how much did this cost",
  "what did I spend on Opus", "did I use Bash yesterday") →
  `harness-archeology` skill maps these to `/harness:cost` flags.
- **Want to restore a state** ("go back to v0.X", "reproduce that
  snapshot", "roll back .claude/") → `/harness:restore <ref>` invokes
  the `harness-reproducer-pilot` subagent (dry-run → confirm →
  execute).
- **Want a status snapshot** → `/harness:status`.
- **Want to mark a state with a note** → `/harness:snap "<note>"`.
- **Want a prose explanation of a specific snapshot** →
  `/harness:explain <ref>`.
- **Privacy/contract questions** ("is harness reading my prompts",
  "will my CLAUDE.md survive reproduce", "what does the §6.1 contract
  mean") → `harness-fundamentals` and `harness-reproducer` skills
  auto-load; route to them.

## Links

- [`spec/format.md`](../spec/format.md) — normative format spec
  (§6.1 reproducer contract, §10 session metrics, §10.2 privacy
  whitelist).
- [`spec/hooks.md`](../spec/hooks.md) — hook contract, including the
  v0.5 4-event inventory (SessionStart, UserPromptSubmit, Stop,
  SessionEnd).
- [`packages/cli/README.md`](../packages/cli/README.md) — CLI
  reference (current as of v0.5.0).
- [`docs/plugin-plan.md`](../docs/plugin-plan.md) — design rationale.
- [`docs/plugin-kickoff-prompt.md`](../docs/plugin-kickoff-prompt.md)
  — verified pins from the prospective probe pass (loader contract,
  drift detectors, host-version notes).
