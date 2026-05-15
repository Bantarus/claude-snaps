# claude-snaps

[![CI](https://github.com/Bantarus/claude-snaps/actions/workflows/ci-playbook.yml/badge.svg)](https://github.com/Bantarus/claude-snaps/actions/workflows/ci-playbook.yml)
[![Latest release](https://img.shields.io/github/v/tag/Bantarus/claude-snaps?label=release&sort=semver)](https://github.com/Bantarus/claude-snaps/tags)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node ≥ 24](https://img.shields.io/badge/node-%E2%89%A524-brightgreen)](.nvmrc)

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
- You can **reproduce** a past snapshot's composition back onto a
  working tree (`harness reproduce`). **APM is a hard prerequisite
  for content materialization** ([`spec/format.md`](spec/format.md)
  §6.1) — without APM, reproduce verifies builtins and reports
  local-source modules but cannot rewrite files. The rest of
  harness (capture, `log`, `diff`, `sessions`, `snap`) works fine
  without APM. APM packaging and versioning is **manual and
  decoupled from snapshots** — you publish your skills/agents via
  APM on your own cadence, and claude-snaps just records the
  resulting `apm.lock.yaml` bytes at capture time. Snapshot lineage
  and APM release cadence are independent.

The repo ships:

- **The format spec** under [`spec/`](spec/) — `.harness/` filesystem
  layout, snapshot blob format, canonical-bytes derivation, the SQLite
  index schema, the hook contract, and the APM reproducer contract.
- **`@harness/core`** — TypeScript reference reader/writer/index/diff
  layer over the format. The contract is `Repo`; everything else is
  internal.
- **`harness` CLI** — `init`, `log`, `diff`, `snap`, `sessions`, `tag`,
  `branch`, `checkout`, `reindex`, `install-hook`, `reproduce`,
  `notes`, `ingest-session`, `session-cost`.
- **`harness-hook` binary** — fires on Claude Code's `SessionStart`
  and `UserPromptSubmit` events, dispatches to attribution-only or
  full-capture path via a per-session sqlite-backed cache.
- **`harness` Claude Code plugin** under [`plugin/`](plugin/) — skills,
  subagents, and slash commands that route natural-language questions
  ("what changed since yesterday?", "reproduce this snapshot") to the
  right CLI verb.

## Quick start

### Requirements

- **Node ≥ 24** and **pnpm ≥ 9** — build and runtime for `@harness/core`,
  `@harness/cli`, and `@harness/hook`.
- **[APM](https://github.com/microsoft/apm)** — *optional in general,
  but a hard dependency for `harness reproduce` to materialize content*
  ([`spec/format.md`](spec/format.md) §6.1). Without APM on `$PATH` you
  can still `init`, capture, `log`, `diff`, `snap`, and inspect
  `sessions`; `reproduce` will skip the content phase and only verify
  builtins / report local-source modules. APM packaging and versioning
  of your skills/agents is **manual and runs on its own cadence** —
  claude-snaps just records the resulting `apm.lock.yaml` bytes at
  snapshot time, so lineage stays decoupled from APM releases.

### Manual install

```bash
pnpm install
pnpm -r build
cd /your/project
harness init
harness install-hook    # writes both SessionStart + UserPromptSubmit entries
                        # to .claude/settings.json (with diff + confirm)
```

### Or let Claude Code do the install for you

Open a Claude Code session in the project you want to snapshot and
paste the prompt below. Claude will check prerequisites, build the
source, link the binaries, and run `harness init` + `install-hook` —
pausing for your approval on the one step that touches your project
(`install-hook`, which mutates `.claude/settings.json`).

```text
Install claude-snaps for snapshotting this project.

1. Check prerequisites:
   - Node ≥ 24 (`node -v`)
   - pnpm ≥ 9 (`pnpm -v`) — run `corepack enable` if missing
   - APM (`apm --version`) — WARN ME but proceed if APM is absent.
     APM is only needed for `harness reproduce` to materialize
     content; the rest of the tool works without it.

2. Get a source checkout of https://github.com/Bantarus/claude-snaps
   somewhere persistent (e.g. ~/tmp/claude-snaps). If I already have
   one, ask me where it is and skip the clone.

3. In that checkout: `pnpm install && pnpm -r build`.

4. Link the binaries globally so `harness` and `harness-hook` are on
   PATH. If `pnpm setup` has never been run on this machine, run it
   once and source the shell rc it modifies. Then from the checkout:
   - `cd packages/cli  && pnpm link --global && cd -`
   - `cd packages/hook && pnpm link --global && cd -`
   Verify with `which harness` and `which harness-hook`.

5. Back in my current project directory, run `harness init`.

6. Run `harness install-hook`. SHOW ME THE DIFF against
   .claude/settings.json before approving — the command writes a
   .bak automatically but I want to see what changes.

7. Sanity check: `harness log` should show one initial snapshot.
   Report what you see.

Notes:
- claude-snaps is experimental (see README warning). Don't proceed
  if my project has uncommitted changes I haven't acknowledged.
- Only step 6 mutates files in my project. Everything else is local
  to the source checkout.
- For the slash-command / skill plugin layer (/snap, /trajectory,
  etc.), see plugin/README.md after the install — that's a separate
  `claude --plugin-dir` setup step.
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
harness snap "<note>"        # attach a free-form note event
harness reproduce <snap-id>  # apply a past snapshot to the working tree
harness session-cost <session-id>  # per-turn token/cost breakdown (v0.5+)
```

For the natural-language path (slash commands, skills), see the
[plugin README](plugin/README.md).

## Format version

Currently **v0.4 Working Draft**, with v0.5.0 additions for session
metrics (`turn_metrics`, `claudeCodeVersion`) under a strict privacy
whitelist ([`spec/format.md`](spec/format.md) §10). Snapshots are
session-independent; session attribution is recorded as append-only
events in a separate `attributions` table. There is no automated
migrator between breaking spec bumps pre-1.0 — re-init is the
expected path. See [`spec/format.md`](spec/format.md) §9 for the
versioning rules.

## Architecture

```
claude-snaps/
├── spec/                # the .harness/ format spec
├── packages/
│   ├── core/            # @harness/core — read/write/index/diff
│   ├── cli/             # @harness/cli  — `harness` binary
│   └── hook/            # @harness/hook — `harness-hook` binary
├── plugin/              # Claude Code plugin (skills + agents + commands)
└── scripts/             # build_examples.py, schema-agreement check,
                         # dogfood-v0_4/ CI playbook
```

## Status

| | |
|---|---|
| Spec | v0.5.0 Working Draft |
| Latest release | [v0.5.1](https://github.com/Bantarus/claude-snaps/releases) — pre-public-release security hardening on top of v0.5.0 (see [`docs/security-review-2026-05-13.md`](docs/security-review-2026-05-13.md)) |
| Tests | 249 across 3 packages, all gates green (151 core + 75 CLI + 23 hook) |
| Reproducer | shipped in v0.4.0 (`harness reproduce`, APM-driven) |
| Session metrics | shipped in v0.5.0 (`harness ingest-session`, `harness session-cost`) |
| Plugin | shipped in v0.5-plugin (skills, agents, slash commands; APM hybrid dropped) |

## Running tests

```bash
pnpm -r build
pnpm -r test
python3 scripts/check_schema_agreement.py
python3 scripts/check_format_version_bump.py
```

The CI playbook (see [`.github/workflows/ci-playbook.yml`](.github/workflows/ci-playbook.yml)
and [`scripts/dogfood-v0_4/`](scripts/dogfood-v0_4/)) runs a 71-case
TAP 14 end-to-end suite against the real binaries; that is the
contract beyond the unit tests.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup,
dogfooding recipe, and test gates.

## Security

Found a vulnerability? Please report privately via [GitHub Security
Advisories](https://github.com/Bantarus/claude-snaps/security/advisories/new)
— see [SECURITY.md](SECURITY.md) for the policy.

## License

Code is licensed under [Apache License 2.0](LICENSE). The format
specification under [`spec/`](spec/) is licensed separately under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — see the
"Spec license" line in [`spec/format.md`](spec/format.md).
