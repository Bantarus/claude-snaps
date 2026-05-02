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
  # Expect: a tag snapshot for v0.1 referencing the day-5 manual
  # snapshot (kind=manual; v0.2 has no 'auto' kind).

Resume probe (Session 2 — see PROMPTS.md):
  cd $SOAK_DIR
  claude --continue
  > <follow-up prompt from PROMPTS.md>
  /exit

After the resumed session:
  $HARNESS sessions
  # Find the resumed session's id (same as the original day-5 session).
  $HARNESS sessions <session-id>
  # Expect: a trajectory with NO session_start row (resume skips it)
  # but WITH one or more user_prompt rows for prompts in the resumed
  # session. This is the v0.2 closure of the resume gap.
EOF
)"
