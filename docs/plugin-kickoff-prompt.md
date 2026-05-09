# Kickoff prompt: claude-snaps Claude Code plugin (v0.5 — fresh-session entry point)

> Hand this to a fresh Claude Code session against this monorepo. The
> session has no prior context. This file is the entry point; it
> bridges the v0.4.1-era authoring prompt at
> [docs/plugin-implementation-prompt.md](plugin-implementation-prompt.md)
> (621 lines, the canonical detail) with what shipped on `main` since
> that prompt was written.

## What changed since `plugin-implementation-prompt.md` was authored

The prompt was drafted against v0.4.1. Since then:

| Tag | Date | What landed | Plugin impact |
|---|---|---|---|
| v0.4.2 | 2026-05-08 | Hook payload reality lock — Claude Code 2.1.128 sends asymmetric per-event payload; `model` not sent at all; `permission_mode` UPS-only | `harness-fundamentals` should not promise users that snapshots will carry `model`/`permissionMode` populated |
| v0.5.0 | 2026-05-09 | Session metrics + transcript ingestion: new `claudeCodeVersion` field, `turn_metrics` table, `harness ingest-session` + `harness session-cost` CLI, format bump 0.4 → 0.5, schema migration 007, SessionEnd event added to hook contract | `harness-cli` skill MUST cover the new commands; plugin.json `version` bumps to `0.5.0`; `hooks/hooks.json` is a candidate site for auto-ingest wiring |

Read those changes in the spec before writing skills:

- [spec/format.md §2.1](../spec/format.md#21-required-and-optional-fields) — `claudeCodeVersion`, first-observation-wins
- [spec/format.md §10](../spec/format.md#10-session-metrics-v050) — turn_metrics, normative redaction whitelist
- [spec/hooks.md §1.1](../spec/hooks.md#11-channel-a--stdin-json-primary-claude-code-native) — 4-event inventory, last_assistant_message privacy class
- [packages/cli/README.md](../packages/cli/README.md) — current CLI surface (v0.5.0)
- [memory/v0_5_milestone.md](~/.claude/projects/-home-bantarus-DEV-claude-snaps/memory/v0_5_milestone.md) (auto-loaded if you have memory) — summary of the framing shift

## Mandatory pre-flight: prospective verified-pins probe

Before writing a single skill body, prove the plugin loader's
contract empirically. This applies the same v0.4.2 spec-vs-reality
discipline that produced the verified-pins section of
[docs/session-metrics-prompt.md](session-metrics-prompt.md) — the
discipline saved that work-package ~1 hour of cold-start probing
(see [memory/feedback_spec_vs_reality.md](~/.claude/projects/-home-bantarus-DEV-claude-snaps/memory/feedback_spec_vs_reality.md)
for the recurring pattern; this would be confirmation #5).

**Why prospectively, not after a failure:** the plugin format
(skills/, agents/, commands/, hooks/, .claude-plugin/plugin.json)
is documented in Claude Code's docs but not soak-tested at scale by
us. The 2.1.x docs may have edge cases the plugin-implementation
prompt didn't anticipate. Probe now, lock the answers as drift
detectors, then build against pinned reality — not against a
hopeful reading of the docs.

### Probes to run (all answers expected; lock via drift detector if not)

Run each probe as a one-shot `claude -p` against a tmp `--plugin-dir`
and inspect the output. Add results to a new section "Verified pins
(plugin)" in this file when done.

1. **Plugin discovery.** Does `claude --plugin-dir <abs-path>` load
   the directory's primitives without `claude /plugin install`? What
   surfaces in `/help`? In `/agents`? In the skill list?
2. **Namespace prefix.** Does `/harness:status` actually resolve when
   the plugin's `name` is `harness` and the command file is
   `commands/harness-status.md`? What about `commands/status.md` —
   does it become `/harness:status` or `/status`?
3. **Skill triggering.** Send a representative natural-language
   question that should activate `harness-fundamentals` (e.g. "what
   is .harness/?"). Does Claude actually load the skill, or is the
   description filter too loose / too tight? Lock the trigger
   wording.
4. **Subagent activation.** Does Claude route to a subagent based on
   description matching? What happens if no description matches the
   query — does Claude fall through silently, error, or run in main
   context?
5. **`hooks/hooks.json` activation.** When the plugin is loaded, are
   its hooks merged with the project's `.claude/settings.json` hooks
   or do they replace them? How is conflict (both define
   `SessionStart`) resolved? **This affects the
   `harness-fundamentals` startup skill design** (Open Question #2
   in the original prompt — "Migration for users who already ran
   `harness install-hook`").
6. **`allowed-tools` enforcement.** Is `Bash(harness *)` accepted as
   a Claude Code permission grant, or only at the Anthropic SDK
   level? Does `Bash(harness snap *)` (with arg pattern) work as
   expected vs `Bash(harness*)`?
7. **`disable-model-invocation` semantics.** When set on a slash
   command, does Claude refuse to silently invoke it (only the user
   can type `/harness:snap`), or does it just hide the command from
   model-routing while still allowing direct invocation?
8. **Plugin discovery in APM hybrid mode.** `apm install` against
   the plugin directory — does it correctly install primitives into
   the consuming project's `.claude/`? What does the lockfile entry
   look like? Does it preserve the `.claude-plugin/` subtree?

Two probes are NEW for v0.5 and not covered by the original prompt's
P1-P6 gates:

9. **SessionEnd hook timing.** When `harness ingest-session` is
   wired into `SessionEnd` via plugin hooks, is the JSONL fully
   flushed by the time the hook fires? Or does the host close the
   transcript after firing SessionEnd? Test with a real `claude -p`,
   verify the JSONL has the expected last assistant turn at hook-
   fire time.
10. **Plugin↔CLI version mismatch.** What happens when the plugin's
    `plugin.json.version` is `0.5.0` but the installed `harness` CLI
    is v0.4.x? Do hooks fail loudly, silently, or partially?

### Drift detectors

For every probe whose answer the implementation depends on, write a
lightweight test under `scripts/dogfood-v0_4/local_cases/` (likely
`l3_plugin_pre_flight.sh`) that re-runs the probe and asserts the
expected answer. The drift detectors are the contract; the prompt's
prose is just documentation.

This step is **estimated 2-3 hours** of probing + locking. The
original prompt's "Step 1: plugin shell + hooks" assumed the loader
would behave; do not start step 1 until at least probes 1-7 have
green drift detectors.

## Hard pins (still in force)

All 8 hard pins from the original prompt's "Hard pins (do NOT
relitigate)" section still apply. Re-read them at
[docs/plugin-implementation-prompt.md L20-52](plugin-implementation-prompt.md).
Two get nuance from v0.5.0:

- **Pin 4 — namespace `harness`.** Confirmed by probe #2; lock via
  drift detector before authoring commands.
- **Pin 8 — distribution order.** `--plugin-dir` (local dev) → APM
  (dogfood) → marketplace. v0.5.0 doesn't change this; the plugin
  ships AFTER session metrics so users get the full v0.5 surface in
  one install.

## Updated plan vs. the original prompt

### Skill content updates

`harness-cli` skill body now MUST cover ALL v0.5.0 commands. Add to
the per-command paragraph list:

- **`harness ingest-session [<id>] [--all] [--since-turn N]
  [--dry-run] [--transcript-path <path>]`** — Reads the per-session
  transcript JSONL Claude Code writes, extracts model + token usage
  + tool names + Claude Code version into `turn_metrics`. Idempotent
  on `(session_id, turn_index)`. Privacy-load-bearing: the parser
  reads ONLY the [§10.2 whitelist](../spec/format.md#102-what-is-not-stored)
  fields; prompt text, tool inputs, tool results, system prompts,
  and assistant thinking are NEVER copied. Suggest after a long
  session or when the user asks about cost.
- **`harness session-cost [<id>] [--all] [--by-tool] [--by-model]
  [--branch <name>] [--limit N] [--csv]`** — Queries `turn_metrics`.
  Per-session report or project-wide roll-up. `--by-tool` reports
  CALL COUNTS only — per-tool TOKEN attribution is not supportable
  per [§10.3](../spec/format.md#103-per-tool-token-attribution-impossibility).
  Suggest when the user asks "how much did this session cost" or
  "which sessions burned the most tokens this week."

`harness-fundamentals` skill body adds three new bullets:

- The `claudeCodeVersion` field — host CLI version observed at
  first hook fire, EXCLUDED from canonical bytes (so the same
  composition observed across CC version bumps still hashes the
  same).
- The `turn_metrics` table — session-keyed economic data populated
  post-hoc by `harness ingest-session`. NOT in snapshot blobs (per
  the composition-vs-events doctrine).
- The privacy whitelist (§10.2) — what `ingest-session` reads vs
  what it explicitly does not read. Surface this prominently
  because users WILL ask "is harness reading my prompts?" and the
  answer is "no, by spec, by gate, by design."

`harness-archeology` skill body adds query → command mappings:

- "what did this session cost" → `harness session-cost <id>`
- "which sessions used the most tokens" → `harness session-cost
  --all --limit 10`
- "what did I spend on Opus this week" → `harness session-cost
  --all --by-model`
- "did I use the Bash tool yesterday" → `harness session-cost
  --all --by-tool`

### `hooks/hooks.json` shape (open question)

The original prompt's hooks.json wires SessionStart + UserPromptSubmit
only. v0.5.0 added SessionEnd to the known event set. Two options:

**(a) Wire SessionEnd → `harness ingest-session $session_id`** for
auto-ingest of every session. Pro: zero-friction "harness knows
everything about every session." Con: blocks session shutdown
on a multi-second JSONL parse + DB insert (acceptable? probe #9
answers); also re-ingests sessions whose hooks fired into harness
even on resume / clear / compact (the §10.6 idempotency property
makes re-ingest cheap, but still). Privacy concern: the auto-ingest
runs against transcript_path even for sessions where the user might
have wanted ingestion to be opt-in.

**(b) Keep SessionStart + UserPromptSubmit only** (status quo). User
runs `harness ingest-session` manually or via `/harness:cost`
(see below). Auto-ingest is a v0.5.x candidate.

**Recommendation: (b) for the kickoff session.** Reason: (a)'s
privacy implication needs a UX conversation that's bigger than
this prompt. The session-end performance question (probe #9)
needs a measured answer first.

Surface the choice during implementation; don't unilaterally wire
(a). If the user prefers (a), add the SessionEnd entry to hooks.json
and add a `--background` flag to `harness ingest-session` (which
doesn't exist yet — that's a CLI gap to file as v0.5.x backlog).

### `/harness:cost` — new slash command (open question)

Should the plugin ship a sixth slash command for session-cost? Two
options:

**(a) Add `/harness:cost [<session-id>] [--all]`** — symmetric with
the other commands; thin wrapper around `harness session-cost`.

**(b) Don't add it; route via `harness-archeology` skill.** The
skill already maps the natural-language queries above to
`harness session-cost`. A slash command duplicates the surface.

**Recommendation: (a).** Slash commands are discoverable
(`/<tab>` lists them) and the cost surface is novel enough that
users won't intuit "ask the archeology skill" without prompting.
The original prompt's hard pin #5 says "skill / subagent / command
inventory frozen" — but that pin was from before session-cost
existed; v0.5.0 expanded the CLI surface enough that a slash
command for cost is now a natural addition. Surface this to the
user as a v0.5.x scope expansion, not a rewrite of the original
inventory.

### `plugin.json.version`

Bump to `0.5.0` to track the format version (per the original
prompt's "version MUST track formatVersion" rule).

## Order of operations (revised)

Each step ends with a verifiable state. Pause and commit between
steps.

0. **Prospective probing** (~2-3 hours). Run probes 1-10 above. Lock
   answers via `scripts/dogfood-v0_4/local_cases/l3_plugin_pre_flight.sh`
   (analogous to `l2_v0_5_pre_flight.sh`). Add a "Verified pins
   (plugin)" section at the bottom of THIS file with the locked
   answers. Commit.
1. **Plugin shell + hooks** — same as original prompt step 1, with
   `plugin.json.version = "0.5.0"`. Run Gate P1 + P2.
2-7. **Skills + subagents** — follow original prompt steps 2-7,
   incorporating the v0.5.0 content updates above.
8. **Slash commands** — original step 8, plus author
   `/harness:cost` if Open Question #2 above resolved to (a).
9. **`apm.yml` hybrid manifest + Gate P6** — same as original.
10. **`plugin/README.md`** — same as original, plus a "Session
    metrics" section that explains the privacy whitelist and the
    two new commands.
11. **`@harness/cli` npm publish** — original step 11; publish v0.5.0
    (matches the format).
12. **End-to-end smoke** — original step 12, plus a v0.5-specific
    smoke: open Claude Code with the plugin loaded, fire `/harness:cost
    --all`, verify the session-cost output renders cleanly.

## Open questions to surface (NOT to settle)

The original prompt's 5 open questions still apply (re-read at
[L566-589](plugin-implementation-prompt.md#open-questions-to-surface-not-settle)).
v0.5.0 adds two more:

6. **Auto-ingest via SessionEnd.** Resolution depends on probe #9
   (timing). See "hooks/hooks.json shape" above.
7. **`/harness:cost` slash command.** See above. Default
   recommendation is (a) — add it — but the original prompt's hard
   pin #5 is in tension; needs an explicit user decision.

## What's NOT in scope (still applies)

Same exclusions as the original prompt L505-520. Two clarifications:

- **Modifying the harness CLI.** The plugin is a layer on top of
  v0.5.0 (was v0.4.1). If a CLI gap surfaces during plugin authoring
  (e.g. `harness ingest-session --background` for option (a) above),
  file as v0.5.x backlog; don't fix in this prompt.
- **MCP server.** Still v0.6+ candidate. v0.5.0's
  `harness-session-cost` command's structured output (`--csv`) is
  the closest we have to "structured queries"; an MCP server would
  give Claude direct access to the data without shell injection.
  Not this prompt.

## Estimated effort

- Original plan: ~6 days
- v0.5.0 deltas: +0.5 days for probing, +0.25 days for v0.5 skill
  content, +0.25 days for `/harness:cost` if shipped
- **Revised: ~7 days of focused work**

## What success looks like

A user opens Claude Code in a project with `.harness/`. The plugin
is installed. Without prompting:

- Hook fires on session start; harness records the SessionStart.
- User asks "what changed in this project today?" → Claude routes
  to the archeology skill, runs `harness log` filtered by date,
  returns prose.
- User asks "how much did yesterday's session cost?" → Claude
  routes to the archeology skill, runs `harness ingest-session
  <id>` (if needed) then `harness session-cost <id>`, returns the
  cost summary in prose.
- User says "go back to v0.3 state" → Claude routes to the
  reproducer pilot subagent, dry-runs first, explains the contract
  implications, asks for confirmation.
- User confirms; pilot executes; reports outcome with backup path.
- User asks "is harness reading my prompts?" → Claude (via the
  fundamentals or archeology skill) explains the §10.2 whitelist
  and points at the W12.5 + L2.6 fuzz gates that verify it on
  every CI run.

That last bullet is the v0.5-specific load-bearing one. Users will
ask. The plugin's job is to give an authoritative, spec-grounded
answer without escalating their concern unnecessarily.

---

When this prompt is complete, the v0.5 plugin work is done. The
combined v0.5 surface (session metrics + plugin) is the user's
full Claude Code-native harness experience: capture, query, cost,
reproduce — all routable via skill descriptions, all gated by
spec-grounded answers.

## Verified pins (plugin)

> Fill this in during step 0. One subsection per probe; each
> subsection has the question, the observed answer, and a
> reference to the locked drift detector.

(empty until step 0 completes)
