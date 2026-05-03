#!/usr/bin/env bash
# Day 09 — bulk-add: 2 new skills + 1 output-style + 1 command at once.
# Tests: capture handles many additions; diff readability ceiling.

source "$(dirname "$0")/lib.sh"
require_soak_dir
say "day 09 — bulk add: 4 things at once"

mkdir -p "$SOAK_DIR/.claude/skills/git-explain"
cat > "$SOAK_DIR/.claude/skills/git-explain/SKILL.md" <<'EOF'
---
name: git-explain
description: Translate a git diff into a one-paragraph explanation a non-coder could read.
---

# git-explain

Given a `git diff`, produce a paragraph (≤4 sentences) describing what
changed in plain language — what file, what intent, what risk.
EOF
note "added .claude/skills/git-explain/SKILL.md"

mkdir -p "$SOAK_DIR/.claude/skills/profile-bench"
cat > "$SOAK_DIR/.claude/skills/profile-bench/SKILL.md" <<'EOF'
---
name: profile-bench
description: Run a microbenchmark and isolate the slow function.
---

# profile-bench

Detect the runtime (Node / Python). Profile the slowest test or a
user-named function. Report top 3 hot frames + a guess at the cause.
EOF
note "added .claude/skills/profile-bench/SKILL.md"

mkdir -p "$SOAK_DIR/.claude/output-styles"
cat > "$SOAK_DIR/.claude/output-styles/terse.md" <<'EOF'
---
name: terse
description: Reply in ≤3 sentences. Skip preamble. Cite line numbers, not paragraphs.
---

Default to one sentence per assertion. Cite specific lines (`file.ts:42`)
instead of "around the middle of file.ts". Skip "Here's what I did" and
"Let me know if you need more" framing — go straight to the change or
the answer.
EOF
note "added .claude/output-styles/terse.md"

cat > "$SOAK_DIR/.claude/commands/note.md" <<'EOF'
---
name: note
description: Append a quick note to today's notes file.
---

Append the rest of the user's message to `notes/$(date +%Y-%m-%d)-jot.md`.
Create the file if missing. No prose response — a one-line confirmation
("noted") is enough.
EOF
note "added .claude/commands/note.md"

suggest "$(cat <<EOF
  cd $SOAK_DIR
  claude --model claude-haiku-4-5-20251001
  > what skills, styles, and commands exist now? give me a short table.
  /exit

After exiting:
  $HARNESS log | head -3
  # Expect: a new auto snapshot whose summary reads
  # "+2 skills, +1 prompt, +1 style" (computed at read time —
  # adds are grouped by type, no names listed for adds; only
  # removals/changes show names in parens).
  $HARNESS diff <day-8-id> <day-9-id>
  # Expect: 4 additions in one diff:
  #   + skill git-explain
  #   + skill profile-bench
  #   + style terse
  #   + prompt /note
  # CRITICAL question: is this output legible at 4 changes? If the diff
  # feels cluttered at 4, that's a v0.4 ergonomic backlog item — the
  # CLI may need grouping output by module type.

Multi-session probe (Sessions 2-3 — see PROMPTS.md):
  Each follow-up uses claude --continue with a benign question; no file
  edits between them. After they finish:

  $HARNESS log --with-sessions | head -5
  # Expect: the day-9 snapshot row shows '[2 sessions]' or '[3 sessions]'
  # depending on how many continues you fired. ONE snapshot, multiple
  # trajectories — the dedup-at-scale verification.

  $HARNESS sessions <day-9-session-id>
  # Expect: the original session's trajectory shows session_start +
  # user_prompts; resumed sessions show user_prompts only. All point
  # at the same snapshot id (= sign in trajectory output).
EOF
)"
