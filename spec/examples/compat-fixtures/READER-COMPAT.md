# compat-fixtures — reader compatibility test cases

These snapshots are SYNTHETIC. A v0.2 writer never produces them. A v0.2
reader MUST tolerate them per the rules in spec/format.md §4.1 (merge
parents) and §9.2 (unknown `source.kind` and forward-compat fields).

Purpose: a reference reader can be regression-tested by loading this
example and asserting that it surfaces each blob without crashing,
preserves unknown variants on round-trip, and renders the DAG correctly
(including the merge node and its diamond-shaped ancestry).

| Snapshot kind/role     | What it exercises |
|---|---|
| init                   | baseline ancestor for the diamond |
| manual (left)          | one branch of the diamond |
| manual (right)         | other branch of the diamond |
| manual — merge         | `parentIds.length === 2`; readers MUST handle |
| manual — x-extension   | a module whose `source.kind` is `x-experimental-bundle`; readers MUST preserve verbatim and treat as opaque |

The `examples/compat-session-ctx/` example is a sibling fixture that exercises
populated optional `model` and `permissionMode` blob fields — kept separate so
the diamond DAG above stays free of additional descendants.

The example uses the `manual` kind for the merge node rather than
introducing a `merge` kind enum value — v0.2 of the spec reserves
length-2 parents but does not add a kind for it. The `manual` value
covers any composition-change capture in v0.2 (replacing v0.1's
`edit`/`auto`/`fork`).
