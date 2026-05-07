# Bash assertion harness for ci-playbook.sh.
#
# Every helper returns 0 on pass and 1 on fail. On fail it appends to
# CASE_FAILURES (a one-line summary) and CASE_DIAGNOSTICS (multi-line
# context). The runner inspects these arrays after each case and emits
# a YAML diagnostic block on `not ok` lines.
#
# Source after lib-tap.sh (CASE_FAILURES / CASE_DIAGNOSTICS declared
# there).

_assert_fail() {
  local message=$1; shift
  CASE_FAILURES+=("$message")
  while [ "$#" -gt 0 ]; do
    CASE_DIAGNOSTICS+=("$1")
    shift
  done
}

# ---- equality / matching ----

assert_equal() {
  local expected=$1 actual=$2 label=${3:-assert_equal}
  if [ "$expected" = "$actual" ]; then return 0; fi
  _assert_fail "$label" \
    "expected: $(printf '%q' "$expected")" \
    "actual:   $(printf '%q' "$actual")"
  return 1
}

assert_not_equal() {
  local a=$1 b=$2 label=${3:-assert_not_equal}
  if [ "$a" != "$b" ]; then return 0; fi
  _assert_fail "$label" "both equal: $(printf '%q' "$a")"
  return 1
}

assert_contains() {
  local haystack=$1 needle=$2 label=${3:-assert_contains}
  case "$haystack" in
    *"$needle"*) return 0 ;;
  esac
  _assert_fail "$label" \
    "needle:   $(printf '%q' "$needle")" \
    "haystack: $(printf '%q' "$haystack")"
  return 1
}

assert_not_contains() {
  local haystack=$1 needle=$2 label=${3:-assert_not_contains}
  case "$haystack" in
    *"$needle"*)
      _assert_fail "$label" \
        "unexpected needle: $(printf '%q' "$needle")" \
        "haystack:          $(printf '%q' "$haystack")"
      return 1
      ;;
  esac
  return 0
}

assert_matches() {
  local haystack=$1 regex=$2 label=${3:-assert_matches}
  if [[ "$haystack" =~ $regex ]]; then return 0; fi
  _assert_fail "$label" \
    "regex:    $(printf '%q' "$regex")" \
    "haystack: $(printf '%q' "$haystack")"
  return 1
}

assert_count() {
  local expected=$1 actual=$2 label=${3:-assert_count}
  if [ "$expected" = "$actual" ]; then return 0; fi
  _assert_fail "$label" \
    "expected count: $expected" \
    "actual count:   $actual"
  return 1
}

# ---- filesystem ----

assert_file_exists() {
  local path=$1 label=${2:-assert_file_exists}
  if [ -f "$path" ]; then return 0; fi
  _assert_fail "$label" "missing file: $path"
  return 1
}

assert_file_not_exists() {
  local path=$1 label=${2:-assert_file_not_exists}
  if [ ! -e "$path" ]; then return 0; fi
  _assert_fail "$label" "unexpected path present: $path"
  return 1
}

assert_dir_exists() {
  local path=$1 label=${2:-assert_dir_exists}
  if [ -d "$path" ]; then return 0; fi
  _assert_fail "$label" "missing directory: $path"
  return 1
}

assert_dir_not_exists() {
  local path=$1 label=${2:-assert_dir_not_exists}
  if [ ! -d "$path" ]; then return 0; fi
  _assert_fail "$label" "unexpected directory present: $path"
  return 1
}

assert_file_contains() {
  local path=$1 needle=$2 label=${3:-assert_file_contains}
  if [ ! -f "$path" ]; then
    _assert_fail "$label" "missing file: $path"
    return 1
  fi
  if grep -qF -- "$needle" "$path"; then return 0; fi
  _assert_fail "$label" \
    "needle: $(printf '%q' "$needle")" \
    "file:   $path"
  return 1
}

assert_file_hash() {
  local path=$1 expected=$2 label=${3:-assert_file_hash}
  if [ ! -f "$path" ]; then
    _assert_fail "$label" "missing file: $path"
    return 1
  fi
  local actual
  actual=$(sha256sum "$path" | awk '{print $1}')
  if [ "$expected" = "$actual" ]; then return 0; fi
  _assert_fail "$label" \
    "file:     $path" \
    "expected: $expected" \
    "actual:   $actual"
  return 1
}

assert_symlink() {
  local path=$1 label=${2:-assert_symlink}
  if [ -L "$path" ]; then return 0; fi
  _assert_fail "$label" "not a symlink: $path"
  return 1
}

# ---- process / output ----

assert_exit() {
  local expected=$1 actual=$2 label=${3:-assert_exit}
  if [ "$expected" -eq "$actual" ] 2>/dev/null; then return 0; fi
  _assert_fail "$label" \
    "expected exit: $expected" \
    "actual exit:   $actual"
  return 1
}

assert_stdout_matches() {
  local out=$1 regex=$2 label=${3:-assert_stdout_matches}
  if [[ "$out" =~ $regex ]]; then return 0; fi
  _assert_fail "$label" \
    "regex:  $(printf '%q' "$regex")" \
    "stdout: $(printf '%q' "$out")"
  return 1
}

assert_stderr_contains() {
  local err=$1 needle=$2 label=${3:-assert_stderr_contains}
  case "$err" in
    *"$needle"*) return 0 ;;
  esac
  _assert_fail "$label" \
    "needle: $(printf '%q' "$needle")" \
    "stderr: $(printf '%q' "$err")"
  return 1
}

# ---- json / structured ----

assert_json_path() {
  local json=$1 jq_path=$2 expected=$3 label=${4:-assert_json_path}
  local actual
  if ! actual=$(printf '%s' "$json" | jq -r "$jq_path" 2>&1); then
    _assert_fail "$label" \
      "jq path: $jq_path" \
      "jq err:  $actual"
    return 1
  fi
  if [ "$expected" = "$actual" ]; then return 0; fi
  _assert_fail "$label" \
    "jq path:  $jq_path" \
    "expected: $(printf '%q' "$expected")" \
    "actual:   $(printf '%q' "$actual")"
  return 1
}

assert_json_count() {
  local json=$1 jq_path=$2 expected=$3 label=${4:-assert_json_count}
  local actual
  if ! actual=$(printf '%s' "$json" | jq -r "($jq_path) | length" 2>&1); then
    _assert_fail "$label" \
      "jq path: $jq_path" \
      "jq err:  $actual"
    return 1
  fi
  if [ "$expected" = "$actual" ]; then return 0; fi
  _assert_fail "$label" \
    "jq path:        $jq_path" \
    "expected count: $expected" \
    "actual count:   $actual"
  return 1
}
