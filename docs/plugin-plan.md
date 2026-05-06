# Plan: claude-snaps as a Claude Code plugin

## Goal

Make harness installable as a single user-facing unit: hook + skills +
subagents + slash commands. Today, harness is a CLI; users have to
know the commands, when to run them, and how to interpret the output.
The plugin moves that orchestration knowledge into Claude Code's
context surface so a user can ask "what changed in my .claude/
yesterday?" and Claude answers correctly without the user having to
remember `harness sessions` or `harness diff <id> HEAD`.

This is a v0.5 candidate, not v0.4.x. The CLI's contract is settled
under observation (v0.4.1); the plugin is the next user-facing
surface.

## Scope

- **In scope:** plugin authoring, skill design, subagent design,
  slash-command design, hook configuration that the plugin ships,
  distribution paths.
- **Out of scope:** changes to harness CLI behavior, format spec,
  reproducer contract. The plugin is a thin layer ON TOP of v0.4.1.

## The two pieces (and why they're separate)

```
┌──────────────────────────────────────────────────────────┐
│  CLI:  npm install -g @harness/cli                       │
│        Provides: harness, harness-hook binaries          │
│        Distribution: npm registry                        │
│  ───────────────────────────────────────────────────────┐│
│  Plugin: claude /plugin install bantarus/harness        ││
│          Provides: skills/agents/commands/hooks config  ││
│          Distribution: Claude marketplace + APM         ││
└──────────────────────────────────────────────────────────┘
              ↑ both required for full experience
```

The CLI is the implementation. The plugin is the AI orchestration
layer that knows when and how to invoke the CLI. They install
separately because:

- The CLI is a Node.js binary; plugins distribute config + markdown.
- The CLI may be useful without Claude Code (CI, scripts, automation).
- The plugin is useless without the CLI (every command shells out).

The plugin's hooks reference `harness-hook` on PATH. If the user
installs the plugin without the CLI, hooks fail with a clear error
("harness-hook not found on PATH; install @harness/cli to use this
plugin"). A startup skill (see §Skills) detects and reports this.

## Source layout

Author the plugin in **plugin format** (top-level `skills/`,
`agents/`, `commands/`, `hooks/`) with a sibling `apm.yml` so APM
treats it as a hybrid plugin and can publish to APM marketplaces too.

```
claude-snaps/                          # this monorepo
├── packages/
│   ├── core/                          # @harness/core (existing)
│   ├── cli/                           # @harness/cli (existing)
│   └── hook/                          # @harness/hook bin (existing)
├── plugin/                            # NEW: the Claude Code plugin
│   ├── .claude-plugin/
│   │   └── plugin.json                # plugin manifest
│   ├── apm.yml                        # APM hybrid manifest
│   ├── README.md                      # install + usage
│   ├── skills/
│   │   ├── harness-fundamentals/
│   │   │   └── SKILL.md
│   │   ├── harness-cli/
│   │   │   └── SKILL.md
│   │   ├── harness-reproducer/
│   │   │   └── SKILL.md
│   │   └── harness-archeology/
│   │       └── SKILL.md
│   ├── agents/
│   │   ├── harness-archeologist.md
│   │   └── harness-reproducer-pilot.md
│   ├── commands/
│   │   ├── harness-snap.md
│   │   ├── harness-status.md
│   │   ├── harness-trajectory.md
│   │   ├── harness-explain.md
│   │   └── harness-restore.md
│   └── hooks/
│       └── hooks.json
└── ...
```

The plugin lives under `plugin/` (not `packages/plugin/`) so the
install ref is `bantarus/claude-snaps/plugin` (APM virtual package
path) or simply the directory passed to `--plugin-dir` for local
testing. Versions track the harness format version: plugin.json's
`version` field bumps with the CLI's `formatVersion`.

## Plugin manifest (`plugin/.claude-plugin/plugin.json`)

```json
{
  "name": "harness",
  "description": "Snapshot and reproduce your .claude/ composition. Tracks every change to skills, agents, settings.json, and APM-managed primitives via content-addressable lineage. APM-driven reproducer with subtractive contract.",
  "version": "0.4.1",
  "author": {
    "name": "Bantarus"
  },
  "homepage": "https://github.com/bantarus/claude-snaps",
  "repository": "https://github.com/bantarus/claude-snaps"
}
```

Skills/agents/commands get the `harness:` namespace prefix. So users
type `/harness:snap "<note>"`, `/harness:status`, etc.

## Skills (4 to ship)

Skills in Claude Code are markdown files with YAML frontmatter that
load contextually based on `description` matching. Per the docs,
description + when_to_use is capped at 1,536 chars. Each skill earns
its keep against that budget.

### `harness-fundamentals`

```yaml
---
description: Explains what .harness/ is, how snapshots are content-addressable, what attribution events are, and the difference between branches/tags/refs. Use when the user asks "what is harness", "how does this lineage work", "what's a snapshot", or first encounters harness output without prior context.
disable-model-invocation: false
---
```

Body: 60-80 line explainer covering the .harness/ format's
load-bearing properties — content addressing, parent DAG, attribution
events, refs vs snapshots. Pulls from spec/format.md §1-§5 distilled
to "what a user actually needs to know."

**Why ship this:** without it, Claude has to reconstruct harness's
mental model from CLI output every session. With it, Claude knows the
vocabulary and can explain output coherently.

### `harness-cli`

```yaml
---
description: Reference for harness CLI commands (init, log, diff, snap, sessions, notes, tag, branch, checkout, reproduce, reindex, install-hook). Includes flags, exit codes, and ref resolution rules. Use whenever Claude needs to invoke a harness command, interpret its output, or explain what a command does.
allowed-tools: Bash(harness *) Bash(harness-hook *)
---
```

Body: command reference distilled from `packages/cli/README.md`. Each
command gets one paragraph: what it does, key flags, when to suggest
it. The `allowed-tools` field pre-approves harness invocations so
Claude doesn't pause for permission on every command.

**Why ship this:** CLI commands have non-obvious semantics (e.g.,
`harness checkout` doesn't restore files; `harness diff` shows
configHash deltas). Without the skill, Claude reinvents these
mappings every session.

### `harness-reproducer`

```yaml
---
description: The §6.1 reproducer contract. Use BEFORE running harness reproduce, when the user asks to "go back" or "restore" their .claude/, when divergence warning fires, or when the user is confused about why files reappeared/disappeared after reproduce. Covers APM-driven materialization, subtractive cleanup within scope, unconditional backup, and what local-source modules can/can't do.
disable-model-invocation: false
---
```

Body: the reproducer contract from spec/format.md §6.1, distilled.
The most load-bearing skill — the subtractive contract is subtle and
users will misunderstand without explicit framing. Includes:

- "Reproduce restores APM-managed and builtin paths to the snapshot's
  state. Local-source paths (your hand-written skills, settings.json
  hooks, CLAUDE.md) are NEVER touched."
- "Backup happens unconditionally at .claude.harness-backup-<ts>/.
  This is the safety net, not the absence of deletion."
- "If apm install fails, HEAD is NOT advanced and the backup is
  retained. You can recover by mv'ing the backup back."
- "configHash mismatches mean the captured state included a local
  edit on top of an APM file; the reproducer can recreate upstream
  but not 'upstream + your edit.' Choose: commit upstream via APM,
  or accept being snapped back."

**Why ship this:** the v0.4 observation playbook found C2 (hand-edit
+ reproduce → mismatch) is the most subtle case. A user without this
skill will see "✗ APM phase failed" and think the reproducer is
broken, when it's actually doing exactly the right thing. The skill
makes Claude carry the explanation.

### `harness-archeology`

```yaml
---
description: How to investigate past activity in .harness/. Covers reading the lineage, querying sessions, surfacing notes, identifying when a change was introduced, and explaining "why does my .claude/ look like this." Use when the user asks "what changed when", "who introduced this", "when did this happen", or any retrospective question about .claude/ evolution.
allowed-tools: Bash(harness log *) Bash(harness diff *) Bash(harness sessions *) Bash(harness notes *)
---
```

Body: a query playbook. "User asks 'what changed today' → run
`harness log --limit 20` and filter by today's date." "User asks 'why
is X here' → `harness sessions <id>` to find when X was added, then
`harness diff <parent> <id>` to confirm." "User asks 'do I have
notes on this' → `harness notes <ref>`."

**Why ship this:** without this skill, Claude tends to reach for
`grep` or `find` when the right answer is a `harness` command. The
skill teaches the mapping.

## Subagents (2 to ship)

Subagents run in an isolated context window with restricted tools.
Plugin subagents lose `hooks`, `mcpServers`, and `permissionMode`
(security restriction); we work around this.

### `harness-archeologist`

```yaml
---
name: harness-archeologist
description: Use proactively when the user wants a retrospective explanation of .claude/ changes — "what changed", "when was X added", "trace this skill's history". The agent reads harness log, traces the relevant lineage, and returns a concise narrative without flooding the main conversation with raw command output.
tools: Read, Bash(harness log *), Bash(harness diff *), Bash(harness sessions *), Bash(harness notes *), Bash(git log *), Bash(cat *)
model: haiku
---

You are a harness lineage archeologist. The user wants to understand
what happened in their .claude/ over time. You answer by reading
harness's lineage: snapshots, attribution events, notes, and codePin
git refs.

[full system prompt: walks through the investigation pattern,
emphasizes returning a short narrative not a raw dump]
```

**Why ship this:** lineage investigation can flood context with raw
output (50+ snapshots × per-row diff summaries × session counts).
Doing this in a subagent keeps the main conversation focused on the
question + answer, not the trail.

### `harness-reproducer-pilot`

```yaml
---
name: harness-reproducer-pilot
description: Use when the user wants to run harness reproduce and the situation has nuance — they're on a non-APM project, there are local edits to APM files, the target is an ancestor with composition changes, or HEAD is detached. The agent walks through the contract, runs --dry-run first, summarizes implications, and only then executes if the user confirms.
tools: Read, Bash(harness reproduce *), Bash(harness log *), Bash(harness diff *), Bash(harness checkout *), Bash(ls *), Bash(cat *)
model: sonnet
---

You are the harness reproducer pilot. The §6.1 contract is subtle:
APM-driven, subtractive within scope, unconditional backup,
local-source untouched. Walk the user through the implications of
their reproduce request before executing.

[full system prompt: the contract pinned, the workflow (dry-run →
explain → confirm → execute), explicit handling of the C2 hand-edit
case]
```

**Why ship this:** reproduce is the operation with the most
contract-vs-expectation gap. A pilot subagent forces the
"explain-before-execute" pattern that the v0.4 observation showed is
needed for non-trivial reproduces.

## Slash commands (5 to ship)

Slash commands in Claude Code are skills with `disable-model-
invocation` typically set, designed for explicit user invocation.
They take `$ARGUMENTS` for parameters.

### `/harness:snap "<note>"`

```yaml
---
description: Capture current .claude/ composition with a note.
disable-model-invocation: true
allowed-tools: Bash(harness snap *)
argument-hint: "<note>"
---

Run `harness snap "$ARGUMENTS"` and report the captured snapshot id
and any deduplication info.
```

### `/harness:status`

```yaml
---
description: Aggregate view: HEAD state, recent lineage, working-tree divergence flag, current branch.
disable-model-invocation: true
allowed-tools: Bash(harness log *), Bash(harness checkout *)
---

Show:
1. Current HEAD (resolved id + symbolic ref or detached marker)
2. Last 5 snapshots with summaries
3. Branch / tag refs
4. Working-tree divergence (run `harness checkout main` and parse
   the divergence warning, OR compare canonical id of working tree
   to HEAD's id without changing HEAD)
5. Backup directory count + total size

Format as a single-screen status report.
```

### `/harness:trajectory <session-id>`

```yaml
---
description: Show the full trajectory of a session — snapshots observed, notes attached, hook fires.
disable-model-invocation: true
allowed-tools: Bash(harness sessions *)
argument-hint: "<session-id>"
---

Run `harness sessions $ARGUMENTS` and format as a timeline.
```

### `/harness:explain <ref>`

```yaml
---
description: Plain-prose explanation of a snapshot — what it captures, what changed vs parent, who observed it, what notes are attached.
allowed-tools: Bash(harness log *), Bash(harness diff *), Bash(harness notes *), Bash(harness sessions *)
argument-hint: "<ref>"
---

Resolve $ARGUMENTS to a snapshot id, then narrate:
- When captured (createdAt + git codePin)
- What changed vs parent (diff summary)
- Who observed it (sessions list)
- Any notes attached (notes list)
- Whether HEAD is currently at it

Output is prose, not raw output.
```

### `/harness:restore <ref>`

```yaml
---
description: Reproduce wrapper — runs --dry-run first, summarizes implications, asks for confirmation, then executes. Safer than harness reproduce direct.
disable-model-invocation: true
allowed-tools: Bash(harness reproduce *), Bash(harness diff *), Bash(harness log *)
argument-hint: "<ref>"
---

This is the user-facing safe wrapper for harness reproduce.

1. Run `harness reproduce $ARGUMENTS --dry-run` and parse the output.
2. Summarize what would happen:
   - How many APM modules would be installed?
   - How many paths would be removed?
   - Would apm.lock.yaml be removed?
   - How many local-source modules will NOT be reproduced?
3. If any of these are non-trivial (paths > 0 or lockfile removal),
   explicitly ask the user to confirm before proceeding.
4. On confirmation, run `harness reproduce $ARGUMENTS` (no dry-run).
5. Report the result + backup path.
```

## Hooks (`plugin/hooks/hooks.json`)

Reference the existing `harness-hook` binary which `@harness/cli`
installs on PATH:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "harness-hook" }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "harness-hook" }
        ]
      }
    ]
  }
}
```

The hook is a no-op when there's no `.harness/` in the cwd's ancestry
(safe to enable globally). When `.harness/` exists, the hook fires
the v0.3 observe path.

This replaces `harness install-hook` for plugin users — the plugin's
hooks.json IS the install. Existing users who already ran
install-hook will have duplicate entries; the migration story:
- Detect duplicate config on plugin enable (a startup skill could
  read `.claude/settings.json` and warn).
- Document removal of the project-level entries from settings.json.

## Distribution paths

### Path A: APM marketplace (preferred; dogfoods harness's APM integration)

```bash
apm install bantarus/claude-snaps/plugin
```

APM clones the repo, navigates to `plugin/`, treats it as an APM
package (synthesizes apm.yml from plugin.json or reads the explicit
apm.yml), deploys files into `.claude/`. The plugin shows up under
the user's `.claude/skills/`, `.claude/agents/`, `.claude/commands/`
namespaces. Hooks merge into `.claude/settings.json`.

This dogfoods harness's own APM integration: the plugin is APM-
managed, so users see it in `harness log` as an apm-source module.
Reproducing a snapshot that included the plugin restores the plugin
via APM. Beautiful loop.

### Path B: Claude Code marketplace (when ready)

Submit via `claude.ai/settings/plugins/submit`. Once listed, users
install with `/plugin install bantarus/harness` (or whatever the
marketplace assigns). No APM dependency for the user. Easier
discovery; doesn't dogfood.

### Path C: Local development (`--plugin-dir`)

```bash
claude --plugin-dir ./plugin
```

For testing during development. The plugin loads directly from the
local directory; `/reload-plugins` picks up edits live.

**Order of distribution:** Path C first (local dev). Path A second
(APM, immediately after authoring is done — same monorepo, low
overhead). Path B third (Claude marketplace, after the plugin has
been used in real workflows for a few weeks and rough edges sand
down).

## CLI install (`@harness/cli` on npm)

```bash
npm install -g @harness/cli
```

Publishes the CLI binaries (`harness`, `harness-hook`) to a public
npm package. This is the implementation. The plugin assumes it's
installed; the plugin's first-use experience checks PATH and surfaces
an actionable error if not.

The plugin and the CLI version together but ship separately. A user
on plugin v0.4.1 needs CLI v0.4.x. Plugin manifest pins the minimum
CLI version (we'd need to add a CLI-version probe to the plugin's
startup skill, since plugin.json has no `peerDependencies` field per
the docs I read).

## Order of operations

1. **Author the plugin shell** (no skills/agents yet) — `plugin/`
   directory, `plugin.json`, empty `skills/agents/commands/` dirs,
   `hooks/hooks.json`. Test with `claude --plugin-dir ./plugin` —
   verify the plugin loads and the hooks fire.
2. **Add hooks reference** — `hooks/hooks.json` pointing at
   `harness-hook`. Test on the v0.4 observation repo: enable plugin,
   uninstall the project-level hook, verify SessionStart still fires
   via the plugin path.
3. **Author skills (one at a time, smallest first):**
   - `harness-fundamentals` — pure reference, no tools needed.
   - `harness-cli` — reference + `allowed-tools` for harness commands.
   - `harness-reproducer` — the load-bearing one; pin every contract
     point.
   - `harness-archeology` — query playbook + tools.
   Test each by asking Claude representative questions and watching
   which skills load.
4. **Author subagents:**
   - `harness-archeologist` — start with read-only tools.
   - `harness-reproducer-pilot` — runs reproduce; sonnet model.
   Test by triggering the descriptions ("show me what changed last
   week" should route to archeologist; "reproduce v0.1" should route
   to pilot).
5. **Author slash commands:** all five, each tested individually.
   `/harness:restore` is the most complex (multi-step, dry-run +
   confirm); leave for last.
6. **Add `apm.yml`** alongside `plugin.json` for hybrid distribution.
   Test `apm install` from a local path against a fresh project.
7. **Publish CLI to npm** as `@harness/cli`. Reserve the namespace
   first; publish to verify install works from a clean machine.
8. **Document the install flow** in plugin's README.md and the
   project root README.md.
9. **Submit to Claude marketplace** when the plugin has been used in
   real workflows for ≥2 weeks without major issues. Optional;
   APM-only is a valid endpoint.

## Open questions

These are the unknowns I want to surface before starting work:

1. **Plugin-CLI version coupling.** plugin.json has no
   `peerDependencies` or `requires` field per the docs I fetched. A
   plugin shipping `harness:` skills assumes a specific CLI version
   on PATH. How do we detect mismatch? Options:
   - (a) A startup skill that runs `harness --version` and warns if
     not matching plugin.json's version.
   - (b) Embed the version-check in `harness-hook` (it could write a
     warning to `.harness/` log on first fire).
   - (c) Document, don't enforce. Lean on the user to keep them
     synced.

2. **Migration for users who already ran `harness install-hook`.**
   They'll have project-level settings.json hooks AND the plugin's
   global hook → duplicate fires. The hook is idempotent on the
   composite key, so duplicate fires don't cause new snapshots, just
   2× attribution rows. Mostly harmless. But the user's
   settings.json still shows hook config that's now redundant. Do
   we:
   - (a) Add a `harness install-hook --uninstall` command to remove
     the project-level entries.
   - (b) Have the plugin's startup skill detect + warn.
   - (c) Document and let users `git revert` if they care.

3. **The plugin's namespace name.** `harness:` is concise but the
   plugin is `bantarus/claude-snaps`. If we go to the official
   marketplace, the listed name might force a specific namespace
   (usually the plugin name). I'd prefer `harness:` — short, matches
   the CLI binary. We may have to negotiate this with the
   marketplace.

4. **Subagent restrictions impact.** Plugin subagents can't define
   `hooks`, `mcpServers`, or `permissionMode`. Our subagents don't
   need these (they're CLI-driven), but worth flagging that we can't
   use those fields if we want plugin-distribution.

5. **Where the playbook lives.** The v0.4 observation playbook at
   `scripts/dogfood-v0_4/PLAYBOOK.md` is project-internal. Should
   the plugin ship a user-facing variant ("harness onboarding tour")
   as a slash command or skill? Probably yes for v0.5.x, separate
   work.

6. **Auto-install hint.** Per the docs, "you can have your own CLI
   prompt Claude Code users to install it" via the
   `/en/plugin-hints` API. If we add this to the harness CLI ("you're
   using harness in Claude Code; install the plugin with
   /plugin install harness"), users discover the plugin without us
   pushing a marketing channel. Worth doing once the plugin is on
   the marketplace.

## What this plan does NOT cover

- **Multi-tool primitives** (chatmodes, instruction files,
  output-styles). The harness CLI doesn't need any of these as
  plugin output. If we later want a `harness-archeologist` chatmode
  (different from the subagent), that's separate.
- **MCP server.** A `harness-mcp` server that exposed harness as MCP
  tools (instead of via Bash) would let Claude call harness without
  shell injection risk + with structured output. Genuine value, but
  bigger scope. v0.6 candidate.
- **Plugin hot-reload during CLI changes.** When the user upgrades
  `@harness/cli`, the plugin doesn't auto-detect. Documenting +
  `/reload-plugins` is the workaround.

## Estimated effort

Closer to v0.3.1's "spec coherence cleanup" than to v0.4.0's
"reproducer foundation." Authoring is mostly markdown — the
implementation is the harness CLI, which already exists. Per-step:

- Plugin shell + hooks: ~half a day
- 4 skills: ~2 days (the reproducer skill is the biggest)
- 2 subagents: ~1 day
- 5 slash commands: ~1 day
- APM hybrid manifest + local install testing: ~half a day
- npm publish (CLI): ~half a day (including verification)
- README + migration docs: ~half a day

Total: ~6 days of focused work, spread across as many sessions as
needed. The plan is intentionally factored so each step is testable
in isolation; we can pause anywhere.

## What success looks like

After installation, a user opens Claude Code in a project with a
`.harness/` directory. Without prompting:

- Hook fires on session start; harness records the SessionStart.
- User asks "what changed in this project today?" → Claude routes
  to the archeology skill, runs `harness log` filtered by date,
  returns prose.
- User says "go back to v0.3 state" → Claude routes to the reproducer
  pilot subagent, dry-runs first, explains "this will remove the
  apm-test skill and the apm.lock.yaml; local-source files like your
  CLAUDE.md won't be touched", asks for confirmation.
- User confirms; pilot executes; reports outcome with backup path.

That's the experience. The harness CLI was already capable of all of
this; the plugin just removes the "user must know what to type"
friction.
