#!/usr/bin/env bash
# Wipes $V04_DIR and recreates it as a fresh, hook-installed harness
# project. Mirrors the v0.3 dogfood reset shape but starts at v0.4.0:
#   - real git repo (so codePin populates)
#   - minimal .claude/ baseline (one local skill, settings.json with
#     model field so install-hook has something to merge into)
#   - harness init + harness install-hook
#   - one baseline observation
#
# Run once before walking PLAYBOOK.md.

source "$(dirname "$0")/lib.sh"

say "v0.4 observation reset → $V04_DIR"

if [ -d "$V04_DIR" ]; then
  note "removing existing $V04_DIR"
  rm -rf "$V04_DIR"
fi

mkdir -p "$V04_DIR"
cd "$V04_DIR"

git init -q -b main
git config user.email "v04-observe@harness.local"
git config user.name "v0.4 Observer"
echo "# harness-v0_4-observe" > README.md
git add README.md
git -c commit.gpgsign=false commit -q -m "initial commit"
note "git init at $(git rev-parse --short HEAD)"

# Baseline .claude/ — one local skill + a settings.json with a model
# field. Pre-populating settings.json exercises the v0.3.x install-hook
# fix path (untracked .claude/settings.json + git repo).
mkdir -p .claude/skills/notes
cat > .claude/skills/notes/SKILL.md <<'SKILL'
---
name: notes
description: Local notes skill — fixture for v0.4 observation
---
# Notes

Baseline local skill installed before harness is initialized.
SKILL

cat > .claude/settings.json <<'JSON'
{
  "model": "claude-haiku-4-5-20251001"
}
JSON

note "baseline .claude/ written (1 skill + settings.json with model field)"

"$HARNESS" init >/dev/null
note "harness init done"

# install-hook needs interactive confirmation ('y' on the diff prompt).
# Pipe stdin so it runs unattended.
echo "y" | "$HARNESS" install-hook >/dev/null
note "harness install-hook merged hook config (untracked settings.json path)"

# A baseline manual snap so we have at least one snapshot to play with.
"$HARNESS" snap "v0.4 observe baseline" >/dev/null
note "baseline snap captured"

say "ready"
suggest "Open PLAYBOOK.md and start at Phase A → A1."
