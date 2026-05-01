# spec/test-vectors

Byte-exact fixtures for cross-language conformance testing.

## `canonical-501.bin`

The canonical-bytes serialization of the snapshot in
[../format.md §3.2](../format.md#32-test-vector), with `id` omitted.
Exactly **501 bytes** of UTF-8.

A conforming implementation MUST satisfy:

```
sha256(read_bytes("canonical-501.bin")).hexdigest() ==
  "977d89c4deef44ae18ab764350d01a54357b84ec92d077de2a9a4531c1048e26"

sha256(read_bytes("canonical-501.bin")).hexdigest()[:40] ==
  "977d89c4deef44ae18ab764350d01a54357b84ec"
```

…and, given the **input snapshot dict** shown in
[../format.md §3.2](../format.md#32-test-vector), MUST produce exactly
these 501 bytes when serialized through the canonicalizer defined in
[../format.md §3.1](../format.md#31-canonical-json).

The fixture is regenerated automatically by
[../../scripts/build_examples.py](../../scripts/build_examples.py) — if
you change the canonicalization rules in `format.md`, both the fixture
and the cited digest must be updated together.

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
