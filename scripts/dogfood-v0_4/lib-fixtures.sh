# Per-workflow fixture helpers for ci-playbook.sh.
#
# Each fixture creates an isolated project directory under
# $CIP_SCRATCH and exports FIXTURE_DIR pointing at it. Cases use
# $FIXTURE_DIR as the cwd for harness/hook invocations. Fixtures are
# idempotent (wipe + rebuild every call) so cases don't pollute each
# other.
#
# Source after lib.sh (HARNESS / HARNESS_HOOK / APM exported there).

# Per-run scratch root. The runner sets this in main().
: "${CIP_SCRATCH:=/tmp/harness-cip-scratch}"

# Reset $FIXTURE_DIR to a fresh subdir of $CIP_SCRATCH and cd there.
# All fixtures use this as their first step so they all start from
# clean state and pick up a unique slug.
_fixture_init() {
  local slug=$1
  local dir="$CIP_SCRATCH/$slug-$$-$RANDOM"
  rm -rf "$dir"
  mkdir -p "$dir"
  FIXTURE_DIR="$dir"
}

# Empty tmpdir; no .harness/, no .claude/, no apm artifacts.
fixture_empty_project() {
  _fixture_init empty
  # nothing else
}

# Empty tmpdir with .git initialized (so codePin can populate).
fixture_empty_git_project() {
  _fixture_init empty-git
  (
    cd "$FIXTURE_DIR"
    git init -q -b main
    git config user.email "cip@harness.local"
    git config user.name "cip"
    echo "# fixture" > README.md
    git add README.md
    git -c commit.gpgsign=false commit -q -m "init"
  )
}

# Baseline: git repo + minimal .claude/ + harness init + install-hook.
# Mirrors reset.sh's shape but scoped to FIXTURE_DIR.
fixture_baseline_no_apm() {
  _fixture_init baseline
  (
    cd "$FIXTURE_DIR"
    git init -q -b main
    git config user.email "cip@harness.local"
    git config user.name "cip"
    echo "# baseline" > README.md
    git add README.md
    git -c commit.gpgsign=false commit -q -m "init"

    mkdir -p .claude/skills/notes
    cat > .claude/skills/notes/SKILL.md <<'SKILL'
---
name: notes
description: baseline local skill
---
# Notes
baseline
SKILL
    cat > .claude/settings.json <<'JSON'
{"model": "claude-haiku-4-5-20251001"}
JSON

    "$HARNESS" init >/dev/null
    echo "y" | "$HARNESS" install-hook >/dev/null
  )
}

# Baseline + apm.yml + apm install (local-path dep against an APM
# fixture in $CIP_APM_FIXTURE). The dependency syntax APM accepts is
# a list of absolute paths under `dependencies.apm`; that produces
# `source: local` lockfile entries which v0.4.1 capture-side
# enrichment recognizes as apm-kind modules.
#
# Pre-creates .claude/ so APM auto-target-detection picks "claude"
# (else it falls back to .github/ and the .claude/ deploy paths
# the reproducer cares about don't materialize).
fixture_baseline_with_apm() {
  fixture_baseline_no_apm
  _ensure_apm_fixture
  (
    cd "$FIXTURE_DIR"
    # baseline already created .claude/ — keep it.
    cat > apm.yml <<APMYML
name: cip-test-project
version: 1.0.0
dependencies:
  apm:
    - $CIP_APM_FIXTURE
APMYML
    "$APM" install >/dev/null 2>&1
    # Capture so the snapshot reflects the apm-installed state.
    fire_session_start "$FIXTURE_DIR" cip-baseline-apm startup >/dev/null 2>&1 || true
  )
}

# Baseline + 2 additional auto snapshots (3 total in lineage).
fixture_lineage_3_snapshots() {
  fixture_baseline_no_apm
  (
    cd "$FIXTURE_DIR"
    fire_session_start "$FIXTURE_DIR" cip-l1 startup
    # Mutate composition so a new snapshot writes.
    mkdir -p .claude/skills/extra1
    cat > .claude/skills/extra1/SKILL.md <<'SKILL'
---
name: extra1
description: lineage step 1
---
# extra1
SKILL
    fire_session_start "$FIXTURE_DIR" cip-l2 startup
    mkdir -p .claude/skills/extra2
    cat > .claude/skills/extra2/SKILL.md <<'SKILL'
---
name: extra2
description: lineage step 2
---
# extra2
SKILL
    fire_session_start "$FIXTURE_DIR" cip-l3 startup
  )
}

# Baseline + at least one snapshot + a second branch named
# "experimental" off HEAD. Both branches initially point at the same
# snapshot id; cases that need divergence can fire / mutate / re-fire
# after switching branches.
fixture_branched() {
  fixture_baseline_no_apm
  (
    cd "$FIXTURE_DIR"
    "$HARNESS" snap "branched baseline" >/dev/null
    "$HARNESS" branch experimental >/dev/null
  )
}

# Baseline + at least one snapshot + a "v0.1" tag at HEAD.
fixture_tagged() {
  fixture_baseline_no_apm
  (
    cd "$FIXTURE_DIR"
    "$HARNESS" snap "tagged baseline" >/dev/null
    "$HARNESS" tag v0.1 >/dev/null
  )
}

# Baseline + lineage + truncate one snapshot blob's JSON to "{}".
# Used by W7 corruption-recovery cases.
fixture_corrupted_blob() {
  fixture_lineage_3_snapshots
  (
    cd "$FIXTURE_DIR"
    # Corrupt HEAD's parent blob — deterministically traversed by
    # `harness log` when rendering the HEAD row's diff summary, so
    # readSnapshot fires and surfaces the integrity error. Picking
    # "first blob alphabetically" was id-ordering-dependent and would
    # silently land on the init blob (which has no children to walk
    # AS a parent), letting `harness log` complete without surfacing
    # the corruption — see W7.3.
    local head_id; head_id=$(cat .harness/refs/heads/main 2>/dev/null)
    if [ -z "$head_id" ]; then
      echo "fixture_corrupted_blob: no HEAD on main" >&2
      return 1
    fi
    local head_blob=".harness/snapshots/${head_id:0:2}/${head_id:2}.json"
    if [ ! -f "$head_blob" ]; then
      echo "fixture_corrupted_blob: HEAD blob missing at $head_blob" >&2
      return 1
    fi
    local parent_id
    parent_id=$(python3 -c "
import json, sys
with open(sys.argv[1]) as f: snap = json.load(f)
parents = snap.get('parentIds', [])
print(parents[0] if parents else '', end='')
" "$head_blob")
    if [ -z "$parent_id" ]; then
      echo "fixture_corrupted_blob: HEAD has no parent (lineage_3 should have produced one)" >&2
      return 1
    fi
    local parent_blob=".harness/snapshots/${parent_id:0:2}/${parent_id:2}.json"
    if [ ! -f "$parent_blob" ]; then
      echo "fixture_corrupted_blob: parent blob missing at $parent_blob" >&2
      return 1
    fi
    printf '{}' > "$parent_blob"
  )
}

# Baseline + write garbage into HEAD.
fixture_corrupted_head() {
  fixture_baseline_no_apm
  (
    cd "$FIXTURE_DIR"
    printf 'this is not a valid HEAD pointer\n' > .harness/HEAD
  )
}

# ---- helpers ----

# Ensure $CIP_APM_FIXTURE exists as a fresh git repo with a single
# .apm/skills/apm-test/SKILL.md. Idempotent across cases — built once
# per playbook run, reused.
CIP_APM_FIXTURE_BUILT=0
_ensure_apm_fixture() {
  CIP_APM_FIXTURE="${CIP_APM_FIXTURE:-$CIP_SCRATCH/_apm-fixture}"
  if [ "$CIP_APM_FIXTURE_BUILT" -eq 1 ] && [ -d "$CIP_APM_FIXTURE/.git" ]; then
    return 0
  fi
  rm -rf "$CIP_APM_FIXTURE"
  mkdir -p "$CIP_APM_FIXTURE/.apm/skills/apm-test"
  (
    cd "$CIP_APM_FIXTURE"
    cat > .apm/skills/apm-test/SKILL.md <<'SKILL'
---
name: apm-test
description: apm fixture skill (cip)
---
# apm-test
fixture
SKILL
    cat > apm.yml <<'APMYML'
name: cip-apm-fixture
version: 1.0.0
APMYML
    git init -q -b main
    git config user.email "fixture@harness.local"
    git config user.name "fixture"
    git add -A
    git -c commit.gpgsign=false commit -q -m "init fixture"
  )
  CIP_APM_FIXTURE_BUILT=1
}
