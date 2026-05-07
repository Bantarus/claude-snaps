# Workflow W3 — `harness snap` (CLI capture) (5 cases).
#
# Verifies the manual-snapshot path: composition-change creates a new
# snapshot + note attribution; same composition appends a note only;
# empty note is refused; detached HEAD is refused; unicode bytes pass
# through intact.

w3_1_snap_with_change() {
  fixture_baseline_no_apm
  # Mutate composition so the snap creates a new snapshot.
  cat > "$FIXTURE_DIR/.claude/skills/notes/SKILL.md" <<'SKILL'
---
name: notes
description: mutated for w3-1
---
# notes
mutated
SKILL
  local before; before=$(count_snapshot_blobs "$FIXTURE_DIR")
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" snap "added skill" ) 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "snap exits 0"
  assert_contains "$out" "Captured" "snap reports Captured ..."
  local after; after=$(count_snapshot_blobs "$FIXTURE_DIR")
  assert_count "$((before + 1))" "$after" "snapshot count grew by 1"
  # Note attribution attached under sessionId=<manual>
  local sessions; sessions=$( ( cd "$FIXTURE_DIR" && "$HARNESS" sessions ) 2>&1 )
  assert_contains "$sessions" "<manual>" "sessions list includes <manual>"
  local notes
  notes=$( ( cd "$FIXTURE_DIR" && "$HARNESS" notes HEAD ) 2>&1 )
  assert_contains "$notes" "added skill" "note text recorded on the new snapshot"
}
register_case "W3.1 snap on changed composition writes blob + note" w3_1_snap_with_change

w3_2_snap_no_change_appends_note_only() {
  fixture_baseline_no_apm
  # Establish a baseline snapshot with one note.
  ( cd "$FIXTURE_DIR" && "$HARNESS" snap "baseline" >/dev/null )
  local before; before=$(count_snapshot_blobs "$FIXTURE_DIR")
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" snap "no change note" ) 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "snap exits 0 on unchanged composition"
  assert_contains "$out" "No composition change" "snap reports no-change message"
  local after; after=$(count_snapshot_blobs "$FIXTURE_DIR")
  assert_equal "$before" "$after" "snapshot count unchanged"
  local notes
  notes=$( ( cd "$FIXTURE_DIR" && "$HARNESS" notes HEAD ) 2>&1 )
  assert_contains "$notes" "baseline" "first note still present"
  assert_contains "$notes" "no change note" "second note appended to existing snapshot"
}
register_case "W3.2 snap on unchanged composition only appends note" w3_2_snap_no_change_appends_note_only

w3_3_snap_empty_note_refused() {
  fixture_baseline_no_apm
  ( cd "$FIXTURE_DIR" && "$HARNESS" snap "baseline" >/dev/null )
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" snap "" ) 2>&1 )
  local rc=$?
  assert_exit 1 "$rc" "snap with empty note exits 1"
  assert_contains "$out" "note is required" "error message names the missing note"
  # Same outcome with no positional arg at all.
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" snap ) 2>&1 )
  rc=$?
  assert_exit 1 "$rc" "snap with no arg exits 1"
  assert_contains "$out" "note is required" "no-arg error matches empty-note"
}
register_case "W3.3 snap with empty note exits 1 with usage" w3_3_snap_empty_note_refused

w3_4_snap_detached_refused() {
  fixture_baseline_no_apm
  ( cd "$FIXTURE_DIR" && "$HARNESS" snap "baseline" >/dev/null )
  # Detach HEAD by checking out the snapshot id directly.
  local sid; sid=$(read_head_pointer "$FIXTURE_DIR")
  # HEAD currently has "ref: refs/heads/main" — resolve to actual id.
  if [[ "$sid" == ref:* ]]; then
    sid=$(head_snapshot_id "$FIXTURE_DIR")
  fi
  ( cd "$FIXTURE_DIR" && "$HARNESS" checkout "$sid" >/dev/null 2>&1 )
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" snap "x" ) 2>&1 )
  local rc=$?
  assert_exit 1 "$rc" "snap on detached HEAD exits 1"
  assert_contains "$out" "detached HEAD" "error mentions detached HEAD"
}
register_case "W3.4 snap on detached HEAD refused" w3_4_snap_detached_refused

w3_5_snap_unicode_note_intact() {
  fixture_baseline_no_apm
  local note; note='📝 unicode test — αβγ'
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" snap "$note" ) 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "snap with unicode note exits 0"
  local notes
  notes=$( ( cd "$FIXTURE_DIR" && "$HARNESS" notes HEAD ) 2>&1 )
  assert_contains "$notes" "📝" "emoji byte preserved"
  assert_contains "$notes" "αβγ" "Greek bytes preserved"
  assert_contains "$notes" "unicode test" "ASCII portion preserved"
}
register_case "W3.5 snap with unicode note carries bytes intact" w3_5_snap_unicode_note_intact
