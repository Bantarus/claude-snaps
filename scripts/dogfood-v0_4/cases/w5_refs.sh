# Workflow W5 — refs (tag / branch / checkout) (10 cases).
#
# Verifies named refs (tags + branches), symbolic vs detached HEAD,
# prefix resolution, unknown-ref errors, and the v0.4.1 divergence
# warning on checkout.

# Helper: build a baseline + 1 snap project. Sets FIXTURE_DIR in
# the caller's scope (do NOT wrap in command substitution).
_w5_baseline_with_snap() {
  fixture_baseline_no_apm
  ( cd "$FIXTURE_DIR" && "$HARNESS" snap "first" >/dev/null )
}

w5_1_tag_creates_ref() {
  _w5_baseline_with_snap
  local sid; sid=$(head_snapshot_id "$FIXTURE_DIR")
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" tag v0.1 ) 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "tag exits 0"
  assert_contains "$out" "Tagged" "tag output reports Tagged ..."
  assert_file_exists "$FIXTURE_DIR/.harness/refs/tags/v0.1" "tag ref file written"
  local resolved; resolved=$(cat "$FIXTURE_DIR/.harness/refs/tags/v0.1")
  assert_equal "$sid" "$resolved" "tag ref resolves to HEAD's snapshot id"
}
register_case "W5.1 tag writes refs/tags/v0.1 pointing at HEAD" w5_1_tag_creates_ref

w5_2_tag_already_exists_refused() {
  fixture_tagged   # has v0.1 at the only snapshot
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" tag v0.1 ) 2>&1 )
  local rc=$?
  assert_exit 1 "$rc" "tag of existing tag exits 1"
  assert_contains "$out" "already exists" "error names the conflict"
  assert_contains "$out" "--force" "error suggests --force"
}
register_case "W5.2 tag <existing> exits 1 without --force" w5_2_tag_already_exists_refused

w5_3_tag_force_overwrites() {
  fixture_tagged
  local before; before=$(cat "$FIXTURE_DIR/.harness/refs/tags/v0.1")
  # Add a new snap so HEAD moves.
  mkdir -p "$FIXTURE_DIR/.claude/skills/extra"
  cat > "$FIXTURE_DIR/.claude/skills/extra/SKILL.md" <<'SKILL'
---
name: extra
description: e
---
# e
SKILL
  ( cd "$FIXTURE_DIR" && "$HARNESS" snap "moved HEAD" >/dev/null )
  local after_head; after_head=$(head_snapshot_id "$FIXTURE_DIR")
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" tag v0.1 --force ) 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "tag --force exits 0"
  local after_tag; after_tag=$(cat "$FIXTURE_DIR/.harness/refs/tags/v0.1")
  assert_equal "$after_head" "$after_tag" "tag now points at new HEAD"
  assert_not_equal "$before" "$after_tag" "tag was overwritten"
}
register_case "W5.3 tag --force overwrites existing tag" w5_3_tag_force_overwrites

w5_4_branch_creates_ref() {
  _w5_baseline_with_snap
  local sid; sid=$(head_snapshot_id "$FIXTURE_DIR")
  local head_before; head_before=$(read_head_pointer "$FIXTURE_DIR")
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" branch experimental ) 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "branch exits 0"
  assert_file_exists "$FIXTURE_DIR/.harness/refs/heads/experimental" "branch ref file written"
  local resolved; resolved=$(cat "$FIXTURE_DIR/.harness/refs/heads/experimental")
  assert_equal "$sid" "$resolved" "branch ref points at HEAD's id"
  local head_after; head_after=$(read_head_pointer "$FIXTURE_DIR")
  assert_equal "$head_before" "$head_after" "HEAD not advanced by branch"
}
register_case "W5.4 branch writes refs/heads/experimental; HEAD unchanged" w5_4_branch_creates_ref

w5_5_branch_already_exists_refused() {
  fixture_branched
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" branch experimental ) 2>&1 )
  local rc=$?
  assert_exit 1 "$rc" "branch on existing name exits 1"
  assert_contains "$out" "already exists" "error names the conflict"
}
register_case "W5.5 branch <existing> exits 1 without --force" w5_5_branch_already_exists_refused

w5_6_checkout_branch_symbolic() {
  fixture_branched
  ( cd "$FIXTURE_DIR" && "$HARNESS" checkout experimental >/dev/null )
  local head; head=$(read_head_pointer "$FIXTURE_DIR")
  assert_equal "ref: refs/heads/experimental" "$head" "HEAD is symbolic at refs/heads/experimental"
}
register_case "W5.6 checkout <branch> sets symbolic HEAD" w5_6_checkout_branch_symbolic

w5_7_checkout_full_id_detaches() {
  fixture_branched
  local sid; sid=$(head_snapshot_id "$FIXTURE_DIR")
  ( cd "$FIXTURE_DIR" && "$HARNESS" checkout "$sid" >/dev/null )
  local head; head=$(read_head_pointer "$FIXTURE_DIR")
  assert_equal "$sid" "$head" "HEAD holds full 40-hex id (detached)"
  assert_matches "$head" '^[0-9a-f]{40}$' "HEAD pointer is 40-hex"
}
register_case "W5.7 checkout <full-id> detaches HEAD" w5_7_checkout_full_id_detaches

w5_8_checkout_prefix_resolves() {
  fixture_branched
  local sid; sid=$(head_snapshot_id "$FIXTURE_DIR")
  local prefix=${sid:0:6}
  ( cd "$FIXTURE_DIR" && "$HARNESS" checkout "$prefix" >/dev/null )
  local head; head=$(read_head_pointer "$FIXTURE_DIR")
  assert_equal "$sid" "$head" "6-char prefix resolves to full 40-hex id"
}
register_case "W5.8 checkout <6-char-prefix> resolves to full id" w5_8_checkout_prefix_resolves

w5_9_checkout_unknown_ref() {
  fixture_tagged
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" checkout nonexistent ) 2>&1 )
  local rc=$?
  assert_exit 1 "$rc" "checkout <unknown> exits 1"
  assert_contains "$out" "unknown ref" "error names the unknown ref"
}
register_case "W5.9 checkout <unknown> exits 1 with 'unknown ref'" w5_9_checkout_unknown_ref

w5_10_checkout_divergence_warning() {
  fixture_branched
  # Switch to experimental, mutate composition + snap so the snapshot
  # records the mutated state, then return to main. Now main's head
  # snapshot's composition differs from .claude/'s actual contents,
  # which is what triggers the v0.4.1 divergence warning.
  ( cd "$FIXTURE_DIR" && "$HARNESS" checkout experimental >/dev/null )
  mkdir -p "$FIXTURE_DIR/.claude/skills/exp"
  cat > "$FIXTURE_DIR/.claude/skills/exp/SKILL.md" <<'SKILL'
---
name: exp
description: e
---
# e
SKILL
  ( cd "$FIXTURE_DIR" && "$HARNESS" snap "exp-only" >/dev/null )
  local out
  out=$( ( cd "$FIXTURE_DIR" && "$HARNESS" checkout main ) 2>&1 )
  local rc=$?
  assert_exit 0 "$rc" "checkout main exits 0 even when diverged"
  assert_contains "$out" "DIVERGED" "divergence warning fires (v0.4.1 cosmetic)"
  assert_contains "$out" "harness reproduce" "warning suggests reproduce"
}
register_case "W5.10 checkout to ref with divergent .claude/ warns" w5_10_checkout_divergence_warning
