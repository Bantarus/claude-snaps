# compat-user-scope — `[capture].scope = "user"` round-trip

A reader MUST handle the `user` source kind per format.md §2.6. This
fixture's snapshot includes a mix of project-level (`kind: "local"`)
and user-level (`kind: "user"`) modules — the shape produced when a
SessionStart hook runs against a project whose config has flipped
scope from the default `"project"` to `"user"`.

| Module | source.kind | path |
|---|---|---|
| chatmode `senior-eng`        | local | `.claude/agents/senior-eng.md` |
| skill    `research`          | user  | `.claude/skills/research/SKILL.md` (relative to $HOME) |
| hook     `SessionStart#0`    | user  | `.claude/settings.json` (relative to $HOME) |
| mcp      `Read`              | builtin | — |

Cross-machine consumers (team-sync, public diffs) SHOULD filter
`kind: "user"` modules per format.md §9.2 — they are not portable.
The blob still records them so a return to the writer's machine
reproduces the full composition; the filter is rendering-side, not
storage-side.
