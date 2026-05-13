# claude-snaps

> [!WARNING]
> **Experimental.** This project is in active development. The `.harness/`
> format, the `harness` CLI surface, and the Claude Code plugin are not
> yet stable — breaking changes can land between minor versions. Treat
> any snapshots, hooks, or settings written by this tool as disposable
> while you evaluate. Not recommended for production use.

A reference implementation and format spec for **agent-harness snapshot
lineage** — a `.harness/` directory that lives alongside your project
and records every change to the active Claude Code primitives
(personas, MCPs, skills, hooks, slash commands, output styles) over
time.

The pitch: when an agent runs a session in your project, the *harness*
— the configuration of which primitives are pinned and active — is
captured as an immutable **Snapshot**. Snapshots form a DAG (lineage)
that lives **alongside but decoupled from** your code's git history.
Each snapshot records a `codePin` (the git sha at the moment) so you
can always correlate, but you can rewind, branch, fork, diff and
promote *harnesses* without touching code.

This means:

- You can **time-travel the agent** independently of the codebase.
- You can **bisect** to find which harness change introduced a
  regression.
- You can **promote** a working tree to a named version (`v0.5`) the
  same way you tag a release.
- You can ask **"what did session N observe?"** and get back the
  exact composition the agent was running against, with a chronological
  trajectory of how that composition evolved.

The repo ships:

- **The format spec** under [`spec/`](spec/) — `.harness/` filesystem
  layout, snapshot blob format, canonical-bytes derivation, the SQLite
  index schema, and the hook contract.
- **`@harness/core`** — TypeScript reference reader/writer/index/diff
  layer over the format. The contract is `Repo`; everything else is
  internal.
- **`harness` CLI** — `init`, `log`, `diff`, `snap`, `sessions`, `tag`,
  `branch`, `checkout`, `migrate`, `reindex`, `install-hook`.
- **`harness-hook` binary** — fires on Claude Code's `SessionStart` and
  `UserPromptSubmit` events, dispatches to attribution-only or
  full-capture path via a per-session sqlite-backed cache.

## Quick start

```bash
pnpm install
pnpm -r build
cd /your/project
harness init
harness install-hook    # writes both SessionStart + UserPromptSubmit entries
                        # to .claude/settings.json (with diff + confirm)
```

Now every Claude Code session in that directory captures the harness
state. Inspect:

```bash
harness log                  # snapshots, newest first
harness log --with-sessions  # with attribution-row counts per snapshot
harness sessions             # list every session that has been observed
harness sessions <session-id>  # render that session's trajectory
harness diff <a> <b>         # composition delta between two snapshots
harness snap -m "baseline"   # manual capture with a message
```

## Format version

Currently **v0.2.0 Working Draft**. Snapshots are session-independent;
session attribution is recorded as append-only events in a separate
`attributions` table. Migration from v0.1.x is one-shot and idempotent
via `harness migrate`. See [`spec/format.md`](spec/format.md) §9 for
the versioning rules.

## Architecture

```
claude-snaps/
├── spec/                # the .harness/ format spec (locked at v0.2.0)
├── packages/
│   ├── core/            # @harness/core — read/write/index/diff
│   ├── cli/             # @harness/cli  — `harness` binary
│   └── hook/            # @harness/hook — `harness-hook` binary
└── scripts/             # build_examples.py, schema-agreement check
```

## Status

| | |
|---|---|
| Format | v0.2.0 Working Draft (decoupled snapshots / attribution events / dual-event hook) |
| Tests | 171 across packages, all gates green |
| Reproducer (apply a snapshot to a working tree) | not yet implemented |

## Running tests

```bash
pnpm -r build
pnpm -r test
python3 scripts/check_schema_agreement.py
python3 scripts/check_format_version_bump.py
```

## License

CC BY 4.0 for the spec; reference implementation TBD.
