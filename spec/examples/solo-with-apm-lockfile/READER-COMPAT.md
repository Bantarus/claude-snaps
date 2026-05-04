# solo-with-apm-lockfile — v0.4.0 reproducer fixture

Exercises the optional top-level `apmLockfile` field added in v0.4.0
(format.md §2.1, §6.1, §9.8). The single `auto` snapshot has both
`apmLockHash` and `apmLockfile` populated; the hash is the sha-256
of the lockfile's verbatim bytes. A v0.3.x reader preserves
`apmLockfile` as an unknown field per §9.2; a v0.4.0 reader uses it
to drive `harness reproduce`.

| Field | Source |
|---|---|
| `apmLockHash` | sha-256 of `apm.lock.yaml` bytes (existing v0.3 field) |
| `apmLockfile` | verbatim text of `apm.lock.yaml` (new v0.4 field) |

The fixture's `apm.lock.yaml` resolves a local file:// repo
(`./apm-source-fixture/`) so the reproducer can verify end-to-end
without network. The repo isn't checked in here as a real git tree —
it's a documentation hint that a real-world reproduction setup uses
local sources for tests. End-to-end test fixtures with real APM-
managed git repos live under `packages/core/test/fixtures/`.
