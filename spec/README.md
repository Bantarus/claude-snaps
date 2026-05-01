# `.harness/` specification

`.harness/` is an on-disk format that records **agent harness snapshots and
session lineage** alongside any coding project. It does for agent
configuration what `.git/` does for source code: a content-addressable,
DAG-shaped record you can rewind, branch, fork, diff, tag, and reproduce —
decoupled from but cross-referenced to the project's git history. When
[Microsoft APM](https://microsoft.github.io/apm/) is in use, the format
records APM's resolved commits per primitive so that reproducing an old
session reaches for `apm install --frozen` against exactly the right tree.

This directory is the **specification**: markdown, SQL, JSON Schema, and
example directories. It is not an implementation. A conforming reader or
writer can be built against this spec without ever reading another
codebase.

## Spec status

| | |
|---|---|
| Version | **0.1** Working Draft |
| Stability | **Unstable.** May change without notice until v1.0. |
| License | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| Conformance | [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) MUST / SHOULD / MAY |
| What's locked | Filesystem layout (§1), required snapshot fields (§2.1), id derivation (§3), DAG/refs/HEAD semantics (§4), SQL schema v1, type vocabulary aliases. |
| What may still move | Float canonicalization tightening, the `_meta` table fields, masked-path glob semantics, `kind: "tag"` annotations. |
| Out of scope for v0.1 | Local-source content storage, multi-machine sync semantics, annotated tags, reflog, merge-kind snapshots (parent length 2 is reserved but not produced). |

## Reading order

For someone implementing a reader from scratch, ~30 minutes end-to-end:

1. **[format.md](format.md)** — the main spec. Filesystem layout, snapshot
   blob format, id derivation (with test vector), DAG semantics, SQLite
   index contract, config TOML, versioning rules.
2. **[apm-integration.md](apm-integration.md)** — how APM's `apm.lock.yaml`
   enriches snapshots, the `apmLockHash` field, the reproduction contract.
3. **[hooks.md](hooks.md)** — the SessionStart hook's CLI interface, what
   it captures, the atomic write protocol, concurrency rules.
4. **[schema/001_init.sql](schema/001_init.sql)** — the canonical SQLite
   schema. Read top-to-bottom; comments explain the design.
5. **[schema/snapshot.schema.json](schema/snapshot.schema.json)** — JSON
   Schema for snapshot blobs. The
   [examples](examples/) validate against it.
6. **[schema/config.schema.json](schema/config.schema.json)** — JSON
   Schema describing the parsed structure of `.harness/config`.

## Examples

Four worked examples sit under [examples/](examples/). Every snapshot
blob is real, content-addressable, and validates against
[schema/snapshot.schema.json](schema/snapshot.schema.json).

| Example | Snapshots | Branches | Tags | APM? | Demonstrates |
|---|---|---|---|---|---|
| [empty/](examples/empty/) | 0 | 0 | 0 | n/a | A freshly-initialized `.harness/` (just `HEAD` + `config`). Pinned semantics in [format.md §4.4](format.md#44-the-empty-repository). |
| [solo-no-apm/](examples/solo-no-apm/) | 5 | 1 (main) | 1 (v0.2) | no | Single-developer flow, all `local` / `builtin` modules, `apmLockHash: null` throughout. |
| [solo-with-apm/](examples/solo-with-apm/) | 3 | 1 (main) | 1 (v0.1) | yes | All primitives sourced from APM, `apmLockHash` set, demonstrates the `apm` source variant. |
| [team-shared/](examples/team-shared/) | 5 | 2 (main, experimental) | 1 (v0.4) | yes | Mix of APM (depths 1 and 2), local, and builtin modules. Includes a `fork` snapshot creating the experimental branch. |
| [compat-fixtures/](examples/compat-fixtures/) | 5 | 1 (main) | 0 | n/a | **Reader-compat fixture.** Synthetic blobs v0.1 writers do not produce: a merge node (`parentIds.length === 2`), and a module with an unknown `x-experimental-bundle` source kind. Used to verify a reader implements the forward-compat rules in [format.md §4.1](format.md#41-parents) and [§9.2](format.md#92-forward-compat-unknown-fields-and-variants). |

`lineage.sqlite` is **omitted** from every example: it is a derivable index
(see [format.md §5](format.md#5-the-sqlite-index-lineagesqlite)). Run
`harness reindex` (once a CLI exists) — or, today, run the reference Python
generator at [scripts/build_examples.py](../scripts/build_examples.py) to
rebuild the JSON blobs and refs from the source-of-truth definitions.

## Test vectors

### Canonical-id test vector

The single normative test vector for snapshot id derivation is in
[format.md §3.2](format.md#32-test-vector), with the byte-exact
canonical bytes also stored as a fixture file:
[test-vectors/canonical-501.bin](test-vectors/canonical-501.bin)
(501 bytes UTF-8). An implementation that reproduces those bytes from
the input shown in §3.2 — and computes digest
`977d89c4deef44ae18ab764350d01a54357b84ec` from the fixture — is
conforming for §3. See
[test-vectors/README.md](test-vectors/README.md) for the recommended
cross-language test pattern.

### Validating examples

Validate the example snapshot blobs against the JSON Schema with any
JSON Schema 2020-12-capable validator. Two convenient choices:

```bash
# Node.js (ajv-cli):
npx -y ajv-cli@5 validate \
  -s spec/schema/snapshot.schema.json \
  -d "spec/examples/**/*.json" \
  --spec=draft2020 --strict=false

# Python (jsonschema CLI from the `check-jsonschema` package):
pipx run check-jsonschema --schemafile spec/schema/snapshot.schema.json \
  spec/examples/**/.harness/snapshots/*/*.json
```

The spec does not mandate either tool — any conforming validator works.

### SQL CHECK ↔ JSON Schema agreement

The SQL CHECK constraint on `snapshot_modules.source_kind` and the
JSON Schema pattern on `source.kind` describe the same rule from two
angles. They MUST agree on every input. A regression test pins this:

```bash
python3 scripts/check_schema_agreement.py
```

The script tries 17 representative cases (canonical kinds, well-formed
`x-*` extensions, malformed extensions including bare `x-`, invalid
characters, and non-extension prefixes) against both schemas and exits
non-zero on any disagreement. Run it whenever either schema file
changes.

### Verifying the SQL schema

```bash
sqlite3 :memory: < spec/schema/001_init.sql
# or, without the sqlite3 CLI:
python3 -c "import sqlite3; \
  conn=sqlite3.connect(':memory:'); \
  conn.executescript(open('spec/schema/001_init.sql').read()); \
  print('ok, schema version:', conn.execute('SELECT version FROM _schema').fetchone()[0])"
```

### Round-tripping the example ids

```bash
python3 scripts/build_examples.py
```

The generator computes ids from the same Python dicts used to write the
example blobs. A run that produces no `git diff` against the existing
[examples/](examples/) tree confirms id stability of the canonical-bytes
implementation.

## The script ↔ spec mutual-consistency property

[scripts/build_examples.py](../scripts/build_examples.py) is **load-bearing**
for this specification. The script produces every snapshot blob under
[examples/](examples/) and emits the canonical-id test vector that
[format.md §3.2](format.md#32-test-vector) quotes byte-for-byte. The spec
text and the script enforce each other:

- If someone changes the canonicalization rules in [format.md §3.1](format.md#31-canonical-json)
  without updating the script, the regenerated examples diverge from the
  committed ones — the round-trip test in
  [§Round-tripping the example ids](#round-tripping-the-example-ids)
  fails immediately.
- If someone changes the script (e.g. "tidies up" the canonicalization
  step) without updating the spec, the same test fails for the same
  reason.
- If someone changes a JSON Schema in [schema/](schema/) without
  updating either the script or the prose, the example-validation test
  in [§Validating examples](#validating-examples) fails.

This is a deliberate circular dependency, not an accident. **Do not
"clean up" the script in a way that decouples it from the spec text.**
The byte-exact reproducibility of the examples is the only mechanism
ensuring two independent implementations of `.harness/` produce the
same ids — and the script is the reference implementation of that
reproducibility.

A future TS/Rust/Go implementation SHOULD load the canonical bytes from
[format.md §3.2](format.md#32-test-vector) (or an extracted fixture
file) and assert byte-exact equality with the canonicalizer's output.
That single assertion catches every drift the spec is designed to
prevent.

## What this spec is NOT

- It is not an implementation, library, CLI, or TUI. Those consume the
  format.
- It does not specify multi-machine sync or team merge semantics beyond
  the `[gitignore].policy` knob in `config`. Those are v0.2.
- It does not require a specific JCS library. The canonical-bytes rule is
  a strict subset of [RFC 8785](https://datatracker.ietf.org/doc/html/rfc8785)
  sufficient for the snapshot domain — implementable in any language that
  can sort keys and write UTF-8 JSON. See
  [format.md §3.1](format.md#31-canonical-json).
- It does not define a build, lint, or doc-site toolchain. The four
  documents and three machine-readable schemas are the entire deliverable.

## Open issues for v0.1 → v1.0

- **Float canonicalization.** Currently RFC 8785 §3.2.2.3 by reference;
  example writer restricts itself to integers. Real-world snapshots may
  force a tighter spec.
- **`mask_paths` glob dialect.** Currently "POSIX globbing" without
  pinning a specific implementation. Likely needs to converge on a single
  reference parser.
- **APM primitive types not in the harness vocabulary.** If APM extends
  its primitives (e.g. adding `tool-bundle`), harness needs a stated
  policy: extend the canonical enum, or treat as `x-`-prefixed extension.
