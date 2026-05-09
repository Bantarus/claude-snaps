---
name: harness-archeology
description: "Map of user lineage queries → harness commands. Answers questions like 'what changed today / yesterday / this week', 'when was X added', 'show me recent activity', 'do I have notes on this state', 'what's session X's trajectory', plus v0.5 economics: 'what did this session cost', 'which sessions burned the most tokens', 'what did I spend on Opus this week', 'did I use the Bash tool yesterday'. Use whenever the user wants to understand history, lineage, or session economics in a `.harness/`-tracked project."
---

# harness archeology

This skill is a query map: when the user asks a history-shaped or
economics-shaped question, the right harness command and how to read
its output. Use this skill — and the harness CLI commands it routes to
— rather than `grep`, `find`, or `git log` on `.claude/` files. The
harness already records lineage; archeology is just remembering which
verb to call.

For deeper investigations the `harness-archeologist` subagent (haiku
model) handles multi-step lineage research and returns prose summaries
without polluting the main conversation; route to it when the answer
needs more than one or two command runs.

## Lineage queries

### "What changed today / recently / since v0.X?"

```bash
harness log --limit 20 --with-sessions
```

Each row: `<id8> ▶ <diff-summary>  (branch) [(HEAD)] [tag] code:<git-sha> [N sessions]`.
The `▶` summary lists modules added (`+`), removed (`-`), or changed
(`~`) since the parent. **Note:** `harness log` does **not** have a
date filter; per-row dates aren't surfaced in `log` output. To filter
by date, run `harness sessions` (which lists ISO timestamps per
session) and cross-reference session ids back to the snapshots they
touched.

For "since `<tag>`": find the tagged snapshot's id, then walk forward
in `harness log` until you hit it; the rows above are everything that
landed since.

### "When was X added?"

Two-step lookup:

```bash
harness log --limit 50           # find candidate snapshots whose ▶ summary mentions X
harness diff <parent> <id>       # confirm X is in <id> and not in <parent>
```

The `(parent, id)` pair is the precise "when X arrived" — a snapshot
plus its parent.

### "Do I have notes on this snapshot/tag?"

```bash
harness notes <ref>
```

Lists every `note` attribution event ever attached to the snapshot,
across all sessions, in chronological order. Notes don't create new
snapshots — they're rows in `lineage.sqlite` (§2.7) — so a snapshot
can accumulate notes from multiple sessions over time.

### "What's session X's trajectory?"

```bash
harness sessions <session-id>
```

Renders a chronological timeline: every snapshot the session observed,
with notes inline marked `@`. If you don't have the session id:

```bash
harness sessions
```

Lists all sessions: `<ISO-timestamp>  <session-id>  N events, M snapshots [, K notes]`.

### "Show me activity in session <id>"

Same as the trajectory query above. The `@`-marked rows are notes the
user attached during that session.

### "Which session touched snapshot X?"

```bash
harness log --limit N --with-sessions    # rows include "[K sessions]"
```

For the sessions themselves, run `harness sessions` and look for ones
whose snapshot id matches.

## v0.5 economics queries

Session economics live in `turn_metrics` (separate from snapshot
blobs). The user must run `harness ingest-session` once per session of
interest before queries; `--all` backfills every session with a
transcript on disk.

### "What did this session cost?" / "How expensive was session X?"

```bash
harness ingest-session <session-id>     # if not already ingested
harness session-cost <session-id>
```

Output: per-session breakdown — turn counts, models touched, token
totals (live, cache-creation, cache-read, output), top tools by call
count.

### "Which sessions burned the most tokens this week?"

```bash
harness ingest-session --all
harness session-cost --all --limit 10
```

Project-wide ranking ordered by total tokens DESC. `--branch <name>`
narrows to a single branch's lineage.

### "What did I spend on Opus / Haiku?"

```bash
harness session-cost --all --by-model
```

Per-model session counts and total tokens. Sessions that touched
multiple models count in EACH bucket.

### "Did I use the Bash tool / Edit / mcp-server yesterday?"

```bash
harness session-cost --all --by-tool
```

**Call counts only.** Per-tool TOKEN attribution is impossible
(§10.3 — JSONL `usage` blocks are per-turn, not per-tool-call). Don't
report estimated per-tool costs — the harness-fundamentals skill
covers why.

## Output discipline

- **Prose summary > raw dump.** When the user asks a question, return
  an answer, not a 50-row paste. Run the command, parse the rows that
  matter, and synthesize.
- **Surface the (HEAD) annotation.** `harness log` marks the current
  HEAD with `(HEAD)`; mention which snapshot the user is on if the
  question is "where am I."
- **Cite ids consistently.** First reference a snapshot by its 6-8-hex
  prefix (matches `harness log` display); spell out the full 40-hex
  only when disambiguation matters.
- **Flag gaps honestly.** "I see no recent activity" is more useful
  than fabricated history. The hook fires on SessionStart and
  UserPromptSubmit — projects open in Claude Code without the plugin
  loaded won't have rows for those sessions.

## When to delegate

Route to the `harness-archeologist` subagent (haiku, read-only tools)
when:

- The investigation requires more than 2 command runs.
- The user wants a narrative summary, not a one-liner.
- The raw output is large (50+ log rows, large session list).

The subagent runs in its own context window; raw `harness log` /
`harness diff` output stays out of the main conversation. The user
gets prose; the assistant's main context stays clean.

## Privacy reminder

Session-cost queries read `turn_metrics`, which is populated by
`harness ingest-session` from the per-session JSONL transcript. The
ingester reads ONLY whitelisted fields (§10.2 NORMATIVE) — prompt
text, tool inputs, tool results, system prompts, and assistant
thinking are NEVER copied. If a user worried about privacy asks
"what does session-cost actually see," route to the
`harness-fundamentals` skill (§10.2 + W12.5 fuzz gate citation).
