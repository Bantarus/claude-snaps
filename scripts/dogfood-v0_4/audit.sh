#!/usr/bin/env bash
# End-of-playbook audit for the v0.4 observation pass. Prints a
# multi-section report to stdout. Designed to be redirected to a file:
#   bash scripts/dogfood-v0_4/audit.sh > /tmp/v0_4-observe-report.txt 2>&1

source "$(dirname "$0")/lib.sh"
require_v04_dir
cd "$V04_DIR"

printf 'v0.4 observation audit — %s\n' "$(date -u +%FT%TZ)"
printf 'project: %s\n' "$V04_DIR"
printf '\n'

printf '1) harness log (every snapshot)\n----------------\n'
"$HARNESS" log --limit 99 2>&1 | sed 's/^/  /'
printf '\n'

printf '2) harness sessions (attribution per session)\n----------------\n'
"$HARNESS" sessions 2>&1 | sed 's/^/  /'
printf '\n'

printf '3) Module classification — apm vs local vs builtin\n----------------\n'
# Walk every snapshot blob; tally module source kinds. The v0.4.1
# enrichment fix shows up as a non-zero apm count for snapshots
# captured AFTER apm.lock.yaml was added in Phase B.
python3 - <<'PY'
import json, os
counts_per_blob = []
for root, _, files in os.walk('.harness/snapshots'):
    for f in files:
        if not f.endswith('.json'): continue
        with open(os.path.join(root, f)) as fh:
            b = json.load(fh)
        kinds = {'apm': 0, 'local': 0, 'builtin': 0, 'other': 0}
        for m in b.get('modules', []):
            k = m.get('source', {}).get('kind', 'other')
            if k in kinds: kinds[k] += 1
            else: kinds['other'] += 1
        counts_per_blob.append((b['id'][:8], b.get('kind'), kinds, bool(b.get('apmLockfile'))))
counts_per_blob.sort(key=lambda x: x[0])
for short, kind, kinds, has_lockfile in counts_per_blob:
    flag = "lockfile" if has_lockfile else "no-lockfile"
    print(f"  {short}  kind={kind}  apm={kinds['apm']:2d}  local={kinds['local']:2d}  builtin={kinds['builtin']:2d}  {flag}")
agg_apm = sum(c[2]['apm'] for c in counts_per_blob)
agg_local = sum(c[2]['local'] for c in counts_per_blob)
agg_builtin = sum(c[2]['builtin'] for c in counts_per_blob)
print(f"\n  TOTAL  apm={agg_apm}  local={agg_local}  builtin={agg_builtin}")
print(f"  v0.4.1 check: apm > 0 means enrichment held (post Phase B).")
PY
printf '\n'

printf '4) apmLockfile presence + apmLockHash invariant\n----------------\n'
# The invariant: when apmLockfile is non-null, sha256(apmLockfile) ==
# apmLockHash (modulo "sha256:" prefix). Spot-check it.
python3 - <<'PY'
import json, os, hashlib
checked = 0
mismatches = []
for root, _, files in os.walk('.harness/snapshots'):
    for f in files:
        if not f.endswith('.json'): continue
        with open(os.path.join(root, f)) as fh:
            b = json.load(fh)
        lf = b.get('apmLockfile')
        lh = b.get('apmLockHash')
        if lf is None: continue
        actual = 'sha256:' + hashlib.sha256(lf.encode('utf-8')).hexdigest()
        checked += 1
        if actual != lh:
            mismatches.append((b['id'][:8], lh, actual))
print(f"  snapshots with apmLockfile: {checked}")
if mismatches:
    print(f"  ✗ {len(mismatches)} hash mismatches:")
    for m in mismatches: print(f"    {m[0]}  recorded={m[1]}  recomputed={m[2]}")
else:
    print(f"  ✓ all {checked} hashes match the recorded apmLockHash")
PY
printf '\n'

printf '5) Refs (branches + tags)\n----------------\n'
printf '  branches:\n'
ls .harness/refs/heads 2>/dev/null | sed 's/^/    /' || true
printf '  tags:\n'
ls .harness/refs/tags 2>/dev/null | sed 's/^/    /' || true
printf '\n'

printf '6) Backup directory inventory\n----------------\n'
ls -d .claude.harness-backup-* 2>/dev/null | sed 's/^/  /' || printf '  (no backups — has Phase B/C been run?)\n'
printf '  count: %s\n' "$(ls -d .claude.harness-backup-* 2>/dev/null | wc -l)"
printf '\n'

printf '7) Working tree vs HEAD divergence (D1/D2 cross-check)\n----------------\n'
"$HARNESS" checkout "$(cat .harness/HEAD | sed 's/ref: refs\/heads\///')" 2>&1 | sed 's/^/  /' || true
printf '\n'

printf '8) Spec gates (run from monorepo)\n----------------\n'
cd "$MONOREPO_ROOT"
printf '  schema agreement:\n'
python3 scripts/check_schema_agreement.py 2>&1 | tail -2 | sed 's/^/    /'
printf '\n  format-version-bump (vs HEAD):\n'
python3 scripts/check_format_version_bump.py 2>&1 | sed 's/^/    /'
printf '\n'

printf '9) Test gates (full suite — fast)\n----------------\n'
pnpm -r test 2>&1 | grep -E "Test Files|Tests" | sed 's/^/  /'
printf '\n'

printf 'audit complete\n'
