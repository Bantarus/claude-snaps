#!/usr/bin/env bash
# Wipes $SOAK_DIR and recreates it as a fresh, hook-installed harness
# repo. Run before day 02. Safe to run anytime to start over.

source "$(dirname "$0")/lib.sh"

say "soak reset → $SOAK_DIR"

if [ -d "$SOAK_DIR" ]; then
  note "removing existing $SOAK_DIR"
  rm -rf "$SOAK_DIR"
fi

mkdir -p "$SOAK_DIR"
cd "$SOAK_DIR"

# Real git repo so codePin populates in snapshots.
git init -q -b main
git config user.email "soak@harness-dogfood.local"
git config user.name "Soak Tester"
echo "# harness-dogfood-soak" > README.md
git add README.md
git -c commit.gpgsign=false commit -q -m "initial commit"
note "git initialized; commit $(git rev-parse --short HEAD)"

# Baseline .claude/ — minimal, predictable. One skill, one settings.json
# with no hooks (the harness hook is appended next).
mkdir -p .claude/skills/notes
cat > .claude/skills/notes/SKILL.md <<'EOF'
---
name: notes
description: Take quick notes during a session. Stored under notes/ in the project.
---

# notes

Keep a running log of decisions and TODOs while working on this project.
Persist them to `notes/<topic>.md` using the Write tool when the user
says "note that <X>" or asks you to remember something.
EOF
note "wrote .claude/skills/notes/SKILL.md"

cat > .claude/settings.json <<'EOF'
{
  "model": "claude-haiku-4-5-20251001"
}
EOF
note "wrote .claude/settings.json (model pinned to haiku)"

# harness init + install-hook. install-hook reads the local settings.json
# and writes the SessionStart entry into it.
"$HARNESS" init >/dev/null
note "harness init complete"

# install-hook needs an interactive 'y' confirmation. Pipe it in.
# (CLI install-hook is the v0.2 dual-event installer; writes BOTH
# SessionStart and UserPromptSubmit entries.)
if echo "y" | "$HARNESS" install-hook >/dev/null 2>&1; then
  note "installed harness-hook (SessionStart + UserPromptSubmit) via 'harness install-hook'"
else
  # Fallback: write both entries manually.
  python3 - "$SOAK_DIR/.claude/settings.json" <<'PYEOF'
import json, sys
p = sys.argv[1]
s = json.load(open(p))
hooks = s.setdefault('hooks', {})
for event in ('SessionStart', 'UserPromptSubmit'):
    hooks.setdefault(event, []).append({
        'matcher': '*',
        'hooks': [{'type': 'command', 'command': 'harness-hook'}],
    })
open(p, 'w').write(json.dumps(s, indent=2))
PYEOF
  note "installed harness-hook (SessionStart + UserPromptSubmit) via fallback"
fi

# Sanity probe: fire the hook with a synthetic stdin to confirm everything
# wires up before the user starts day 02. Uses a "reset" session id so it
# doesn't conflict with anything Claude Code might generate.
say "hook smoke-test"
echo "{\"session_id\":\"soak-reset-$(date +%s)\",\"cwd\":\"$SOAK_DIR\",\"hook_event_name\":\"SessionStart\",\"source\":\"startup\"}" | \
  "$HARNESS_HOOK" 2>&1
"$HARNESS" log 2>&1 | head -3

suggest "$(cat <<EOF
Soak directory ready at: $SOAK_DIR

Day 1 baseline is already snapshotted (the smoke-test fire above).

To proceed:
  bash scripts/dogfood/02-add-skill.sh
EOF
)"
