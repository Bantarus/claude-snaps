# `.harness/` — SessionStart hook contract

> **Status:** Working Draft v0.1.
> **Conformance terminology:** [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) (MUST / SHOULD / MAY).
> **Companion to:** [format.md](format.md), [apm-integration.md](apm-integration.md).

This document specifies the contract between an agent runtime that fires a
**SessionStart** event and a hook executable that records an `auto`-kind
snapshot to `.harness/`. The hook is the most common entry point for
populating `.harness/`; the rest of this document is written from its
perspective. Other writers (CLI commands, IDE integrations) follow the
same data contract but may diverge on argument forms.

## 1. Invocation interface

The hook reads its input from one of three channels, in priority order
**stdin > CLI > environment**, merging field-by-field. A conforming
hook MUST accept all three; hosts that follow this spec literally MAY
provide any combination.

### 1.1 Channel A — stdin JSON (primary, Claude-Code-native)

Claude Code (and similar hosts) write a single JSON object to the hook
binary's stdin and close the stream. The hook MUST read fd 0 to EOF and
parse the result as JSON. The schema:

```json
{
  "session_id":       "<string, required>",
  "cwd":              "<absolute path, required>",
  "hook_event_name":  "SessionStart",
  "transcript_path":  "<absolute path to session JSONL, optional>",
  "source":           "startup | resume | clear | compact",
  "model":            "<model id, optional>",
  "permission_mode":  "<default | plan | acceptEdits | bypassPermissions, optional>",
  "agent_type":       "<string, only when --agent <name> was used>"
}
```

Field names are **snake_case** (Claude Code's convention). Conforming
hosts SHOULD pass at least `session_id` and `cwd`. The hook MUST capture
`model` and `permission_mode` when present and write them through to the
snapshot blob's `model` / `permissionMode` fields verbatim (see
[format.md §2.1](format.md#21-required-and-optional-fields)) — both are
session-level context that materially changes what `harness diff` can
explain about behavioral drift between snapshots, and they cannot be
backfilled because snapshots are immutable. Other unknown fields are
observed-and-ignored in v0.1.

### 1.2 Channel B — CLI flags (secondary, testing)

The hook MUST also accept the following command-line arguments. These
are intended for testing the hook in isolation and for hosts that
prefer the older CLI interface from earlier drafts of this spec:

| Argument | Required? | Meaning |
|---|---|---|
| `--session-id <id>` | yes (if no stdin) | Stable identifier for the session. |
| `--cwd <path>` | yes (if no stdin) | Absolute path to the project root. |
| `--reason <auto\|manual\|fork>` | no | Why the hook fired. Defaults to `auto`. |
| `--dry-run` | no | If present, the hook MUST NOT write; it MAY emit the snapshot blob to stdout. |

Unknown CLI flags MUST be accepted-and-ignored (so future host versions
that pass extra flags don't break the hook).

### 1.3 Channel C — environment variables (fallback)

The hook MUST recognize:

- `CLAUDE_PROJECT_DIR` — absolute path to the project root. Used as a
  fallback for `cwd` when neither stdin nor CLI provides one.

The hook MUST NOT depend on any `CLAUDE_SESSION_ID` env var; **no such
variable is part of the contract** (despite earlier drafts of this spec
claiming otherwise).

### 1.4 Merge and validation

After reading all three channels, the hook merges field-by-field with
stdin winning over CLI winning over env. If after merging there is no
`session_id` OR no `cwd`, the hook MUST fail (channel A or B SHOULD
log an error to stderr; per §1.5 the exit is still 0).

### 1.5 Exit code policy

The hook MUST exit `0` on every code path, including caught exceptions.
The "MUST NOT block the session start" rule from earlier drafts described
host behavior; the hook's defense-in-depth is to never give the host a
non-zero exit to potentially mishandle. Failures emit
`harness-hook: error: <message>` to stderr per [§6](#6-error-reporting).

The hook MUST be safe to invoke with an empty environment beyond `PATH`,
`HOME`, and `CLAUDE_PROJECT_DIR`.

## 2. What the hook captures

On a successful run, the hook MUST produce **exactly one** snapshot blob
under `.harness/snapshots/` and MUST update `.harness/lineage.sqlite`
to reflect it (and any newly-observed sessions/usage). The blob's
`kind` MUST be `"auto"` (or `"init"` if `HEAD` resolves to no commit yet,
i.e. the very first snapshot of an empty repo per
[format.md §4.4](format.md#44-the-empty-repository)), `sessionId` MUST
be set to the value resolved from [§1.4](#14-merge-and-validation),
and `parentIds` MUST contain exactly one id — the current `HEAD`
resolved to a snapshot id — except on the empty-repo first snapshot,
where `parentIds` MUST be empty.

### 2.1 Module discovery

The hook captures Claude Code primitives by walking the project's
`.claude/` tree. The minimum set of inputs:

| Source | Captured as |
|---|---|
| `.claude/settings.json` — `hooks` section | one `hook`-type module per entry |
| `.claude/settings.json` — `mcpServers` section | one `mcp`-type module per server |
| `.claude/skills/<name>/SKILL.md` | one `skill`-type module |
| `.claude/commands/<name>.md` | one `prompt`-type module (name = `/<name>`) |
| `.claude/agents/<name>.md` | one `agent`-type module — or `chatmode` if frontmatter declares it as such |
| `.claude/output-styles/<name>.md` | one `style`-type module |
| `CLAUDE.md`, `AGENTS.md` (project root only) | one `instruction`-type module per file |
| Built-in tools (`Read`, `Write`, `Bash`, `Edit`, `Grep`, `Glob`, etc.) | one `mcp`-type module each, with `source: { kind: "builtin" }` |

For each captured module, the hook MUST:

1. Determine the module's defining file path (POSIX, repo-relative).
2. If APM integration is enabled (see [apm-integration.md §1](apm-integration.md#1-discovery))
   and the path matches a lockfile entry's `deployed_files`, set
   `source: { kind: "apm", … }` per [§2 of that doc](apm-integration.md#2-mapping-modules-to-lockfile-entries).
   Otherwise, set `source: { kind: "local", path }`.
3. Compute `configHash` if relevant configuration bytes exist (e.g. a
   `mcpServers[<name>]` block). The bytes hashed MUST include only that
   server's block, sorted by key.
4. Set `enabled` based on settings (defaulting to `true` when the
   primitive is present and not explicitly disabled).

`CLAUDE.md` content is captured as `instruction`-type with `source:
{ kind: "local", path: "CLAUDE.md" }` and a `configHash` over its full
file bytes.

The hook MUST NOT walk user-level `~/.claude/` or any non-project path —
v0.1 capture is project-only by design. See
[format.md §1.1](format.md#11-capture-scope-project-level-only-v01)
for the rationale (portability across machines outweighs fidelity to a
single developer's runtime). User-level capture is a v0.2 candidate.

### 2.2 Module ordering

The `modules` array order is part of the canonical bytes (§3 of
[format.md](format.md)) and therefore part of the snapshot id. The hook
MUST emit modules in the following order to keep ids stable across runs
that observe the same composition:

1. By canonical type, in this fixed order:
   `chatmode`, `instruction`, `agent`, `skill`, `prompt`, `mcp`, `hook`, `style`.
2. Within a type, ascending by `name` (UTF-16 code-unit sort, matching
   the canonical-JSON key order rule).

Implementations that diverge from this ordering will produce different
ids for identical compositions and will not interoperate for content
deduplication.

### 2.3 What the hook does NOT capture in v0.1

- File contents of local-source modules. The blob records paths only;
  reproducing local sources from snapshot alone is not supported. See
  [format.md §9.3](format.md#93-what-v02-is-expected-to-add).
- Permissions / settings beyond what's needed to identify a module.
  `enabled` is recorded; the full ACL is not.
- Process-level state (env vars, working directory beyond `--cwd`).

## 3. Atomic write protocol

The hook MUST write the snapshot blob atomically:

1. Canonicalize the blob (omit `id`); compute `id` per
   [format.md §3](format.md#3-snapshot-id-derivation).
2. Set `blob.id = <derived-id>`.
3. Serialize the on-disk JSON form (pretty-printed is RECOMMENDED) to
   a temp file in the same directory: `snapshots/<aa>/.tmp-<rest>.json`.
   Same-directory placement is required so the rename is atomic on
   POSIX file systems.
4. `fsync` the temp file.
5. `rename(2)` the temp file to `snapshots/<aa>/<rest>.json`.
6. Open `lineage.sqlite` (in WAL mode), insert the snapshot,
   parent edges, modules, and (if newly observed) the session row,
   in a single transaction. Commit.

Steps 3–5 MUST NOT be reordered. Step 6 MUST be a transaction; partial
writes that leave only the blob on disk are recoverable via reindex,
but partial SQLite updates corrupt the index.

## 4. Concurrency and idempotency

### 4.1 Multiple concurrent hooks

The runtime MAY fire SessionStart for multiple sessions concurrently
(common in tab-style IDE workflows). The hook MUST handle this without
corruption:

- SQLite MUST be opened in **WAL** mode (`PRAGMA journal_mode = WAL;`).
  The schema in [001_init.sql](schema/001_init.sql) sets this.
- The atomic write protocol (§3) ensures snapshot blobs do not collide
  on the file system — different sessions produce different bytes,
  hence different ids, hence different filenames.
- If two concurrent hooks observe the *same* HEAD and the *same*
  composition, they will compute the *same* id and write the same
  bytes; the OS-level `rename(2)` is atomic, so at most one wins the
  final filename slot and the other harmlessly overwrites with
  identical bytes. Implementations SHOULD detect this case and skip
  re-writing.

### 4.2 Idempotency

If the hook fires twice for the same `--session-id`, the second
invocation MUST be a near-no-op:

- Lookup `sessions(id) = ?` in `lineage.sqlite`.
- If found, the hook MUST NOT write a new snapshot blob.
- The hook MAY update derived fields on the existing session row
  (e.g. `started_at` if the runtime reports a corrected timestamp,
  observed-use counts in `session_usage` if the runtime supplies
  them). It MUST NOT change `snapshot_id`.
- The hook MUST exit `0`.

This rule lets runtimes safely retry the hook on transient failures
without polluting the lineage.

## 5. Performance budget

The hook is invoked synchronously at session start. Slowness blocks the
user. Implementations SHOULD treat the following as a hard target:

- **p95 < 200ms** on a project with ≤500 snapshots, ≤200 captured modules,
  on a developer laptop (cold cache).
- **p99 < 500ms**.

Cold-start sensitivity is the main constraint. The hook SHOULD avoid
loading large language runtimes; a small native binary or a single-file
script is preferred. SQLite operations SHOULD be batched into one
transaction.

If the hook cannot meet the budget on a given project, it SHOULD
degrade gracefully: log a warning, fall back to a delayed write
(spawn a detached process to finish the work), and exit `0` quickly.
The runtime is not required to wait for the delayed write to complete.

## 6. Error reporting

The hook SHOULD write structured progress to stderr in this form:

```
harness-hook: <level>: <message>
```

…where `<level>` is one of `debug`, `info`, `warn`, `error`. Runtimes
typically capture stderr; this format makes log triage straightforward.

A non-zero exit code communicates only "something went wrong" — the
runtime MUST NOT parse the exit code beyond zero / non-zero. Detail
goes to stderr.

## 7. Examples

[`examples/solo-no-apm/.harness/snapshots/0a/2b7a6700d1bb346e911bd1ad24ef632462ce10.json`](examples/solo-no-apm/.harness/snapshots/0a/2b7a6700d1bb346e911bd1ad24ef632462ce10.json)
shows the output of an idealized hook on a project with no APM lockfile.
Note `kind: "auto"`, `sessionId: "sess-162"`, and `parentIds: [<id of preceding edit>]`.

[`examples/team-shared/.harness/snapshots/b0/1045525b6701fd2f08965be0fd21b67f1ed8f0.json`](examples/team-shared/.harness/snapshots/b0/1045525b6701fd2f08965be0fd21b67f1ed8f0.json)
shows the output on an APM-enabled project. Modules carry `source.kind:
"apm"` where APM owns the path, `local` for a hand-edited `/plan`
prompt, and `builtin` for Read/Write/Bash. `apmLockHash` is set to the
sha256 of the lockfile bytes at snapshot time.
