---
name: harness-spec-amend
description: Amend the .harness/ format spec without breaking byte-stability or cross-impl drift. Use when adding or changing a top-level Snapshot field, a Module field, an enum value, a SQL column, or any normative MUST/SHOULD in spec/format.md or spec/hooks.md.
---

# harness-spec-amend

Codified workflow for amending `spec/`. Every amendment must keep the
canonical-501 test vector byte-identical (or rewrite it deliberately
and acknowledge the break) and keep the SQL CHECK ↔ JSON Schema
agreement exact.

## When to use

- Adding a new top-level field to `Snapshot` (e.g. `model`, `permissionMode`)
- Adding a `source.kind` variant
- Adding a SQL column or extending a CHECK constraint
- Changing any normative MUST / SHOULD wording in `format.md` or `hooks.md`
- Adding a new `Module` aspect (configHash semantics, ordering rules, …)

For implementation-only changes (refactors of `packages/core/src/*` that
don't change observable shape) **do not** use this skill — go straight
to the code.

## The §9.3 scope check (run BEFORE matrix coverage)

`spec/format.md §9.3` defines what counts as a minor bump within the
v0.1.x family. Before any other work, classify the proposed change:

| Change shape | Is it a minor bump? | Action |
|---|---|---|
| New OPTIONAL top-level field on `Snapshot` | ✅ yes | proceed |
| New OPTIONAL field on `Module` | ✅ yes | proceed |
| Tightening a previously-permissive pattern or CHECK | ✅ yes | proceed |
| New value added to an existing enum (`kind`, `source.kind`) | ❌ NO | **STOP** — major bump or `x-` prefix experiment |
| New REQUIRED field anywhere | ❌ NO | **STOP** — major bump |
| Removing or renaming a field | ❌ NO | **STOP** — major bump |
| Changing a field's type | ❌ NO | **STOP** — major bump |
| Changing canonical-bytes derivation rule (§3.1) | ❌ NO | **STOP** — major bump |
| Changing module ordering rule (§2.5/hooks.md §2.2) | ❌ NO | **STOP** — major bump |

If the change is **not** a minor bump, do not proceed silently — surface
the question in the conversation, decide explicitly whether to:

1. Use an `x-` extension prefix (no spec change required)
2. Defer to a major bump (v0.2.x)
3. Land the major bump deliberately, with the foundation conversation
   the architect would expect: who consumes this, what does v0.1
   reader compatibility mean, what other strict MUST NOTs in the
   spec should be re-examined now that this one is changing?

The 2026-05-01 capture-scope incident is the canonical case of a major
bump masquerading as minor — `kind: "user"` was a normative addition to
an existing enum, not an additive optional field. The reverted commit
`674b05f` is in git history as the worked example. Do not repeat.

Run `python3 scripts/check_format_version_bump.py` before continuing —
mechanical detection of the enum-addition / required-field-addition
patterns above. Exits non-zero with an explanation if the staged diff
suggests a major-bump shape.

## The matrix-coverage rule

Once §9.3 clears the change as a minor bump, run the matrix check:
**every enum value, every variant, every notable parent-length, every
null/set nullable**. The canonical example is the 2026-04-30 audit that
caught `parents=2` (merge) and `x-*` (extension) gaps. The cost of
missing one is hours of cleanup later vs. minutes of grep now. See
`memory/feedback_matrix_check.md` for the original incident.

## Walk

### 1. Decide the change is normative

- If it changes Snapshot bytes for any existing fixture → it's a
  breaking change; canonical-501 will move; you owe a migration note.
- If it adds an OPTIONAL field absent from existing fixtures →
  canonical-501 stays byte-identical (this is the cheap path).
- If it adds an OPTIONAL field that the build_examples.py test vector
  populates → canonical-501 moves; that's a deliberate v0.1.x bump.

### 2. Edit the spec text

Touch all that apply:

- `spec/format.md` — main spec doc. Section the change belongs in:
  - §1.x for filesystem-layout / capture-scope rules
  - §2.x for Snapshot / Module / source field shapes
  - §4.x for DAG / refs / HEAD semantics
  - §7 for config keys
  - §9 for forward-compat rules
- `spec/hooks.md` — only if the change affects what the SessionStart
  hook MUST emit or read. Keep §1.1 (stdin payload) in lockstep with
  any new top-level field.
- `spec/apm-integration.md` — only if APM resolution semantics change.

Keep RFC 2119 wording disciplined: MUST for normative requirements,
SHOULD for strong recommendation, MAY for permission. Don't downgrade
without thinking; don't upgrade without justification.

### 3. Update the schemas

Pick the ones the change touches:

- `spec/schema/snapshot.schema.json` — JSON Schema for snapshot blobs.
- `spec/schema/config.schema.json` — JSON Schema for `.harness/config`.
- `spec/schema/001_init.sql` — SQL DDL. **CHECK constraints MUST mirror
  enum / pattern rules in the JSON Schema verbatim.**

### 4. Run the agreement check

```bash
python3 scripts/check_schema_agreement.py
```

This regression test enumerates ~17 cases across SQL CHECK and JSON
Schema for `source_kind`. Adding a new kind requires extending the
test cases too. **Failure here is a divergence; fix one or the other
before proceeding.**

### 5. Regenerate examples

```bash
BEFORE=$(sha256sum spec/test-vectors/canonical-501.bin | awk '{print $1}')
python3 scripts/build_examples.py
AFTER=$(sha256sum spec/test-vectors/canonical-501.bin | awk '{print $1}')
[ "$BEFORE" = "$AFTER" ] && echo "✓ byte-identical" || echo "⚠ canonical-501 moved"
```

For an additive optional field, `BEFORE === AFTER` is the green light.
If they differ, you've changed a field the test vector populates — that's
a v0.1.x bump and must be called out in the commit message.

If your change adds a new `source.kind`, a new top-level field, or a new
parent-length case, **add a compat fixture under `spec/examples/`** that
exercises the new shape. See `harness-fixture-add` skill for how.

### 6. Validate every blob

```bash
python3 -c "
import json, hashlib, os
from jsonschema import Draft202012Validator
schema = json.load(open('spec/schema/snapshot.schema.json'))
v = Draft202012Validator(schema)
def canon(o): return json.dumps(o, sort_keys=True, separators=(',',':'), ensure_ascii=False).encode('utf-8')
errs, mismatches = 0, 0
for root, _, files in os.walk('spec/examples'):
  for f in files:
    if not f.endswith('.json'): continue
    p = os.path.join(root, f)
    blob = json.load(open(p))
    for e in v.iter_errors(blob): errs += 1; print(f'✗ schema {p}: {e.message[:80]}')
    bid = blob.pop('id')
    if hashlib.sha256(canon(blob)).hexdigest()[:40] != bid: mismatches += 1
print(f'{errs} schema errors; {mismatches} id mismatches')
"
```

Both numbers MUST be 0.

### 7. Run the four core gates

```bash
pnpm --filter @harness/core test           # gate 4: 100+ tests
pnpm --filter @harness/cli  test           # gate 5
pnpm --filter @harness/hook test           # gate 6
pnpm --filter @harness/cli exec vitest run test/e2e.test.ts   # gate 7
# gate 8/9 (TUI tests) removed — TUI was dropped from scope; CLI is the only consumer.
```

### 8. Update memory if the rule is load-bearing

Memory pins the *reasoning* behind a normative choice so a future
amendment doesn't unwittingly reverse it. The canonical examples:

- `memory/feedback_capture_scope.md` — why scope is config-driven, not
  hard-coded.
- `memory/spec_load_bearing.md` — why scripts/build_examples.py is the
  cross-impl drift detector.

If your amendment introduces a new "we tried X, found Y, settled on Z"
choice, add it as a feedback memory.

### 9. Commit message form

```
feat(spec): <one-line change summary>

<why the change exists — link to the dogfood / incident / decision>

Schema:
- <which schema files moved, in one line each>

Core:
- <which packages/core files moved, in one line each>

Examples:
- <new fixtures, byte-stability statement for canonical-501>

Tests: +N. Total <total> tests; <count> across all packages green.
```

The byte-stability statement is non-optional. Either:
- "canonical-501.bin: byte-identical (TV_INPUT carries no <field>)"
- "canonical-501.bin: moved to <new-hex>; v0.1.x format bump"

## What NOT to do

- **Never** edit `spec/test-vectors/canonical-501.bin` by hand. It's
  generated by `scripts/build_examples.py` and any drift means your
  generator is wrong, not the fixture.
- **Never** introduce a new `source.kind` (or any other enum value)
  without going through the §9.3 scope check first. Normative additions
  to an existing enum are a major bump — see the 2026-05-01 capture-scope
  incident, reverted by deliberate decision (`memory/feedback_capture_scope.md`).
- **Never** soften a strict MUST / MUST NOT into a configurable knob
  mid-flight. The change might be correct on the merits, but it inverts
  the project's discipline (justify-adding-knob → justify-not-adding-knob)
  and needs a paired conversation about implications for v0.2 contracts
  and other strict MUST NOTs in the spec. Surface the question first.
- **Never** skip `check_schema_agreement.py`. SQL/JSON divergence is
  invisible until a real database rejects an otherwise-valid blob.
- **Never** skip `check_format_version_bump.py` either. It catches the
  enum-addition class of major-bump-masquerading-as-minor before it
  lands.
