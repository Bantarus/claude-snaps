# Shared bash helpers for the dogfood soak. Source this from each
# day-script via `source "$(dirname "$0")/lib.sh"`.

set -euo pipefail

# Default scratch directory. Override with SOAK_DIR=...
SOAK_DIR="${SOAK_DIR:-$HOME/harness-dogfood-soak}"

# Resolve harness binaries. Prefer $PATH (pnpm-link-global path); fall
# back to absolute paths inside the monorepo so the scripts work even
# without `pnpm link --global`.
MONOREPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HARNESS="${HARNESS:-$(command -v harness 2>/dev/null || echo "$MONOREPO_ROOT/packages/cli/bin/harness")}"
HARNESS_HOOK="${HARNESS_HOOK:-$(command -v harness-hook 2>/dev/null || echo "$MONOREPO_ROOT/packages/hook/bin/harness-hook")}"

# Pretty-print step headers.
say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
suggest() { printf '\n\033[1;33mNext:\033[0m\n%s\n' "$*"; }

# Refuse to run if the soak directory doesn't exist (i.e. user skipped reset).
require_soak_dir() {
  if [ ! -d "$SOAK_DIR/.harness" ]; then
    cat <<EOF >&2
✗ \$SOAK_DIR=$SOAK_DIR has no .harness/. Run reset.sh first:
    bash scripts/dogfood/reset.sh
EOF
    exit 1
  fi
}

# Write a file relative to $SOAK_DIR with the given content. Creates
# parent dirs. Idempotent.
soak_write() {
  local rel="$1"; shift
  local content="$*"
  local target="$SOAK_DIR/$rel"
  mkdir -p "$(dirname "$target")"
  printf '%s' "$content" > "$target"
  note "wrote $rel ($(wc -c < "$target") bytes)"
}

# Append to an existing file under $SOAK_DIR.
soak_append() {
  local rel="$1"; shift
  local content="$*"
  local target="$SOAK_DIR/$rel"
  mkdir -p "$(dirname "$target")"
  printf '%s' "$content" >> "$target"
  note "appended $rel"
}

# Remove a file or dir under $SOAK_DIR.
soak_rm() {
  local rel="$1"
  local target="$SOAK_DIR/$rel"
  if [ -e "$target" ]; then
    rm -rf "$target"
    note "removed $rel"
  fi
}
