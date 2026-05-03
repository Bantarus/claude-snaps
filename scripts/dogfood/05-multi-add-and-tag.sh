#!/usr/bin/env bash
# Day 05 — multi-change case: 3 new things at once + tag a release.
# Tests: upper-end diff readability. Tag-kind snapshot path.

source "$(dirname "$0")/lib.sh"
require_soak_dir
say "day 05 — multi-add: CLAUDE.md + code-reviewer agent + /recap command, then tag v0.1"

# 1. Project-level CLAUDE.md instruction.
cat > "$SOAK_DIR/CLAUDE.md" <<'EOF'
# Project rules — harness-dogfood-soak

This is a synthetic soak project. Notes are stored under `notes/` as
`YYYY-MM-DD-<topic>.md`. Tests live under `tests/`. The default model
is claude-haiku-4-5-20251001.

Don't write to `.harness/` directly — it's managed by harness-hook.
EOF
note "wrote CLAUDE.md"

# 2. Subagent — exercises the .claude/agents/ capture path.
mkdir -p "$SOAK_DIR/.claude/agents"
cat > "$SOAK_DIR/.claude/agents/code-reviewer.md" <<'EOF'
---
name: code-reviewer
description: Quick second opinion on a diff. Reads the staged changes and flags risk.
---

# code-reviewer

Run `git diff --cached` or `git diff HEAD~1`. Skim for:
- error-handling that swallows failures silently
- tests that assert what the implementation does, not what the spec requires
- new dependencies introduced without a paragraph on why

Output a one-screen review: 3 strongest concerns, ranked.
EOF
note "wrote .claude/agents/code-reviewer.md"

# 3. Slash command.
mkdir -p "$SOAK_DIR/.claude/commands"
cat > "$SOAK_DIR/.claude/commands/recap.md" <<'EOF'
---
name: recap
description: One-paragraph summary of the current session so far.
---

Look back over the conversation. Produce a one-paragraph recap covering:
- the goal we started with
- the most surprising thing we learned
- the next deliberate step

Keep it under 5 sentences.
EOF
note "wrote .claude/commands/recap.md"

suggest "$(cat <<EOF
  cd $SOAK_DIR
  claude --model claude-haiku-4-5-20251001
  > what's new in this project today? include CLAUDE.md, agents, and slash commands.
  /exit

After exiting, tag this snapshot as v0.1:
  $HARNESS log | head -1                    # grab the new snapshot id
  $HARNESS tag v0.1 <that-id>

Then:
  $HARNESS diff <day-4-id> <day-5-id>
  # Expect: 3 additions — instruction CLAUDE.md, agent code-reviewer,
  # prompt /recap. THIS is the upper-end readability test: does the diff
  # output stay legible with multiple additions?
  $HARNESS log | head -10
  # Expect: a tag snapshot for v0.1 above the auto snapshot whose summary
  # reads "+1 instruction, +1 agent, +1 prompt" (computed at read time).
  # In v0.3 the kind is 'auto', not 'manual' (renamed in v0.3.0 §2.2).

User-note probe (no Claude session — direct CLI):
  cd $SOAK_DIR
  $HARNESS snap "promoting baseline composition to v0.1"
  # Expect: 'No composition change since <id>; note attached to existing
  # snapshot.' This is the v0.3 note attribution event path — ZERO new
  # snapshots, ONE new note row attached to the existing v0.1 tag's
  # snapshot id. The CLI uses the literal sessionId '<manual>' so the
  # note shows up under that session in trajectory listings.

  $HARNESS notes v0.1
  # Expect: '<manual>  "promoting baseline composition to v0.1"'.
  # The Q2 cross-session-notes query from format.md §2.7. Same query
  # works against any ref (id prefix, branch name, tag name, HEAD).

Resume probe (Session 2 — see PROMPTS.md):
  cd $SOAK_DIR
  claude --continue
  > <follow-up prompt from PROMPTS.md>
  /exit

After the resumed session:
  $HARNESS sessions
  # Find the resumed session's id (same as the original day-5 session).
  $HARNESS sessions <session-id>
  # v0.3 expectation per spec/format.md §4.6: the host fires
  # SessionStart on resume too (with source=resume). What you'll
  # actually see depends on Claude Code's behavior in your install.
  # The load-bearing assertion is: at least one user_prompt row from
  # the resumed prompts. If a session_start row is present with
  # source=resume, that confirms §4.6 against the host. Either way
  # the v0.1-era "resume gap" framing was a measurement bug, not a
  # host-behavior gap.
EOF
)"
