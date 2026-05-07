# Implementation prompt: claude-snaps Claude Code plugin (v0.5)

> Hand this to a fresh Claude Code session against this monorepo. The
> session has no prior context; everything load-bearing is captured here
> or in [`docs/plugin-plan.md`](plugin-plan.md).

## Goal

Implement the Claude Code plugin distribution of harness, on top of
the v0.4.1 CLI. Authoring happens at `plugin/` in this monorepo. The
plugin packages 4 skills, 2 subagents, 5 slash commands, and a hooks
config that lets users install harness as a single Claude Code unit
without touching `harness install-hook` or memorizing the CLI.

This is v0.5-shape work. The CLI is finished and stable (v0.4.1);
this prompt does NOT modify CLI behavior, format spec, or the
reproducer contract. The plugin is a thin orchestration layer ON TOP
of v0.4.1.

## Hard pins (do NOT relitigate)

These are settled in [`docs/plugin-plan.md`](plugin-plan.md) and the
v0.5 design conversation. Implementation respects them; surface them
in code/docs rather than re-arguing.

1. **Two-piece distribution.** CLI via npm (`@harness/cli`); plugin
   via Claude Code marketplace + APM. They install separately. The
   plugin's hooks reference `harness-hook` on PATH and assume the CLI
   is installed.
2. **Plugin format** (top-level `skills/`, `agents/`, `commands/`,
   `hooks/` + `.claude-plugin/plugin.json`), NOT APM source format
   (`.apm/`). Add sibling `apm.yml` for hybrid distribution.
3. **Plugin location.** `plugin/` at monorepo root (NOT
   `packages/plugin/`). Install ref is `bantarus/claude-snaps/plugin`
   (APM virtual package path) or absolute path for local testing.
4. **Plugin name = `harness`.** Slash commands are `/harness:snap`,
   `/harness:status`, etc. Skills get the same namespace prefix when
   user-invocable.
5. **Skill / subagent / command inventory frozen.** Four skills, two
   subagents, five slash commands per the plan doc §"Skills",
   §"Subagents", §"Slash commands". Don't add, don't remove. Names
   and descriptions from the plan are the contract.
6. **Hook config replaces project-level install-hook.** The plugin's
   `hooks/hooks.json` IS the install. `harness install-hook` becomes
   the legacy path for non-plugin users (still supported, not
   advertised).
7. **No CLI binary in the plugin.** The plugin's `bin/` is empty.
   Users install the CLI via npm separately.
8. **Distribution order.** `--plugin-dir` (local dev) → APM (dogfood)
   → Claude Code marketplace. Don't skip ahead to marketplace
   submission until the plugin has been used in real workflows for
   ≥2 weeks post-APM-publish.

## The success criterion

After this work lands, the following workflow must work end-to-end
on a fresh Linux/macOS machine. This is the contract made manifest;
if it produces output of this shape, the prompt succeeded.

```bash
# One-time setup
$ npm install -g @harness/cli
$ claude --plugin-dir /path/to/claude-snaps/plugin

# In Claude Code
> what's the current state of my .claude/?

# Expected: Claude routes to harness-archeology skill, runs:
#   harness log --limit 5
#   harness checkout <current-ref>  # for divergence check
# Returns prose summary of recent lineage, current HEAD, divergence.

> /harness:restore v0.1
# Expected: harness-reproducer-pilot subagent activates.
# Pilot runs `harness reproduce v0.1 --dry-run`, parses output,
# explains:
#   "This will reproduce snapshot 6f8728b4 (tagged v0.1).
#    APM phase will be skipped (no apmLockfile recorded).
#    1 path will be removed: .claude/skills/apm-test
#    2 local-source modules will NOT be reproduced; they remain as-is.
#    Working tree will be backed up first.
#    Confirm to proceed?"
# User confirms; pilot runs without --dry-run; reports outcome.
```

## File layout

```
claude-snaps/
└── plugin/                              ← all new content here
    ├── .claude-plugin/
    │   └── plugin.json                  ← manifest
    ├── apm.yml                          ← hybrid for APM distribution
    ├── README.md                        ← install + usage
    ├── skills/
    │   ├── harness-fundamentals/SKILL.md
    │   ├── harness-cli/SKILL.md
    │   ├── harness-reproducer/SKILL.md  ← load-bearing
    │   └── harness-archeology/SKILL.md
    ├── agents/
    │   ├── harness-archeologist.md
    │   └── harness-reproducer-pilot.md
    ├── commands/
    │   ├── harness-snap.md
    │   ├── harness-status.md
    │   ├── harness-trajectory.md
    │   ├── harness-explain.md
    │   └── harness-restore.md
    └── hooks/
        └── hooks.json
```

## Plugin manifest (`plugin/.claude-plugin/plugin.json`)

```json
{
  "name": "harness",
  "description": "Snapshot and reproduce your .claude/ composition. Tracks every change to skills, agents, settings.json, and APM-managed primitives via content-addressable lineage. APM-driven reproducer with subtractive contract (spec/format.md §6.1).",
  "version": "0.4.1",
  "author": { "name": "Bantarus" },
  "homepage": "https://github.com/bantarus/claude-snaps",
  "repository": "https://github.com/bantarus/claude-snaps"
}
```

`version` MUST track the harness format version. The CLI's
`formatVersion` (currently `0.4.1`) is the source of truth; bump
plugin.json's version every time the format version bumps.

## Skills

Each skill: `plugin/skills/<name>/SKILL.md`. Frontmatter from the
plan doc; body authored fresh per the guidance below.

### `harness-fundamentals`

**Frontmatter:** plan doc §"Skills" verbatim.

**Body content** (60-80 lines):
- What `.harness/` is (filesystem layout: `snapshots/`, `refs/`,
  `HEAD`, `lineage.sqlite`)
- Content addressing: id = sha256(canonical bytes); same composition
  → same id
- Attribution events: snapshots vs sessions, what `[N sessions]`
  means in `harness log`
- Refs vs snapshots: branches and tags are pointers; tags don't
  create snapshots (§4.2 rule)
- Source kinds: `apm`, `local`, `builtin`, `x-` extensions
- Where the format spec lives (point at spec/format.md)

Pull from spec/format.md §1-§5 distilled to "what a user actually
needs to know." Keep it concise — every line stays in context for
the rest of the session.

### `harness-cli`

**Frontmatter:** plan doc §"Skills" verbatim, including
`allowed-tools: Bash(harness *) Bash(harness-hook *)`.

**Body content:**
- One paragraph per command: init, log, diff, snap, sessions, notes,
  tag, branch, checkout, reproduce, reindex, install-hook
- For each: what it does, key flags, when to suggest it
- Ref resolution rules (40-hex id, 6+-hex prefix, HEAD, branch, tag)
- Exit code conventions (0 success, 1 user error, 2 internal)

Pull from `packages/cli/README.md` (current as of v0.4.1).

### `harness-reproducer` (load-bearing)

**Frontmatter:** plan doc §"Skills" verbatim.

**Body content** — pin the §6.1 contract explicitly:
- "Reproduce restores APM-managed and builtin paths to the
  snapshot's state. Local-source paths are NEVER touched."
- "Backup happens unconditionally at `.claude.harness-backup-<ts>/`.
  This is the safety net, not the absence of deletion."
- "Reproduction is **subtractive within scope** (v0.4.1, §6.1):
  APM-managed paths NOT in the target are removed; project's
  `apm.lock.yaml` is restored to match snapshot's `apmLockfile`."
- "If apm install fails, HEAD is NOT advanced and the backup is
  retained. Recover by `mv` of the backup back over `.claude/`."
- "configHash mismatches mean the snapshot included a local edit on
  top of an APM file; reproduce can recreate upstream but not
  'upstream + your edit.' Choose: commit upstream via APM, or accept
  being snapped back."
- "Always run `--dry-run` before a real reproduce when the situation
  has nuance (non-APM project, hand-edited APM files, ancestor
  reproductions across composition changes)."

This skill is the most important. The v0.4 observation playbook's C2
case (hand-edit + reproduce → mismatch) is the most subtle, and a
user without this skill loaded will misinterpret "✗ APM phase failed"
as the reproducer being broken when it's working as designed.

### `harness-archeology`

**Frontmatter:** plan doc §"Skills" verbatim, including
`allowed-tools: Bash(harness log *) Bash(harness diff *) Bash(harness sessions *) Bash(harness notes *)`.

**Body content:**
- Map user questions → harness queries:
  - "what changed today" → `harness log --limit 20` filtered by date
  - "when was X added" → `harness log` to find candidate snapshots,
    `harness diff <parent> <id>` to confirm
  - "do I have notes on this" → `harness notes <ref>`
  - "what's my session trajectory" → `harness sessions <id>`
- Format conventions: when to dump raw output vs prose summary
- The (HEAD) annotation in log output (v0.4.1)

## Subagents

Each subagent: `plugin/agents/<name>.md`. Per the plan: plugin
subagents lose `hooks`, `mcpServers`, `permissionMode` fields (those
are silently ignored by Claude Code). Don't include them.

### `harness-archeologist`

**Frontmatter:** plan doc §"Subagents" verbatim, including
`tools: Read, Bash(harness log *), Bash(harness diff *), Bash(harness sessions *), Bash(harness notes *), Bash(git log *), Bash(cat *)` and `model: haiku`.

**System prompt body:**
- Identity: "You are a harness lineage archeologist. The user wants
  to understand what happened in their .claude/ over time."
- Workflow: read harness log, identify candidate snapshots, drill
  into specific ones, surface notes, return narrative
- Output discipline: short prose narrative, NOT a raw command dump.
  The point of running in a subagent is to keep raw output out of
  the main conversation.
- When to refuse: if the question isn't about lineage (e.g., "fix
  this bug"), return a one-line redirect rather than starting work.

### `harness-reproducer-pilot`

**Frontmatter:** plan doc §"Subagents" verbatim, including
`tools: Read, Bash(harness reproduce *), Bash(harness log *), Bash(harness diff *), Bash(harness checkout *), Bash(ls *), Bash(cat *)` and `model: sonnet`.

**System prompt body:**
- Identity: "You are the harness reproducer pilot."
- Pin the §6.1 contract verbatim (subtractive within scope, APM
  prereq, unconditional backup, local-source untouched).
- Workflow: dry-run → explain implications → confirm with user →
  execute
- Specific handling for: non-APM projects (subtractive cleanup is
  the only effect), hand-edited APM files (warn about mismatch
  before running), ancestor reproductions (warn about apm.lock.yaml
  removal), detached HEAD (works fine, just note it).
- Output discipline: each step gets one sentence; don't narrate the
  workflow, do it.

## Slash commands

Each: `plugin/commands/<name>.md`. Frontmatter from the plan;
implementations below.

### `/harness:snap`

```yaml
---
description: Capture current .claude/ composition with a note.
disable-model-invocation: true
allowed-tools: Bash(harness snap *)
argument-hint: "<note>"
---
```

Body: run `harness snap "$ARGUMENTS"`; report the captured snapshot
id and any deduplication info ("snapshot already existed; appended
note attribution").

### `/harness:status`

```yaml
---
description: Aggregate view of harness state — HEAD, recent lineage, divergence flag, refs.
disable-model-invocation: true
allowed-tools: Bash(harness log *), Bash(harness checkout *)
---
```

Body: aggregate command runs in this order, output formatted as a
single-screen status report:
1. `harness log --limit 5` → recent lineage rows (the (HEAD)
   annotation surfaces current HEAD)
2. Branch + tag inventory (parse from log output OR add `harness
   refs` if it exists; verify against current state)
3. Working-tree divergence: re-run `harness checkout <current-ref>`
   to trigger the divergence warning OR — preferred — just inspect
   `harness checkout main` style with the same branch ref so HEAD
   doesn't move; parse the warning if it fires
4. Backup directory count + total size: `ls -d .claude.harness-backup-* 2>/dev/null | wc -l`

### `/harness:trajectory <session-id>`

```yaml
---
description: Show the full trajectory of a session — snapshots observed, notes attached, hook fires.
disable-model-invocation: true
allowed-tools: Bash(harness sessions *)
argument-hint: "<session-id>"
---
```

Body: run `harness sessions $ARGUMENTS` and format the output as a
chronological timeline. Notes get a `@` marker.

### `/harness:explain <ref>`

```yaml
---
description: Plain-prose explanation of a snapshot — what it captures, what changed vs parent, who observed it, what notes are attached.
allowed-tools: Bash(harness log *), Bash(harness diff *), Bash(harness notes *), Bash(harness sessions *)
argument-hint: "<ref>"
---
```

Body: resolve `$ARGUMENTS` to a snapshot id, then narrate:
- When captured (createdAt + git codePin)
- What changed vs parent (diff summary)
- Who observed it (sessions list)
- Any notes attached (notes list)
- Whether HEAD is currently at it

Output is prose, not raw command output. Subagent-style: the user
asked a question, return an answer.

### `/harness:restore <ref>` (the safe-wrapper)

```yaml
---
description: Reproduce wrapper — runs --dry-run first, summarizes implications, asks for confirmation, then executes.
disable-model-invocation: true
allowed-tools: Bash(harness reproduce *), Bash(harness diff *), Bash(harness log *)
argument-hint: "<ref>"
---
```

Body: this is the most complex command. Algorithm:
1. Run `harness reproduce $ARGUMENTS --dry-run` and parse the output.
2. Summarize what would happen using the `ReproduceResult`-shaped
   output:
   - APM phase (skipped/success/failed)
   - APM modules expected/verified
   - Paths that would be removed (length > 0 → enumerate)
   - Whether apm.lock.yaml would be removed
   - Local-source modules NOT being reproduced (length, not
     individual names — would be too verbose)
3. If non-trivial (paths to remove > 0 OR lockfile removal OR APM
   modules > 5), explicitly ask the user to confirm before
   proceeding.
4. On confirmation, run `harness reproduce $ARGUMENTS` (no
   --dry-run).
5. Report the result + backup path, with any failures called out
   prominently.

## Hooks (`plugin/hooks/hooks.json`)

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "harness-hook" }]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "harness-hook" }]
      }
    ]
  }
}
```

## `apm.yml` (hybrid distribution)

```yaml
name: harness
version: 1.0.0
description: Claude Code plugin for harness — snapshot and reproduce .claude/ composition.
author: Bantarus
license: MIT
target: claude
type: hybrid
```

## `plugin/README.md`

User-facing install + usage. Cover:
- Two-piece install (`npm install -g @harness/cli` + `claude /plugin
  install`)
- What ships in the plugin (skills, subagents, commands)
- Quick-start: open Claude Code, run `/harness:status`
- Migration for users with existing `harness install-hook` (see
  Open Questions §2 below — surface a recommendation in the README
  AFTER you've made the call)
- Link to spec/format.md and docs/plugin-plan.md for deeper context

## Test gates

The plugin is markdown — there's no test suite that compiles. Gates
are workflow-shaped, run manually against a real `.harness/`
project. Use `~/harness-v0_4-observe` (the v0.4 observation repo
that's still on disk; it has 3 snapshots, 2 sessions, 1 tag).

### Gate P1: Plugin loads without error

```bash
claude --plugin-dir /path/to/claude-snaps/plugin
```

In the resulting Claude Code session, `/help` lists:
- `/harness:snap`, `/harness:status`, `/harness:trajectory`,
  `/harness:explain`, `/harness:restore`

Run `What skills are available?` — output includes `harness-cli`,
`harness-fundamentals`, `harness-reproducer`, `harness-archeology`.

Run `/agents` — list includes `harness-archeologist` and
`harness-reproducer-pilot`.

### Gate P2: Hook fires correctly via the plugin

In `~/harness-v0_4-observe`:
1. Remove the project-level hook config from `.claude/settings.json`
   (back it up first).
2. Open `claude --plugin-dir /path/to/plugin` in that directory.
3. Send any prompt.
4. Run `harness log` — verify a new attribution row appeared (or a
   new snapshot if composition changed).

Restore the project-level config after the test.

### Gate P3: `/harness:status` returns expected shape

In `~/harness-v0_4-observe` with plugin loaded:
```
> /harness:status
```

Expected output includes (verify each line is present):
- HEAD line ("HEAD: ref refs/heads/main" or "HEAD detached at ...")
- 3-5 recent log rows
- Branch list (main)
- Tag list (v0.4-apm)
- Divergence status ("matches" or "DIVERGED")
- Backup directory count

### Gate P4: `/harness:restore` dry-run pattern

```
> /harness:restore v0.4-apm
```

Expected behavior:
1. Pilot subagent activates (Claude routes to it via description).
2. Subagent runs `harness reproduce v0.4-apm --dry-run`.
3. Subagent narrates the planned cleanup including paths to remove
   and APM verification count.
4. Subagent asks for confirmation BEFORE running real reproduce.
5. On confirmation, real reproduce runs; report includes the backup
   path.

### Gate P5: harness-reproducer skill triggers correctly

Send a representative trigger phrase:
```
> I want to go back to v0.4-apm. Will my CLAUDE.md survive?
```

Claude should:
1. Load `harness-reproducer` skill (you can verify by checking the
   skill list in the response or asking Claude what skills are in
   context).
2. Answer based on the §6.1 contract: "Yes, CLAUDE.md is local-
   source — the reproducer never touches local-source paths. APM-
   managed paths will be subtractively cleaned."
3. Suggest `/harness:restore v0.4-apm` to proceed safely.

If Claude answers without the skill loaded (e.g., generic
"reproduce restores everything"), the skill's description needs
tightening.

### Gate P6: APM hybrid install works locally

```bash
mkdir -p /tmp/apm-test && cd /tmp/apm-test
mkdir -p .claude
cat > apm.yml <<EOF
name: test
version: 1.0.0
dependencies:
  apm:
    - /path/to/claude-snaps/plugin
EOF
apm install
```

Expected: APM installs the plugin's primitives into `.claude/skills/`,
`.claude/agents/`, `.claude/commands/`, and merges hook config into
`.claude/settings.json`. Verify each landed.

## What's NOT in scope

- **Modifying the harness CLI.** The plugin is a layer on top of
  v0.4.1. If a CLI gap surfaces during plugin authoring, file it as
  v0.4.x backlog or v0.5.x; don't fix in this prompt.
- **Multi-tool primitives** (chatmodes, instructions, output-styles).
  Plugin ships skills/agents/commands/hooks only.
- **MCP server.** A `harness-mcp` server is genuine v0.6 value
  (structured output, no shell injection), but bigger scope. Not
  this prompt.
- **Plugin hot-reload on CLI version mismatch.** Document the
  workaround (`/reload-plugins` after CLI upgrade); don't implement
  detection.
- **Submission to the official Claude Code marketplace.** Distribute
  via `--plugin-dir` and APM first; marketplace is a follow-up after
  ≥2 weeks of real use.

## Order of operations

Each step ends with a verifiable state. Pause and commit between
steps; the next session can pick up cleanly.

1. **Plugin shell + hooks** (~half day). Create `plugin/`,
   `.claude-plugin/plugin.json`, empty `skills/`, `agents/`,
   `commands/`, `hooks/hooks.json`. Test Gate P1 (plugin loads with
   empty surface) and Gate P2 (hook fires). Commit.
2. **`harness-fundamentals` skill** (~2 hours). Author. Verify Gate
   P5-shape question: "what is .harness/?" → skill loads, prose
   answer grounds in the skill's body. Commit.
3. **`harness-cli` skill** (~3 hours). Author with `allowed-tools`.
   Verify by asking Claude to run a harness command — should fire
   without per-use approval prompt. Commit.
4. **`harness-reproducer` skill** (~half day; the load-bearing one).
   Author with explicit §6.1 pinning. Run Gate P5 verbatim. Commit.
5. **`harness-archeology` skill** (~3 hours). Author. Verify by
   asking "what changed in this project today" — Claude should
   route to harness commands, not generic grep/find. Commit.
6. **`harness-archeologist` subagent** (~3 hours). Author with
   read-only tools, haiku model. Verify by asking a deeper
   archeology question — Claude should DELEGATE rather than running
   in main context. Commit.
7. **`harness-reproducer-pilot` subagent** (~half day). Author with
   sonnet model. Verify by asking "reproduce v0.1 with care" —
   pilot should activate, not direct CLI invocation. Commit.
8. **Slash commands** (~1 day total, ~2 hours each): `/harness:snap`
   first (simplest), then `/harness:status`, `/harness:trajectory`,
   `/harness:explain`. Leave `/harness:restore` for last (most
   complex; depends on the pilot subagent). Run Gate P3, P4 against
   each. Commit per command.
9. **`apm.yml` hybrid manifest + Gate P6** (~half day). Add apm.yml.
   Test local APM install via the gate. Commit.
10. **`plugin/README.md`** (~half day). Authoring guidance covered
    above. Commit.
11. **`@harness/cli` npm publish** (~half day, deferred — only when
    plugin is otherwise ready). Reserve namespace, publish minor
    version (v0.4.1 to match the format), verify install on a clean
    machine.
12. **End-to-end smoke** in Claude Code (~half day). Walk the full
    success criterion at the top of this doc. If anything diverges
    from expected, fix before committing.

## Open questions to surface, NOT settle

The plan doc lists these in detail. Don't make these calls
unilaterally; surface options to the user during implementation:

1. **Plugin↔CLI version coupling.** Three options listed in the plan
   doc §"Open questions" #1. Default to (c) "Document, don't
   enforce" for v0.5.0 — lightest implementation. If the user wants
   stronger coupling, re-discuss.
2. **Migration for users who already ran `harness install-hook`.**
   Three options listed in plan doc #2. Default to (b) "Plugin's
   startup skill detects + warns" — non-destructive, surfaces the
   issue without forcing action. The startup skill is part of
   `harness-fundamentals`; add a "checking hook config..." section
   that runs `cat .claude/settings.json | grep harness-hook` and
   reports duplicates.
3. **Namespace name.** Plan defaults to `harness:`. If APM or
   marketplace constraints force a different name, surface and
   re-discuss.
4. **Whether to ship a v0.4 onboarding tour as a slash command.**
   Defer to v0.5.x. Don't add to this prompt's inventory.
5. **`harness install-hook --uninstall`.** A CLI gap that would
   ease migration. NOT in scope for this prompt; file as v0.4.x
   backlog if migration friction surfaces during implementation.

## Estimated effort

Per the plan doc: ~6 days of focused work. Order of operations
above is granular enough that any single session can pick up at the
right step. Commit after each step so the next session has a clean
hand-off.

## What success looks like (repeating for clarity)

A user opens Claude Code in a project with `.harness/`. Without
prompting:

- Hook fires on session start; harness records the SessionStart.
- User asks "what changed in this project today?" → Claude routes
  to the archeology skill, runs `harness log` filtered by date,
  returns prose.
- User says "go back to v0.3 state" → Claude routes to the reproducer
  pilot subagent, dry-runs first, explains the contract implications,
  asks for confirmation.
- User confirms; pilot executes; reports outcome with backup path.

That's the experience. The harness CLI was already capable of all
of this; the plugin removes the "user must know what to type"
friction.

---

When this prompt is complete, the v0.5 plugin work is done. Next
conversations are real-use observation against the new plugin
surface — same shape as the v0.4 observation playbook produced for
the CLI, but evaluating Claude's behavior with the plugin loaded.
