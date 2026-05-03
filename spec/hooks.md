# `.harness/` — Hook contract (SessionStart, UserPromptSubmit)

> **Status:** Working Draft v0.3.0.
> **Conformance terminology:** [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) (MUST / SHOULD / MAY).
> **Companion to:** [format.md](format.md), [apm-integration.md](apm-integration.md).

This document specifies the contract between an agent runtime that fires
hook events and a hook executable that records the harness composition
into `.harness/`. In v0.3.0 the hook MUST handle two events:

- **`SessionStart`** — fired on every host-level session-start event
  (startup, resume, clear, compact). Records a `session_start`
  attribution event ([format.md §2.7](format.md#27-attribution-events))
  with the host's `source` value carried through.
- **`UserPromptSubmit`** — fired on every user prompt within a session,
  including the first prompt of a resumed session. Records a
  `user_prompt` attribution event.

On each fire, the hook either appends an attribution event to an
existing snapshot (when composition is unchanged since the previous
fire) or writes a new `auto`-kind snapshot blob plus an attribution
event (when composition changed). The hook is the most common entry
point for populating `.harness/`; the rest of this document is written
from its perspective. Other writers (CLI commands, IDE integrations)
follow the same data contract but may diverge on argument forms — for
example, `harness snap "<note>"` follows the same change-detection path
and additionally appends a `note` attribution event carrying the user's
text (see [format.md §2.7](format.md#27-attribution-events)).

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
  "hook_event_name":  "SessionStart | UserPromptSubmit",
  "transcript_path":  "<absolute path to session JSONL, optional>",
  "source":           "startup | resume | clear | compact (SessionStart only)",
  "model":            "<model id, optional>",
  "permission_mode":  "<default | plan | acceptEdits | bypassPermissions, optional>",
  "agent_type":       "<string, only when --agent <name> was used>"
}
```

Field names are **snake_case** (Claude Code's convention). Conforming
hosts SHOULD pass at least `session_id`, `cwd`, and `hook_event_name`.
The hook MUST distinguish events via `hook_event_name`:

- `"SessionStart"` → append a `session_start` attribution; copy
  `source` (the `startup` / `resume` / `clear` / `compact` value)
  through to the attribution row.
- `"UserPromptSubmit"` → append a `user_prompt` attribution; the
  `source` field is ignored even if present.

The hook MUST capture `model` and `permission_mode` when present and
write them through to any newly-written snapshot blob's `model` /
`permissionMode` fields verbatim (see
[format.md §2.1](format.md#21-required-and-optional-fields)) — both are
session-level context that materially changes what `harness diff` can
explain about behavioral drift between snapshots, and they cannot be
backfilled because snapshots are immutable. When the hot-path
optimization (§2.4) skips writing a new snapshot, `model` and
`permission_mode` are not re-applied to the existing snapshot. Other
unknown fields are observed-and-ignored in v0.3.

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

On a successful run, the hook MUST update `.harness/lineage.sqlite` to
record the event. Whether a new snapshot blob is written depends on
composition-change detection (see
[format.md §2.7](format.md#27-attribution-events)):

- **Composition unchanged** since the previous fire (or, on first ever
  fire, against the snapshot at the current `HEAD`): the hook MUST
  append exactly one row to `attributions` referencing the existing
  snapshot id, and MUST NOT write a new blob, advance any ref, or
  otherwise mutate the snapshots table. This is the **no-change path**.
- **Composition changed** (or no current `HEAD` snapshot, i.e. empty
  repo first fire): the hook MUST write a new snapshot blob whose
  `kind` is `"auto"` (or `"init"` if `HEAD` resolves to no commit yet,
  i.e. the very first snapshot of an empty repo per
  [format.md §4.4](format.md#44-the-empty-repository)), advance the
  current branch ref to the new id, and append exactly one row to
  `attributions` referencing the new id. `parentIds` MUST contain
  exactly one id — the prior tip of the current branch — except on the
  empty-repo first snapshot, where `parentIds` MUST be empty.

Snapshots no longer carry a `sessionId` field; session attribution is
captured exclusively through the attribution row.

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
v0.3 capture is project-only by design. See
[format.md §1.1](format.md#11-capture-scope-project-level-only-v03)
for the rationale (portability across machines outweighs fidelity to a
single developer's runtime). User-level capture is a v0.4 candidate.

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

### 2.3 What the hook does NOT capture in v0.3

- File contents of local-source modules. The blob records paths only;
  reproducing local sources from snapshot alone is not supported. See
  [format.md §9.4](format.md#94-what-v04-is-expected-to-add).
- Permissions / settings beyond what's needed to identify a module.
  `enabled` is recorded; the full ACL is not.
- Process-level state (env vars, working directory beyond `--cwd`).

### 2.4 Hot-path optimization (UserPromptSubmit cadence)

Because `UserPromptSubmit` fires on every user prompt, the hook can run
dozens of times per session. The hot-path optimization keeps the
no-change path cheap:

1. Compute a fast pre-hash of the project's `.claude/` tree plus
   `apm.lock.yaml` using filesystem mtimes/sizes (or an equivalent
   cheap signal). This MUST NOT require reading file contents. The
   lockfile is included because an APM dependency change is a
   composition change even when nothing under `.claude/` moved.
2. Look up the per-session cache: `(session_id) → (fastHash,
   snapshotId)`. Where the cache lives is implementation-defined and
   non-normative; the reference implementation (`@harness/core`)
   stores it inside `lineage.sqlite` (table
   `session_observation_cache`, schema-only added in migration `003`),
   keeping the cache reconstructible from blobs alongside the rest of
   the index. Other writers MAY use a different storage mechanism
   (in-process for long-lived hosts, on-disk file, etc.) or skip the
   optimization entirely.
3. If the cache has an entry for `session_id` and `entry.fastHash ==
   fastHash`: short-circuit. Append an attribution row referencing
   `entry.snapshotId` and exit. The cache row stays as-is (still valid).
4. Otherwise: fall through to the full capture path (walk
   `.claude/`, canonicalize, run composition-change detection vs. the
   head snapshot's modules per §2). After the attribution commits,
   refresh the cache with the new `(fastHash, snapshotId)`. The cache
   write MUST NOT share a transaction with the attribution insert: a
   failed cache write or a process crash between the attribution and
   the cache update is harmless (the next fire safely re-walks).

The fast pre-hash is advisory: false negatives (mtime unchanged after a
content edit) cost at most one missed attribution event for that
prompt, never data corruption. Implementations SHOULD target **p95
< 10ms** on the no-change path (cache hit) and **p95 < 50ms** on the
change path (cache miss).

The cache is the index's, not a primary data store: it is
reconstructible (drop it, no data loss) and a fresh `harness reindex`
MAY clear it. The first fire of any session is always a cache miss and
runs the full path — an acceptable warm-up cost.

## 3. Atomic write protocol

The hook MUST write the snapshot blob atomically when composition
changed (the change path; §2). On the no-change path, only step 6 runs
(an attribution row insert).

1. Canonicalize the blob (omit `id`); compute `id` per
   [format.md §3](format.md#3-snapshot-id-derivation).
2. Set `blob.id = <derived-id>`.
3. Serialize the on-disk JSON form (pretty-printed is RECOMMENDED) to
   a temp file in the same directory: `snapshots/<aa>/.tmp-<rest>.json`.
   Same-directory placement is required so the rename is atomic on
   POSIX file systems.
4. `fsync` the temp file.
5. `rename(2)` the temp file to `snapshots/<aa>/<rest>.json`.
6. Open `lineage.sqlite` (in WAL mode), in a single transaction:
   - When composition changed: insert into `snapshots`,
     `snapshot_parents`, `snapshot_modules`, then advance the branch
     ref's row equivalent, then insert the attribution row.
   - When composition unchanged: insert only the attribution row.
   Commit.

Steps 3–5 MUST NOT be reordered and only execute on the change path.
Step 6 MUST be a transaction; partial writes that leave only the blob
on disk are recoverable via reindex, but partial SQLite updates corrupt
the index.

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

The attribution table's primary key is `(session_id, observed_at,
event_kind)`. Implementations MUST handle a primary-key conflict on
attribution insert as a successful no-op (the event was already
recorded; retry is harmless). The hook MUST exit `0` in either case.

A retry of the same logical hook fire (same `session_id`,
`hook_event_name`, and roughly the same `observed_at`) therefore
collapses to at most one attribution row plus at most one new snapshot
blob. The atomic write protocol (§3) guarantees the blob bytes are
identical on retry, so the OS-level `rename(2)` is harmless if the
filename was already taken.

Implementations MAY round `observed_at` to a coarser resolution (e.g.
to the second) to make retries collide more reliably. The default of
millisecond precision is RECOMMENDED.

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

The blob files under [`examples/solo-no-apm/.harness/snapshots/`](examples/solo-no-apm/.harness/snapshots/)
show the output of an idealized hook on a project with no APM lockfile
— the `auto`-kind blobs that represent the composition observed on
each fire that detected a change.

[`examples/team-shared/.harness/snapshots/`](examples/team-shared/.harness/snapshots/)
shows the output on an APM-enabled project. Modules carry
`source.kind: "apm"` where APM owns the path, `local` for a hand-edited
`/plan` prompt, and `builtin` for Read/Write/Bash. `apmLockHash` is set
to the sha256 of the lockfile bytes at snapshot time.

Note: snapshot blobs do **not** carry session attribution or free-form
text in v0.3.0. Both live in `lineage.sqlite`'s `attributions` table —
the `(session_id, snapshot_id, observed_at, event_kind, note_text)`
tuples; see [format.md §2.7](format.md#27-attribution-events).
