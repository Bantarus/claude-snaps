#!/usr/bin/env bash
# Day 04 — extend settings.json with an mcpServers entry.
# Tests: mcp module capture from settings.json (untested in v0.1 dogfood).

source "$(dirname "$0")/lib.sh"
require_soak_dir
say "day 04 — add mcp server: filesystem-mcp"

# Read-modify-write settings.json. Use python for safety against
# arbitrary existing content (settings already has the harness hook
# from reset.sh).
python3 - "$SOAK_DIR/.claude/settings.json" <<'PYEOF'
import json, sys
p = sys.argv[1]
s = json.load(open(p))
s.setdefault('mcpServers', {})
s['mcpServers']['filesystem'] = {
    'command': 'mcp-filesystem',
    'args': ['--root', '/tmp/dogfood-fs'],
    'env': {'MCP_LOG_LEVEL': 'info'},
}
open(p, 'w').write(json.dumps(s, indent=2) + '\n')
PYEOF
note "added mcpServers.filesystem to .claude/settings.json"

suggest "$(cat <<EOF
  cd $SOAK_DIR
  claude --model claude-haiku-4-5-20251001
  > what MCP servers are configured?
  /exit

After exiting:
  $HARNESS diff <day-3-id> <day-4-id>
  # Expect: + mcp filesystem (configHash over the mcpServers.filesystem block).
  # Important: hook module from settings.json should NOT have changed —
  # capture hashes per-block, not the whole settings.json file.
EOF
)"
