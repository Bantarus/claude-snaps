#!/usr/bin/env bash
# Day 03 — modification case: an existing SKILL.md changes content.
# Tests: configHash drift on a module that already exists in HEAD.

source "$(dirname "$0")/lib.sh"
require_soak_dir
say "day 03 — modify skill: notes"

cat > "$SOAK_DIR/.claude/skills/notes/SKILL.md" <<'EOF'
---
name: notes
description: Take quick notes during a session. Stored under notes/ in the project, with a date prefix.
---

# notes

Keep a running log of decisions and TODOs while working on this project.
Persist them to `notes/YYYY-MM-DD-<topic>.md` using the Write tool when
the user says "note that <X>" or asks you to remember something.

Group related notes into the same file when possible. Don't create a
new file per note — append.
EOF
note "modified .claude/skills/notes/SKILL.md (description + body extended)"

suggest "$(cat <<EOF
  cd $SOAK_DIR
  claude --model claude-haiku-4-5-20251001
  > what changed in the notes skill?
  /exit

After exiting:
  $HARNESS log | head -3
  # Expect: a new auto snapshot whose per-row summary reads
  # "~1 skill (notes)" — single change so the name appears in parens.
  $HARNESS diff <day-2-id> <day-3-id>
  # Expect: ~ skill notes (configHash differs). Nothing added or removed.
  # The diff should be visibly minimal — this is the "small drift"
  # signal-to-noise probe.

Optional Session 2 (dedup probe — see PROMPTS.md):
  Re-launch claude with the SAME prompt or a benign follow-up; do not
  edit any files. After /exit, verify:
    $HARNESS log | wc -l
    # Expect: NO new snapshot — the second session's composition was
    # unchanged, so the hook took the no-change path and recorded an
    # attribution row only.
    $HARNESS log --with-sessions | head -3
    # Expect: the day-3 snapshot row shows '[2 sessions]' (or however
    # many same-composition sessions you fired).
EOF
)"
