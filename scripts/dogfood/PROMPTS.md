# Dogfood Soak Session Prompts

Each session: paste the prompt into `claude`, let Haiku respond once, then `/exit`. Wall-clock: 30-45s per session.

---

## Day 01 — Reset (no claude session)

Just run the setup script:
```bash
bash scripts/dogfood/reset.sh
```

---

## Day 02 — Add Skill

**Session 1 (brief):**

```
I'm working on improving our documentation tooling. Can you write a simple bash script that validates markdown files have front matter? We need to check that all .md files in a docs/ folder have a valid YAML front matter block starting with ---.

Just a quick 10-line script to get started.
```

Then run:
```bash
bash scripts/dogfood/02-add-skill.sh
```

---

## Day 03 — Modify Skill

**Session 1 (brief):**

```
The markdown validation script should now also check that front matter contains required fields: title, date, and author. Update it to validate those three fields are present and non-empty.
```

Then run:
```bash
bash scripts/dogfood/03-modify-skill.sh
```

**Session 2 (unchanged composition probe):**

Same prompt as Session 1, or just:

```
Tell me more about YAML front matter best practices.
```

(The goal: fire the hook again without changing anything, to test diff noise floor.)

---

## Day 04 — Add MCP

**Session 1 (brief):**

```
We're adding Brave Search MCP to our project for web research. Can you tell me what the MCP ecosystem looks like and how Brave Search integrates with Claude? I'm setting it up for the first time.
```

Then run:
```bash
bash scripts/dogfood/04-add-mcp.sh
```

---

## Day 05 — Multi-Add + Tag + Resume

**Session 1 (brief):**

```
I need to add three new capabilities to our project:
1. A Python script that benchmarks test execution time
2. A linter for TOML config files
3. A task that validates all JSON files in the project

Can you help me outline the structure for each?
```

Then run:
```bash
bash scripts/dogfood/05-multi-add-and-tag.sh
```

**Session 2 (resume probe):**

```
claude --continue
```

Then in the resumed session:

```
What's the best way to integrate these new tools into a CI pipeline? I want fast feedback.
```

(The goal: test session_id behavior on resume. Does Claude Code mint a new id or reuse the previous one?)

---

## Day 06 — Fork Experimental Branch

**Session 1 (brief):**

```
I want to try a different approach to the test benchmarking tool. Can you outline what a WebAssembly-based test profiler might look like? Just conceptually — no implementation yet.
```

Then run:
```bash
bash scripts/dogfood/06-fork-experimental.sh
```

---

## Day 07 — No-op + /clear

**Session 1 (in-session clear):**

```
What are the trade-offs between sampling and instrumentation-based profiling?
```

Then, **in the same session before exiting**, type:

```
/clear
```

Then type:

```
Actually, let me start fresh. Can you explain how to set up a simple HTTP server in Node.js that logs request latency?
```

Then `/exit`.

Finally run:
```bash
bash scripts/dogfood/07-noop-and-clear.sh
```

**Session 2 (resume after clear):**

```
claude --continue
```

Then in the resumed session:

```
What's the difference between sync and async request handlers?
```

(The goal: test /clear behavior and session_id on resume.)

---

## Day 08 — Remove Skill

**Session 1 (brief):**

```
We're cleaning up the project. Which of our new tools do you think we should keep, and which ones might be overcomplicated for what we actually need?
```

Then run:
```bash
bash scripts/dogfood/08-remove-skill.sh
```

---

## Day 09 — Bulk Add (most realistic day)

**Session 1 (brief, captures bulk-add):**

```
Let's add a few more productivity tools to the project:
1. A git hook that runs linting before commit
2. A script that generates a project summary from comments
3. A tool that finds unused imports in Python files

Outline the design for each.
```

Then run:
```bash
bash scripts/dogfood/09-bulk-add.sh
```

**Sessions 2, 3, 4 — three FRESH launches on the same post-bulk composition:**

Each is `claude --model claude-haiku-4-5-20251001` (NOT `--continue`). Fresh
launches mint distinct `session_id`s — that's exactly what we want for the
cross-session dedup probe. With `--continue`, all prompts would land on one
session and the probe would degenerate into in-session multi-prompt dedup
(which day-3 already covers). Do not edit any `.claude/` file between the
three sessions — the composition must stay locked so all three observations
land on the same snapshot id.

**Session 2:**

```
claude --model claude-haiku-4-5-20251001
```

Then:

```
How would I integrate the git hook into a monorepo where different packages have different linting rules?
```

`/exit`.

**Session 3:**

```
claude --model claude-haiku-4-5-20251001
```

Then:

```
What's a good approach to handle false positives in unused-import detection?
```

`/exit`.

**Session 4:**

```
claude --model claude-haiku-4-5-20251001
```

Then:

```
When is the terse output-style worth using vs hurting communication? One paragraph.
```

`/exit`.

(The goal: realistic busy day — one interesting snapshot observed by three distinct sessions. Verifies the cross-session dedup property: ONE snapshot, `[3 sessions]` annotation, three trajectories all pointing at the same id.)

---

## Day 10 — Tag v0.2 + Final Audit

**Session 1 (brief reflection):**

```
We've been building this for a while. Looking back at all the tools we added, prototyped, kept, and removed — what do you think the next big missing piece is?
```

Then run:
```bash
bash scripts/dogfood/10-tag-v02-final.sh
```

After this last script, run the audit:

```bash
bash scripts/dogfood/audit.sh
```

---

## TL;DR Session Count

- **Days 01, 02, 04, 06, 08, 10:** 1 session each
- **Days 03, 05, 07:** 2 sessions each
- **Day 09:** 4 sessions (Session 1 brainstorm + 3 fresh post-bulk launches for the cross-session dedup probe)

**Total: ~15 sessions across 10 days**. ~1 hour wall-clock, well under $1 in Haiku tokens.

---

## After Each Script: Check Changes

After each day's script runs, verify the hook fired:

```bash
harness log | head -5
```

You should see fresh snapshot hashes appear.

---

## Multi-Session Probe Checks (v0.3)

After **day 03** and **day 09**, check the dedup behavior:

```bash
harness log --with-sessions | head -10
# Same-composition sessions SHOULD share a snapshot row (the row will
# show '[2 sessions]' or '[3 sessions]' next to it). If you see
# multiple rows for compositions you observed without changing — that's
# a §3.1-strip bug to flag.

harness sessions
# All session_ids should be listed. Each session that ran without
# changing composition should have events > 0 and snapshots = 1.
```

After **day 05** and **day 07**, check resume + /clear behavior:

```bash
harness sessions
# Find each relevant session id from the listing.

harness sessions <resumed-session-id>
# RESUMED sessions in v0.3: per spec/format.md §4.6, the host fires
# SessionStart on resume too (with source=resume). What you'll
# empirically see depends on Claude Code's actual behavior; the
# load-bearing assertion is at least one user_prompt row from the
# resumed session. If a session_start row IS present with source=resume,
# the v0.3 §4.6 narrative matches the host. If it's not, only
# user_prompt rows landed — also fine; the v0.1-era "resume gap"
# framing was a measurement bug, not a host-behavior gap.

harness sessions <post-clear-session-id>
# POST-/clear sessions (if Claude Code mints a new session id on
# /clear, which it historically does): trajectory starts with
# session_start. Snapshot id will likely match the pre-/clear session
# (composition didn't change), demonstrating attribution-only writes
# across distinct sessions.
```

The v0.3 contract: every fire produces an attribution row. Snapshots
are written only when composition changes. Notes are first-class
attribution events — a `harness snap "<text>"` against an unchanged
composition produces ZERO new snapshots and ONE new `note` row.

```bash
# Total fires across the soak:
sqlite3 .harness/lineage.sqlite 'SELECT COUNT(*) FROM attributions;'
# Total unique compositions:
harness log | wc -l
# Ratio of fires to snapshots is the no-change-path "win rate" — high
# is good (most prompts didn't change composition; cache short-circuit
# kicked in).

# Notes ever attached to any snapshot:
sqlite3 .harness/lineage.sqlite "SELECT COUNT(*) FROM attributions WHERE event_kind='note';"
# After day 5 you should see at least 1 (the harness snap "<note>" probe).

# Notes attached to a specific snapshot (Q2 from format.md §2.7):
harness notes <ref>
# Where <ref> is a snapshot id, prefix, branch, tag (e.g. v0.1), or HEAD.
# Surfaces every note ever attached, across sessions, ordered by
# observed_at.
```

---

## Final Audit

```bash
bash scripts/dogfood/audit.sh
```

This produces a human-readable summary of all snapshots, lineage structure, module composition across days, and any anomalies.
