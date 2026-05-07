# Helpers for reading .harness/ state from cases.
#
# Used by W1+ to assert against snapshot blob contents (codePin,
# modules, formatVersion, apmLockfile, etc.) without coupling cases to
# the on-disk path layout.
#
# Source after lib.sh.

# Resolve the snapshot id pointed at by HEAD. Echoes the 40-hex id.
# Errors to stderr if HEAD is missing or the resolution chain breaks.
head_snapshot_id() {
  local cwd=$1
  local head_path="$cwd/.harness/HEAD"
  if [ ! -f "$head_path" ]; then
    printf 'head_snapshot_id: %s missing\n' "$head_path" >&2
    return 1
  fi
  local head
  head=$(cat "$head_path")
  case $head in
    ref:\ *)
      local ref=${head#ref: }
      local ref_path="$cwd/.harness/$ref"
      if [ ! -f "$ref_path" ]; then
        # Branch ref may not exist yet (no commits on the branch).
        printf '' ; return 0
      fi
      cat "$ref_path"
      ;;
    *)
      printf '%s' "$head"
      ;;
  esac
}

# Echo the snapshot blob (raw JSON) for a given snapshot id under
# $cwd/.harness/snapshots/<2-hex>/<rest>.json.
read_snapshot_blob() {
  local cwd=$1 sid=$2
  if [ -z "$sid" ]; then
    printf 'read_snapshot_blob: empty snapshot id\n' >&2
    return 1
  fi
  local prefix=${sid:0:2}
  local rest=${sid:2}
  local path="$cwd/.harness/snapshots/$prefix/$rest.json"
  if [ ! -f "$path" ]; then
    printf 'read_snapshot_blob: %s missing\n' "$path" >&2
    return 1
  fi
  cat "$path"
}

# Convenience: echo the head snapshot blob.
read_head_blob() {
  local cwd=$1
  local sid
  sid=$(head_snapshot_id "$cwd") || return 1
  if [ -z "$sid" ]; then
    printf 'read_head_blob: HEAD has no snapshot yet\n' >&2
    return 1
  fi
  read_snapshot_blob "$cwd" "$sid"
}

# Echo the contents of $cwd/.harness/HEAD verbatim (no newline trim).
read_head_pointer() {
  local cwd=$1
  cat "$cwd/.harness/HEAD"
}

# Count snapshot blobs on disk (ignoring backups).
count_snapshot_blobs() {
  local cwd=$1
  find "$cwd/.harness/snapshots" -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' '
}
