# spec/test-vectors

Byte-exact fixtures for cross-language conformance testing.

## `canonical-501.bin` (v0.3.0)

The canonical-bytes serialization of the snapshot in
[../format.md §3.3](../format.md#33-test-vector), with the §3.1
excluded fields stripped. **Filename is historical**: the v0.1.x
fixture was 501 bytes, so the file was named `canonical-501.bin`. The
v0.3.0 fixture is **382 bytes** — `sessionId` and `message` were both
removed from the blob over the v0.1 → v0.2 → v0.3 evolution, and §3.1
strips `createdAt`, `codePin`, `model`, `permissionMode` from canonical
bytes (composition vs. observation context). The filename was retained
for stability across cross-impl tooling that may reference it by name.

A conforming v0.3.0 implementation MUST satisfy:

```
sha256(read_bytes("canonical-501.bin")).hexdigest() ==
  "da5289e572c0fe42e6dcda250a6d392543302965325c56a31f9fce9c4d740412"

sha256(read_bytes("canonical-501.bin")).hexdigest()[:40] ==
  "da5289e572c0fe42e6dcda250a6d392543302965"
```

…and, given the **input snapshot dict** shown in
[../format.md §3.3](../format.md#33-test-vector), MUST produce exactly
those 382 bytes when serialized through the canonicalizer defined in
[../format.md §3.2](../format.md#32-canonical-json) after stripping
the §3.1 excluded fields.

The fixture is regenerated automatically by
[../../scripts/build_examples.py](../../scripts/build_examples.py) — if
you change the canonicalization rules in `format.md`, both the fixture
and the cited digest must be updated together.

## Historical fixtures

The fixture has moved twice as the data model evolved. The historical
versions are preserved alongside the current one so the canonical-bytes
evolution is auditable.

### `canonical-501-v0_1_1.bin` (v0.1.1, frozen)

The 501-byte v0.1.x fixture. Migration tooling under `harness migrate`
reads this fixture to verify the v0.1.1 → v0.2.0 re-canonicalization
path produces the expected post-migration digest. Do **not** regenerate
this file; it is frozen at the v0.1.1 baseline (digest
`977d89c4deef44ae18ab764350d01a54357b84ec92d077de2a9a4531c1048e26`).

### `canonical-501-v0_2_0.bin` (v0.2.0, frozen)

The 411-byte v0.2.0 fixture, preserved as a breadcrumb of the
canonical-bytes evolution. There is no automated v0.2.x → v0.3.0
migrator (see [../format.md §9.6](../format.md#96-v02x--v030-no-automated-migration));
this fixture is purely a forensic reference for "what did v0.2.0
canonical bytes look like." Do **not** regenerate this file; it is
frozen at the v0.2.0 baseline (digest
`cc645898beca440be69ed860eca4a2b24e25f29c4369f75c48f00d69d03de89d`).

## Recommended test pattern (any language)

1. Construct the input snapshot dict in the host language (mirroring
   the literal in `format.md §3.3`).
2. Run it through the implementation's canonicalizer.
3. Assert byte-exact equality with the contents of `canonical-501.bin`.
4. Hash both — confirm the digest matches the cited value.

The **forward** test (input → bytes → digest) catches canonicalizer
bugs at write time. The **byte fixture** test (load bytes → digest)
catches canonicalizer bugs at read/validation time. A conforming
implementation passes both.
