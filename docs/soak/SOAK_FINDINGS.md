# Dogfood Soak Findings (Prompt D)

**Date:** 2026-05-02  
**Soak Directory:** `~/harness-dogfood-soak`  
**Duration:** ~1 hour (compressed from 10-day scenario)  
**Sessions:** 15 snapshots (14 auto + 1 init), 2 branches, 2 tags

---

## Summary

The soak successfully exercised all major harness paths: skill addition/modification/removal, branching, forking, tagging, /clear behavior, and resume workflows. **All spec gates passed** (schema agreement, canonical-501 byte-stability, 187 tests green). The diff renderer proved legible across multi-module changes.

**One critical behavioral gap discovered** that should block v0.2 work.

---

## Findings

### ✓ Working Well

**1. Branching and divergence (day 06)**
- Fork point correctly detected from v0.1 tag
- Experimental branch created and diverged
- DAG shows two independent lineages, both captured correctly

**2. Diff legibility (days 05, 09–10)**
- v0.1 → v0.2: +4 skills, −1 removed, +1 slash command → clean output
- Multi-module additions (day 09 bulk-add) stayed readable
- Noise floor acceptable (empty diffs on repeated sessions showed no spurious changes)

**3. /clear behavior (day 07)**
- `/clear` within a session produced a new session ID
- Each trigger fired the hook independently
- Two session IDs in the final lineage as expected

**4. Tag detection**
- v0.1 and v0.2 tags correctly stored and retrievable
- **But**: `harness log` doesn't display tag annotations (limitation)

---

### ✗ Critical Gap: Resume/Continue Doesn't Fire Hook

**Behavior observed:**

When using `claude --continue` or `claude --resume` to resume a previous session:
- Hook **does not fire** (no SessionStart:startup attachment)
- No new snapshot created, even if `.harness/` has changed since the original session
- Example: Day 08 skill removal followed by `claude --continue` → snapshot was never captured for the deletion

**In soak data** (section 6 of soak-report.txt):
- Sessions `6257c408` and `7769e7d5` show **0 hook firings** — these were resumed sessions
- All fresh sessions show exactly 1 hook firing

**Impact:**
- Snapshots and actual `.harness/` state can drift when sessions are resumed
- Architect cannot trust that a snapshot reflects the state *at* that session's start time if the previous session was a resume
- Creates ambiguity: "Did .harness/ change before or during this session?"

**Questions for v0.2 design:**
1. Should `claude --continue` / `claude --resume` fire the hook (capture the delta)?
2. Should the hook detect stale state and warn?
3. Or is this acceptable as "snapshots capture new sessions only"?

---

## Recommendations

### For Prompt D (this phase)

**Surface the resume gap to the architect.** The soak provided empirical evidence that both `claude --continue` and `claude --resume` skip hook firing. This should either:
- Be documented as expected behavior ("snapshots are SessionStart events only")
- Or be fixed (hook fires on resume if state changed)

### For v0.2+ (future)

**Add tag annotations to `harness log` output:**

Currently:
```
af1a57d6 ▶ auto · session 3b29a10d  (main) code:8c42aa9
```

Should be:
```
af1a57d6 ▶ auto · session 3b29a10d  (main) code:8c42aa9  [v0.1]
```

This makes it obvious which snapshots are tagged without requiring file-system reads.

---

## Audit Summary

| Metric | Result |
|--------|--------|
| Snapshots captured | 15 (1 init + 14 auto) ✓ |
| Branches | 2 (main + experimental) ✓ |
| Tags | 2 (v0.1, v0.2) ✓ |
| DAG integrity | Clean ✓ |
| Diffs legible | Yes ✓ |
| Schema agreement | 17/17 cases ✓ |
| canonical-501 byte-stability | Byte-identical ✓ |
| Test gates | 187/187 passing ✓ |
| Resume hook firing | 0 (gap) ✗ |

---

## Soak Transcript

Full audit output: [soak-report.txt](soak-report.txt)
