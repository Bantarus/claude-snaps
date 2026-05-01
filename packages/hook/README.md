# `@harness/hook`

Scaffolded for prompt B2 — not implemented yet.

The SessionStart hook binary (specified in
[`spec/hooks.md`](../../spec/hooks.md)) lives here. It calls
`captureCurrentState()` and `Repo.snapshot.write()` from
[`@harness/core`](../core/) — same code path as the editor's working-tree
view, no duplication.
