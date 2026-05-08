# JSONL line-by-line parser tolerance helpers.
#
# Locks the strategy the v0.5 `harness ingest-session` ingester
# will use for reading `transcript_path` files: read each line
# terminated by `\n`, parse it as JSON; silently drop any trailing
# partial line (no newline). Matches Linux append-mode atomicity
# (single-writer per session, line-atomic up to PIPE_BUF=4KB).
#
# This file is sourced by ci-playbook.sh runner via the lib-* glob.

# parse_jsonl_complete_lines <path>
# Echoes one line per fully-formed JSONL record (newline-terminated +
# valid JSON). Drops any trailing partial line silently. Drops any
# line that fails JSON parse (corruption tolerance). Outputs each
# valid line on stdout, in input order.
parse_jsonl_complete_lines() {
  local path=$1
  if [ ! -f "$path" ]; then
    return 0
  fi
  # awk-style: keep only lines that end the file with a \n. Then
  # filter through jq -c '.' which fails on parse error per line.
  # The `head -c -1` would chop a final newline; we want to KEEP
  # newline-terminated lines and DROP the trailing line if no
  # newline. POSIX-portable trick: `sed -n /^.\+/p` only emits
  # complete lines (sed processes a line only when it sees \n).
  sed -n p "$path" \
    | while IFS= read -r line; do
        printf '%s\n' "$line" | jq -c '.' 2>/dev/null && true
      done
}

# count_complete_jsonl_lines <path>
# Number of fully-formed JSONL records (newline-terminated +
# valid JSON). Convenience wrapper.
count_complete_jsonl_lines() {
  parse_jsonl_complete_lines "$1" | wc -l | tr -d ' '
}
