#!/usr/bin/env bash
# Sets up $APM_FIXTURE_DIR as a real git repo containing one APM skill.
# Used by Phase B of the playbook to exercise the v0.4.1 local-path
# APM enrichment without network. Idempotent (wipes and rebuilds).

source "$(dirname "$0")/lib.sh"

say "apm fixture → $APM_FIXTURE_DIR"

if [ -d "$APM_FIXTURE_DIR" ]; then
  rm -rf "$APM_FIXTURE_DIR"
fi
mkdir -p "$APM_FIXTURE_DIR/.apm/skills/apm-test"
cd "$APM_FIXTURE_DIR"

cat > .apm/skills/apm-test/SKILL.md <<'SKILL'
---
name: apm-test
description: APM fixture skill — installed via local-path dep for v0.4 observation
---
# APM Test Skill

This skill is installed via APM from a local fixture path. The
v0.4.1 reader synthesizes its identity (package=`_local/<name>`,
resolvedCommit=git HEAD) so capture sees it as apm-kind.
SKILL

cat > apm.yml <<'APMYML'
name: harness-v04-test-fixture
version: 1.0.0
APMYML

git init -q -b main
git config user.email "fixture@harness.local"
git config user.name "Fixture"
git add -A
git -c commit.gpgsign=false commit -q -m "init fixture"
SHA=$(git rev-parse HEAD)
note "fixture HEAD: $SHA"

say "ready"
suggest "Phase B steps reference \$APM_FIXTURE_DIR=$APM_FIXTURE_DIR"
