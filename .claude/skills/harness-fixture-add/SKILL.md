---
name: harness-fixture-add
description: Add a new example or compat fixture to scripts/build_examples.py without breaking canonical-501 byte-stability or the spec round-trip tests. Use when adding a fixture that exercises a new source.kind, new optional field, new parent-length, or any compat case readers must tolerate.
---

# harness-fixture-add

Walk-through for adding a fixture under `spec/examples/`. Every fixture
is content-addressable and round-tripped against the JSON Schema — the
ids in the fixture's filenames are recomputable from canonical bytes,
so you cannot fudge them.

## When to use

- A spec amendment introduced a new shape (new `source.kind`, new
  optional Snapshot field, new parent-length, new SQL constraint
  edge case) — readers need a fixture to validate against.
- You're seeding a new "compat" case under
  `spec/examples/compat-fixtures/` (the canonical home for
  reader-MUST-tolerate cases) or `spec/examples/compat-<topic>/` for
  larger isolated stories.

For "real" example projects (solo-no-apm, team-shared, …) the bar is
higher — those are pedagogical tours of the format. Compat fixtures
just need to exercise one rule.

## The shape of a fixture

Every example has this layout:

```
spec/examples/<name>/
├── apm.yml              # only if exercising APM
├── apm.lock.yaml        # only if exercising APM
└── .harness/
    ├── HEAD             # text: "ref: refs/heads/<branch>\n"
    ├── config           # TOML, see CONFIG_DEFAULT in build_examples.py
    ├── refs/heads/main  # text: "<id>\n"
    ├── refs/tags/<name> # if exercising tags
    └── snapshots/<aa>/<rest>.json   # 40-hex id split aa+rest
```

You never write blob ids by hand. `write_snapshot()` in
`build_examples.py` derives them from canonical bytes and lays the
files out for you.

## Walk

### 1. Pick where it lives

| Case | Goes under |
|---|---|
| Single-blob compat case (one new source.kind, one weird field) | `spec/examples/compat-fixtures/` (extend the existing builder) |
| Multi-blob compat story (a topic deserving its own README) | `spec/examples/compat-<topic>/` (new builder) |
| Pedagogical example of normal usage | `spec/examples/<scenario>/` (new builder, treat carefully) |

For a new optional field that has a documented "absent" path elsewhere,
the convention is **a sibling compat-<topic>/ directory** — see
`compat-session-ctx/` (the model+permissionMode case) and
`compat-user-scope/` (the user source.kind case) for templates.

### 2. Add the builder

Edit `scripts/build_examples.py`. The pattern is:

```python
def build_compat_<topic>():
    proj = EXAMPLES / "compat-<topic>"
    h = proj / ".harness"
    if h.exists():
        shutil.rmtree(h)              # idempotent regenerate
    (h / "snapshots").mkdir(parents=True)
    (h / "refs" / "heads").mkdir(parents=True)

    modules = [
        m_local("chatmode", "senior-eng", ".claude/agents/senior-eng.md"),
        # ... whatever the case requires
    ]

    s_init = {
        "formatVersion": "0.1",
        "parentIds": [],
        "branch": "main",
        "kind": "init",
        "message": "<topic>: <one-line story>",
        "codePin": None,                      # or a real-looking hex sha
        "createdAt": "2026-04-NNT00:00:00.000Z",   # use a stable date
        "apmLockHash": None,
        "modules": modules,
    }
    id_init = write_snapshot(h, s_init)

    # Add more snapshots if the story needs them, chained by parentIds.

    write_text(h / "HEAD", "ref: refs/heads/main\n")
    write_text(h / "refs" / "heads" / "main", id_init + "\n")
    write_text(h / "config", CONFIG_DEFAULT)   # or CONFIG_USER_SCOPE if scope=user
    write_text(proj / "READER-COMPAT.md", README_TEXT)
```

Then register it in the `if __name__ == "__main__":` block:

```python
build_compat_<topic>()
```

### 3. Use the right module helper

`build_examples.py` exposes:

- `m_local(t, name, path, version=None, enabled=True, config_hash=None)`
- `m_user(t, name, path, …)`        — for `kind: "user"` modules ($HOME-relative path)
- `m_apm(t, name, package, commit, depth=1, version=None, …)`
- `m_builtin(t, name, enabled=True)`

For an `x-` extension or other shape outside these helpers, write the
dict literal directly:

```python
{
    "type": "skill", "name": "private-bundle",
    "enabled": True,
    "source": { "kind": "x-experimental-bundle", "bundleId": "...", "ref": "..." },
}
```

### 4. Run + verify byte-stability

```bash
BEFORE=$(sha256sum spec/test-vectors/canonical-501.bin | awk '{print $1}')
python3 scripts/build_examples.py
AFTER=$(sha256sum spec/test-vectors/canonical-501.bin | awk '{print $1}')
[ "$BEFORE" = "$AFTER" ] && echo "✓ byte-identical" || echo "⚠ canonical-501 moved"
```

A new fixture should NOT move canonical-501 (the test vector is its
own snapshot, not affected by sibling fixtures). If you see drift,
you've accidentally changed a Module helper or CONFIG_DEFAULT in a
way that affected the test vector — back out, look more carefully.

### 5. Validate the new blobs

```bash
python3 -c "
import json, hashlib, os
from jsonschema import Draft202012Validator
schema = json.load(open('spec/schema/snapshot.schema.json'))
v = Draft202012Validator(schema)
def canon(o): return json.dumps(o, sort_keys=True, separators=(',',':'), ensure_ascii=False).encode('utf-8')
count, errs, mismatches = 0, 0, 0
for root, _, files in os.walk('spec/examples'):
  for f in files:
    if not f.endswith('.json'): continue
    p = os.path.join(root, f)
    blob = json.load(open(p))
    for e in v.iter_errors(blob): errs += 1; print(f'✗ schema {p}: {e.message[:80]}')
    bid = blob.pop('id')
    if hashlib.sha256(canon(blob)).hexdigest()[:40] != bid: mismatches += 1
    count += 1
print(f'{count} blobs validated; {errs} schema errors; {mismatches} id mismatches')
"
```

Both errs and mismatches MUST be 0. The count goes up by exactly the
number of snapshots in your new fixture.

### 6. Update reference tests if needed

Two test files reference fixture state directly:

- `packages/core/test/canonical.test.ts` — has `expect(count).toBeGreaterThanOrEqual(13)`. Adding fixtures only nudges this up, no edit needed.
- `packages/core/test/dag.test.ts` — has hardcoded fixture ids for the diamond DAG. **Don't extend `compat-fixtures/` itself if your fixture would add descendants of XEXT** — it'd break `descendantsOf XEXT returns empty`. Use a sibling `compat-<topic>/` directory instead.
- `packages/core/test/index_db.test.ts` — has `count of x-* === 1` for compat-fixtures. Same rule: don't extend compat-fixtures, use a sibling.

If you do need to amend hardcoded ids in tests (because you're
extending an existing fixture in a way that changes ids), regenerate
first, then `find spec/examples/<name>/.harness/snapshots -name '*.json'`
to see the new id list.

### 7. Write the READER-COMPAT.md

Every compat fixture needs a one-screen README explaining:

- What rule the fixture exercises (link to spec section)
- A table of "what's in this fixture and which line of the rule it tests"
- The conformance assertion: "a v0.1 reader MUST <do X> when loading this"

See `spec/examples/compat-session-ctx/READER-COMPAT.md` and
`spec/examples/compat-user-scope/READER-COMPAT.md` for the template.

### 8. Commit

```
chore(spec): add compat fixture <topic>

Exercises <rule> per spec/format.md §<n>. <count> snapshot(s) under
spec/examples/compat-<topic>/. canonical-501.bin byte-identical.
```

Keep the commit small — fixtures alone, no spec / core / test logic
in the same commit unless they're tightly coupled to the same change.

## What NOT to do

- **Never** hand-write a snapshot id. They're derived. If the on-disk
  filename doesn't match `blob.id`, the round-trip test fails.
- **Never** edit a fixture file directly. Always change `build_examples.py`
  and regenerate. The test vector + matrix tests assume the script is
  the source of truth.
- **Never** add a fixture for a shape the spec doesn't allow. If your
  case isn't valid under the current schema, the schema needs amending
  first — see `harness-spec-amend`.
- **Never** put a compat fixture's snapshots into `compat-fixtures/`
  if it would change the diamond DAG's descendant set. The dag.test.ts
  assertions are pinned to the existing 5-blob shape.
