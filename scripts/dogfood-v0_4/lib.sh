# Shared bash helpers for the v0.4 observation playbook. Source from
# each helper script via `source "$(dirname "$0")/lib.sh"`.

set -euo pipefail

# Default scratch directory. Override with V04_DIR=...
V04_DIR="${V04_DIR:-$HOME/harness-v0_4-observe}"

# APM fixture directory (separate from V04_DIR so it can be reused).
APM_FIXTURE_DIR="${APM_FIXTURE_DIR:-$HOME/harness-v0_4-apm-fixture}"

# Resolve harness binaries. Prefer $PATH; fall back to monorepo bins.
MONOREPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HARNESS="${HARNESS:-$(command -v harness 2>/dev/null || echo "$MONOREPO_ROOT/packages/cli/bin/harness")}"
HARNESS_HOOK="${HARNESS_HOOK:-$(command -v harness-hook 2>/dev/null || echo "$MONOREPO_ROOT/packages/hook/bin/harness-hook")}"
APM="${APM:-$(command -v apm 2>/dev/null || echo apm)}"

# Pretty-print step headers / hints.
say()     { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
note()    { printf '   %s\n' "$*"; }
suggest() { printf '\n\033[1;33mNext:\033[0m\n%s\n' "$*"; }

require_v04_dir() {
  if [ ! -d "$V04_DIR/.harness" ]; then
    cat <<EOF >&2
✗ \$V04_DIR=$V04_DIR has no .harness/. Run reset.sh first:
    bash scripts/dogfood-v0_4/reset.sh
EOF
    exit 1
  fi
}

require_apm_fixture() {
  if [ ! -d "$APM_FIXTURE_DIR/.git" ]; then
    cat <<EOF >&2
✗ \$APM_FIXTURE_DIR=$APM_FIXTURE_DIR is not a git repo. Run:
    bash scripts/dogfood-v0_4/setup-apm-fixture.sh
EOF
    exit 1
  fi
}
