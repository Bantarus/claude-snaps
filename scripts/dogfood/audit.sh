#!/usr/bin/env bash
# End-of-soak audit. Runs harness log + harness diff between key tags,
# all spec gates, the gitignore-vs-tree audit, and reports anything
# that quietly drifted. Pipe to a file:
#
#   bash scripts/dogfood/audit.sh > soak-report.txt 2>&1
#
# Designed to be readable as a soak-report appendix in the next
# conversation.

source "$(dirname "$0")/lib.sh"
require_soak_dir

cd "$SOAK_DIR"

printf '\n========================================\n'
printf 'DOGFOOD SOAK AUDIT\n'
printf '%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
printf 'soak dir: %s\n' "$SOAK_DIR"
printf 'monorepo: %s\n' "$MONOREPO_ROOT"
printf '========================================\n\n'

printf '1) harness log (full DAG, newest first)\n----------------\n'
"$HARNESS" log 2>&1 || true
printf '\n\n'

printf '2) Branches and tags\n----------------\n'
ls -1 .harness/refs/heads/ 2>/dev/null | sed 's/^/  branch: /' || true
ls -1 .harness/refs/tags/ 2>/dev/null  | sed 's/^/  tag:    /' || true
printf '\n'

printf '3) Snapshot count by kind\n----------------\n'
python3 - <<'PYEOF'
import json, os
counts = {}
for root, _, files in os.walk('.harness/snapshots'):
    for f in files:
        if f.endswith('.json'):
            blob = json.load(open(os.path.join(root, f)))
            counts[blob['kind']] = counts.get(blob['kind'], 0) + 1
for k in sorted(counts): print(f'  {k:<8} {counts[k]}')
print(f'  total    {sum(counts.values())}')
PYEOF
printf '\n'

printf '4) Module composition trend (count per snapshot, by source.kind)\n----------------\n'
python3 - <<'PYEOF'
import json, os
rows = []
for root, _, files in os.walk('.harness/snapshots'):
    for f in files:
        if f.endswith('.json'):
            blob = json.load(open(os.path.join(root, f)))
            kinds = {}
            for m in blob['modules']:
                k = m['source']['kind']
                kinds[k] = kinds.get(k, 0) + 1
            # v0.2: message is nullable — render '(null)' for hook captures.
            msg = blob.get('message')
            msg_text = (msg if isinstance(msg, str) else '(null)')[:30]
            rows.append((blob['createdAt'], blob['id'][:8], blob['kind'], blob['branch'],
                         msg_text, kinds))
rows.sort()
print(f'  {"created":<24} {"id":<10} {"kind":<8} {"branch":<14} {"msg":<32} {"modules":<25}')
print(f'  {"-"*24} {"-"*10} {"-"*8} {"-"*14} {"-"*32} {"-"*25}')
for ts, id8, kind, branch, msg, kinds in rows:
    kstr = ', '.join(f'{k}:{n}' for k, n in sorted(kinds.items()))
    print(f'  {ts:<24} {id8:<10} {kind:<8} {branch:<14} {msg:<32} {kstr:<25}')
PYEOF
printf '\n'

printf '4b) Attribution events (v0.2)\n----------------\n'
if [ -f .harness/lineage.sqlite ]; then
  python3 - <<'PYEOF'
import sqlite3
con = sqlite3.connect('.harness/lineage.sqlite')
# Counts by event kind.
print('  event_kind        count')
print('  ' + '-'*24)
for row in con.execute(
    "SELECT event_kind, COUNT(*) FROM attributions GROUP BY event_kind ORDER BY event_kind"
):
    print(f'  {row[0]:<16}  {row[1]}')
total = con.execute("SELECT COUNT(*) FROM attributions").fetchone()[0]
print(f'  {"total":<16}  {total}')
print()
# Sessions observed and their trajectory lengths.
print(f'  {"session_id":<32}  {"events":>6}  {"snapshots":>9}  first_seen')
print('  ' + '-'*32 + '  ' + '-'*6 + '  ' + '-'*9 + '  ' + '-'*24)
for row in con.execute("""
    SELECT session_id, COUNT(*) AS events, COUNT(DISTINCT snapshot_id) AS snaps,
           MIN(observed_at) AS first_seen
      FROM attributions
     GROUP BY session_id
     ORDER BY first_seen
"""):
    sid, events, snaps, first_seen = row
    print(f'  {sid[:32]:<32}  {events:>6}  {snaps:>9}  {first_seen}')
con.close()
PYEOF
else
  printf '  (no lineage.sqlite — has the hook fired yet?)\n'
fi
printf '\n'

printf '5) Worked diffs\n----------------\n'
# Pull the v0.1 and v0.2 tag ids if present, plus first and last snapshot.
V01="$(cat .harness/refs/tags/v0.1 2>/dev/null || true)"
V02="$(cat .harness/refs/tags/v0.2 2>/dev/null || true)"
FIRST="$("$HARNESS" log 2>/dev/null | tail -1 | awk '{print $1}' || true)"
LAST="$("$HARNESS"  log 2>/dev/null | head -1 | awk '{print $1}' || true)"

if [ -n "$V01" ] && [ -n "$V02" ]; then
  printf '\n  diff v0.1 → v0.2 (the meaningful soak delta):\n'
  "$HARNESS" diff "$V01" "$V02" 2>&1 | sed 's/^/    /' || true
fi
if [ -n "$FIRST" ] && [ -n "$LAST" ] && [ "$FIRST" != "$LAST" ]; then
  printf '\n  diff baseline → latest (full soak delta):\n'
  "$HARNESS" diff "$FIRST" "$LAST" 2>&1 | sed 's/^/    /' || true
fi
printf '\n'

printf '6) Hook firings (Claude Code JSONL trail)\n----------------\n'
JSONL_DIR="$HOME/.claude/projects/$(pwd | tr / -)"
if [ -d "$JSONL_DIR" ]; then
  printf '  jsonl dir: %s\n' "$JSONL_DIR"
  # Count attachment.hookEvent entries per session jsonl.
  for f in "$JSONL_DIR"/*.jsonl; do
    [ -f "$f" ] || continue
    n=$(python3 -c "
import json, sys
c = 0
for line in open(sys.argv[1]):
    try:
        d = json.loads(line)
        if d.get('type') == 'attachment' and d.get('attachment', {}).get('hookEvent'):
            c += 1
    except Exception: pass
print(c)
" "$f")
    sid="$(basename "$f" .jsonl)"
    printf '  %s  hook firings: %s\n' "${sid:0:8}" "$n"
  done
else
  printf '  (no jsonl dir found at %s — Claude Code may not have run yet)\n' "$JSONL_DIR"
fi
printf '\n'

cd "$MONOREPO_ROOT"

printf '7) Spec gates (run from monorepo)\n----------------\n'
printf '\n  schema agreement:\n'
python3 scripts/check_schema_agreement.py 2>&1 | tail -2 | sed 's/^/    /'
printf '\n  format-version-bump (vs HEAD):\n'
python3 scripts/check_format_version_bump.py 2>&1 | sed 's/^/    /'
printf '\n  canonical-501 byte-stability (v0.2.0 fixture):\n'
BEFORE=$(sha256sum spec/test-vectors/canonical-501.bin | awk '{print $1}')
python3 scripts/build_examples.py >/dev/null 2>&1
AFTER=$(sha256sum spec/test-vectors/canonical-501.bin | awk '{print $1}')
if [ "$BEFORE" = "$AFTER" ]; then
  printf '    ✓ byte-identical (%s)\n' "$AFTER"
else
  printf '    ✗ DRIFT: before=%s after=%s\n' "$BEFORE" "$AFTER"
fi
printf '\n'

printf '8) Working tree vs git audit\n----------------\n'
ORPHANS=$(comm -23 \
  <(find . -type f -not -path './.git/*' -not -path './node_modules/*' -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path './.pnpm-store/*' 2>/dev/null | sort) \
  <(git ls-files | sed 's|^|./|' | sort) \
  | grep -v -E '^\./.harness/|node_modules' || true)
if [ -z "$ORPHANS" ]; then
  printf '  ✓ no orphan files (every file on disk is tracked or correctly ignored)\n'
else
  printf '  ✗ ORPHANS FOUND:\n'
  echo "$ORPHANS" | sed 's/^/    /'
fi
TRACKED_BLOBS=$(git ls-files spec/examples | grep '\.json$' | wc -l)
DISK_BLOBS=$(find spec/examples -name '*.json' -type f | wc -l)
printf '  spec example blobs:  on disk=%s tracked=%s %s\n' "$DISK_BLOBS" "$TRACKED_BLOBS" \
  "$([ "$DISK_BLOBS" = "$TRACKED_BLOBS" ] && echo '✓' || echo '✗ MISMATCH')"
printf '\n'

printf '9) Test gates\n----------------\n'
pnpm -r run test 2>&1 | grep -E "Tests " | sed 's/^/  /'
printf '\n'

printf '========================================\n'
printf 'AUDIT END\n'
printf '========================================\n'
