# spec/test-vectors

Byte-exact fixtures for cross-language conformance testing.

## `canonical-501.bin` (v0.2.0)

The canonical-bytes serialization of the snapshot in
[../format.md §3.2](../format.md#32-test-vector), with `id` omitted.
**Filename is historical**: the v0.1.x fixture was 501 bytes, so the
file was named `canonical-501.bin`. The v0.2.0 fixture is **503 bytes**
(the `kind` field grew from `"edit"` (4 bytes) to `"manual"` (6 bytes),
and `sessionId` was dropped). The filename was retained for stability
across cross-impl tooling that may reference it by name.

A conforming v0.2.0 implementation MUST satisfy:

```
sha256(read_bytes("canonical-501.bin")).hexdigest() ==
  "2f9993556a22abc7f52e5af006affd1e76a2c5b73bb403debe3e070325b9d4a2"

sha256(read_bytes("canonical-501.bin")).hexdigest()[:40] ==
  "2f9993556a22abc7f52e5af006affd1e76a2c5b7"
```

…and, given the **input snapshot dict** shown in
[../format.md §3.2](../format.md#32-test-vector), MUST produce exactly
those 503 bytes when serialized through the canonicalizer defined in
[../format.md §3.1](../format.md#31-canonical-json).

The fixture is regenerated automatically by
[../../scripts/build_examples.py](../../scripts/build_examples.py) — if
you change the canonicalization rules in `format.md`, both the fixture
and the cited digest must be updated together.

## `canonical-501-v0_1_1.bin` (v0.1.1, frozen)

The 501-byte v0.1.x fixture, preserved for migration tests. Migration
tooling under `harness migrate` reads this fixture to verify the
v0.1.1 → v0.2.0 re-canonicalization path produces the expected
post-migration digest. Do **not** regenerate this file; it is frozen
at the v0.1.1 baseline (digest
`977d89c4deef44ae18ab764350d01a54357b84ec92d077de2a9a4531c1048e26`).

### Recommended test pattern (any language)

1. Construct the input snapshot dict in the host language (mirroring
   the literal in `format.md §3.2`).
2. Run it through the implementation's canonicalizer.
3. Assert byte-exact equality with the contents of `canonical-501.bin`.
4. Hash both — confirm the digest matches the cited value.

The **forward** test (input → bytes → digest) catches canonicalizer
bugs at write time. The **byte fixture** test (load bytes → digest)
catches canonicalizer bugs at read/validation time. A conforming
implementation passes both.
