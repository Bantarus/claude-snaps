# compat-session-ctx — optional `model` / `permissionMode` round-trip

A v0.3 reader MUST preserve the optional top-level `model` and
`permissionMode` fields when present (format.md §2.1, §9.2). This fixture
contains a single `auto` snapshot with both fields populated as the
hook (SessionStart or UserPromptSubmit) would write them from its stdin
payload.

| Field | Value | Source |
|---|---|---|
| `model` | `claude-opus-4-7` | `stdin.model` (hooks.md §1.1) |
| `permissionMode` | `default` | `stdin.permission_mode` (hooks.md §1.1) |

Sibling fixtures under `examples/compat-fixtures/` exercise the
field-absent path. Together these two cover both code paths a v0.3
reader must handle.
