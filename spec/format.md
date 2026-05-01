# `.harness/` — Agent harness lineage format

> **Status:** Working Draft v0.1 — unstable, may change without notice until v1.0.
> **Editors:** the harness-snaps authors.
> **Format:** Markdown, JSON Schema 2020-12, SQLite schema (SQL DDL).
> **Conformance terminology:** [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) (MUST / SHOULD / MAY).
> **Spec license:** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

This document specifies `.harness/`, an on-disk format that records agent-harness
snapshots and session lineage alongside any coding project — analogous to how
`.git/` records code history. Conforming readers and writers can interoperate
without sharing source code; the directory contents are the contract.

Companion documents:

- [apm-integration.md](apm-integration.md) — interop with `apm.yml` / `apm.lock.yaml`.
- [hooks.md](hooks.md) — the SessionStart hook contract.
- [schema/001_init.sql](schema/001_init.sql) — the canonical SQL schema.
- [schema/snapshot.schema.json](schema/snapshot.schema.json) — JSON Schema for snapshot blobs.
- [schema/config.schema.json](schema/config.schema.json) — JSON Schema for `.harness/config`.

## 1. Filesystem layout

A `.harness/` directory MUST contain the entries below. Optional entries
SHOULD be omitted when empty rather than created as empty stubs (the
`harness init` operation creates only `HEAD`, `config`, and the `snapshots/`
and `refs/heads/` directories — refs files are created on first commit).
For the precise state of a freshly-initialized repository, see
[§4.4 The empty repository](#44-the-empty-repository).

```
.harness/
├── HEAD                    # Text. Current ref, e.g. "ref: refs/heads/main\n".
├── config                  # TOML. User config; see §7.
├── lineage.sqlite          # SQLite. DERIVABLE INDEX. See §5.
├── snapshots/              # SOURCE OF TRUTH. Content-addressable JSON blobs.
│   ├── <aa>/               # First 2 hex chars of snapshot id.
│   │   └── <rest>.json     # Remaining 38 hex chars + ".json".
│   └── ...
├── refs/                   # Branch and tag pointers (text files).
│   ├── heads/<branch>      # Single snapshot id + "\n".
│   └── tags/<name>         # Single snapshot id + "\n".
├── transcripts/            # OPTIONAL. Per-session JSONL logs (for portability).
│   └── <session-id>.jsonl
└── hooks/                  # OPTIONAL. Local executable scripts (post-snapshot, etc.).
    └── post-snapshot
```

| Path | Format | Required? | Source of truth? |
|---|---|---|---|
| `HEAD` | text (UTF-8, LF) | yes | yes |
| `config` | TOML | yes | yes |
| `snapshots/<aa>/<rest>.json` | JSON (UTF-8) | yes (≥0 entries) | **yes** |
| `refs/heads/<branch>` | text | yes (≥0 files) | yes |
| `refs/tags/<name>` | text | optional (≥0 files) | yes |
| `lineage.sqlite` | SQLite 3 | yes | **no — derivable** |
| `transcripts/` | directory of JSONL | optional | yes (when present) |
| `hooks/` | directory of executables | optional | yes (when present) |

Hard rules:

- `snapshots/` is the source of truth. `lineage.sqlite` MUST be reconstructible
  from it via the `harness reindex` operation. Two implementations MUST produce
  byte-identical SQLite contents from the same snapshot set, given the same
  schema version, **except** for the `_meta` table (writer-stamped, see §5).
  Time-of-write data is stored in the snapshot blob, not derived.
- Snapshot ids are content-addressable (§3). Two snapshots with byte-identical
  canonical bytes MUST have identical ids.
- `HEAD`, `refs/heads/*`, `refs/tags/*` follow git's filename and content
  conventions for compatibility of mental model. Each ref file MUST contain a
  single snapshot id (40 lowercase hex chars) followed by a trailing LF.
- Symbolic refs are restricted: in v0.1, only `HEAD` MAY be symbolic. All other
  refs MUST be direct (a literal id).
- `config` is TOML, not YAML, not JSON. Rationale: small, line-oriented,
  comments survive round-trips, no significant whitespace.
- All on-disk paths MUST use forward-slash separators regardless of host OS.
- All text files (`HEAD`, refs, `config`) MUST be UTF-8 with LF line endings.

### 1.1 Capture scope: project-level only (v0.1)

A v0.1 snapshot captures **only** primitives defined under the project's
`<projectRoot>/.claude/` tree (plus `CLAUDE.md` / `AGENTS.md` at the project
root). User-level config — `~/.claude/skills/`, `~/.claude/agents/`,
`~/.claude/settings.json`, `~/.claude/CLAUDE.md`, etc. — is intentionally
**not** captured even when those primitives are active in the runtime that
fires the SessionStart hook.

Rationale: snapshots are designed to be shared across machines (team-sync
in v0.2). Including per-developer user-level config would contaminate every
shared snapshot with differences neither developer can change, defeating
the comparability goal. The blind spot is by design: if a primitive must
be reproducible on a different machine, it MUST live in the project's
`.claude/` (or be an APM dependency).

Implementations MUST NOT walk `~/.claude/` or any non-project path during
capture. Implementations MAY surface a one-time advisory note to the user
when an active user-level primitive (skill, hook, etc.) is observed but
not captured, but MUST NOT include it in the blob. User-level capture is
a v0.2 candidate gated on team-sync semantics being designed.

## 2. Snapshot blob format

A snapshot is a single JSON document at `snapshots/<aa>/<rest>.json`, where
the full id `<aa><rest>` is the lowercase 40-hex content-addressable hash
defined in §3.

The JSON Schema is normative: [schema/snapshot.schema.json](schema/snapshot.schema.json).
This section is informative explanation.

### 2.0 On-disk vs. canonical bytes

Two byte sequences are relevant:

- **On-disk JSON.** What is written to `<rest>.json`. Writers SHOULD pretty-print
  for human diffability (2-space indent is RECOMMENDED). On-disk formatting is
  not normative.
- **Canonical bytes.** The bytes hashed to derive `id`. See §3. Canonical bytes
  are normative and reproducible across implementations.

Round-trip rule: parsing `<rest>.json`, recanonicalizing, and rehashing MUST
yield the same `id` as the filename indicates. Any deviation indicates either
a corrupted blob or a writer that violates §3.

### 2.1 Required and optional fields

Required top-level fields:

| Field | Type | Notes |
|---|---|---|
| `id` | string (40-hex) | Filename derives from this. |
| `parentIds` | array of strings (40-hex) | 0=init, 1=normal, 2=merge (reserved). |
| `branch` | string | The branch the snapshot was created on. |
| `kind` | string enum | `init` \| `edit` \| `auto` \| `fork` \| `tag`. |
| `message` | string | One-line summary. Multi-line MAY appear; readers MUST handle it. |
| `codePin` | string (40-hex) or `null` | Git sha at snapshot time, or `null` if not in a git repo. |
| `createdAt` | string (ISO 8601 UTC, ms) | Pattern: `YYYY-MM-DDTHH:MM:SS.sssZ`. |
| `modules` | array of `Module` | See §2.4. |

Optional top-level fields:

| Field | Type | Notes |
|---|---|---|
| `formatVersion` | string | Default `"0.1"` if absent. See §9. |
| `version` | string \| `null` | REQUIRED on `kind:"tag"`; SHOULD be null otherwise. |
| `sessionId` | string \| `null` | Present on `kind:"auto"` (the SessionStart hook writes this). |
| `model` | string \| `null` | Model id reported by the host on SessionStart (e.g. `"claude-opus-4-7"`). Optional; pre-amendment snapshots and non-hook writers omit it. Pass-through; not normalized. |
| `permissionMode` | string \| `null` | Permission mode reported by the host on SessionStart (e.g. `"default"`, `"plan"`, `"acceptEdits"`). Optional; pre-amendment snapshots and non-hook writers omit it. Pass-through; not normalized. |
| `apmLockHash` | string \| `null` | `sha256:<64-hex>` of `apm.lock.yaml` bytes; see [apm-integration.md](apm-integration.md). |
| `author` | string \| `null` | Free-form (e.g. email or username). |

`model` and `permissionMode` are session-level context shipped in the
SessionStart hook stdin payload (see [hooks.md §1.1](hooks.md#11-channel-a--stdin-json-primary-claude-code-native)).
The hook writes them through to the blob unchanged. Both are optional —
older hosts, the CLI testing path, and writers other than the SessionStart
hook all leave them absent. A reader MUST tolerate either presence or
absence and MUST preserve them on round-trip per §9.2.

Unknown top-level fields MUST be preserved on round-trip per §9.

### 2.2 `kind`

| Value | Meaning |
|---|---|
| `init` | First snapshot of a harness. `parentIds` MUST be empty. |
| `edit` | Captured manual edit of the working tree. |
| `auto` | Auto-snapshot at session start (the hook's output). |
| `fork` | Snapshot that creates a new branch. `branch` is the new branch name. |
| `tag` | Promotion to a named version. `version` MUST be set. |

A `fork` snapshot has `parentIds.length == 1` (the parent is the snapshot it
forked from). What makes it a fork is the new branch ref pointing at it, not
a structural property of the snapshot. Readers MUST treat the kind as advisory
metadata for graph rendering, never as a substitute for ref/parent inspection.

### 2.3 `createdAt`, `codePin`, `apmLockHash`

- `createdAt` MUST be ISO 8601 UTC with millisecond precision and a literal `Z`
  timezone designator. Pattern: `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`.
  Rationale: lossless, lexicographically sortable, human-readable for diffs.
- `codePin` MUST be a 40-char lowercase-hex git sha when the project is a git
  repository, or `null` otherwise. Writers SHOULD NOT normalize a short sha;
  expand it via `git rev-parse` first.
- `apmLockHash` MUST be `sha256:` followed by the 64-char lowercase-hex sha-256
  of the bytes of `apm.lock.yaml` at snapshot time. Null when no lockfile is
  present. The lockfile location is configurable via `[apm].lockfile_path` in
  `config` (default: `apm.lock.yaml` at the project root).

### 2.4 The `Module` shape

Each `Module` object describes one captured primitive. The shape:

```json
{
  "type": "skill",
  "name": "research",
  "version": "v0.5",
  "enabled": true,
  "configHash": "sha256:abc123...",
  "source": { "kind": "local", "path": ".claude/skills/research/SKILL.md" }
}
```

Required fields per module: `type`, `name`, `source`. All other fields are
optional. `enabled` defaults to `true` if absent. `version` may be any
writer-defined string (semver-like is conventional but not required); `null`
means "no version assigned".

`configHash`, when present, MUST be `sha256:` followed by a 64-hex digest of
the bytes of the module's auxiliary configuration (e.g. the contents of the
matching block in `.claude/settings.json`, or the SKILL.md frontmatter for a
skill). The writer chooses what bytes to hash; readers MUST treat the value
as opaque except for equality comparison.

### 2.5 Module type vocabulary

The canonical enum, aligned with the
[Microsoft APM primitive types](https://microsoft.github.io/apm/reference/primitive-types/):

| Canonical type | Meaning | Aliases accepted on read |
|---|---|---|
| `chatmode` | Persona / system-prompt persona. | `persona` |
| `instruction` | Instruction blocks (`AGENTS.md`, `CLAUDE.md`). | — |
| `prompt` | Saved prompt or slash command. | `cmd`, `command` |
| `skill` | Agent skill (`SKILL.md`). | — |
| `agent` | Subagent definition. | `subagent` |
| `hook` | Lifecycle hook (`PreToolUse`, `SessionStart`, …). | — |
| `mcp` | MCP server. | `tool`, `server` |
| `style` | Output style (Claude-Code-specific). | — |

**Writers MUST emit canonical names.** **Readers MUST accept the listed aliases
and silently normalize them to canonical** when loading into memory. (This
parallels git's normalization of object header field aliases — readers tolerate
historical spellings; writers don't introduce new ones.)

Where the canonical set differs from APM, see
[apm-integration.md §Vocabulary alignment](apm-integration.md#vocabulary-alignment).

### 2.6 The `source` discriminator

`source` is a tagged union on `kind`. In v0.1, three variants are defined:

```ts
type ModuleSource =
  | { kind: "apm";     package: string; resolvedCommit: string; depth: number; resolvedBy?: string }
  | { kind: "local";   path: string }
  | { kind: "builtin" };
```

- **`apm`** — the module was installed by APM. Required: `package` (the APM
  package id, e.g. `microsoft/apm-sample-package`), `resolvedCommit` (40-char
  hex), `depth` (1 for direct deps, 2+ for transitive). Optional: `resolvedBy`
  (the parent package name, set when `depth >= 2`).
  See [apm-integration.md](apm-integration.md).

- **`local`** — the module was defined in the project's own files. Required:
  `path`, the repo-relative POSIX path to the file or directory. Forward
  slashes only; no leading `/`.

- **`builtin`** — built into the agent runtime (e.g. Claude Code's Read,
  Write, Bash). No other fields. Builtins are captured so the snapshot
  represents the full active toolset.

Forward-compat rule (§9): unknown `source.kind` values MUST be preserved
verbatim on round-trip and treated as opaque. Implementations SHOULD log a
warning naming the unknown kind. Writers MUST NOT introduce new kinds without
a spec amendment.

#### 2.6.1 Worked examples

**Local source.** The hook captured a module defined in the project's
`.claude/` tree:

```json
{
  "type": "skill",
  "name": "research",
  "version": "v0.4",
  "enabled": true,
  "source": { "kind": "local", "path": ".claude/skills/research/SKILL.md" }
}
```

Real instances live in [examples/solo-no-apm/.harness/snapshots/](examples/solo-no-apm/.harness/snapshots/).

**APM source (direct).** Pulled in by APM at depth 1:

```json
{
  "type": "skill",
  "name": "research",
  "version": "v1.6",
  "enabled": true,
  "source": {
    "kind": "apm",
    "package": "microsoft/apm-sample-package",
    "resolvedCommit": "a3f9c1ef2244c3e85d10b0a6b7d52f0911aabbcc",
    "depth": 1
  }
}
```

**APM source (transitive).** Pulled in by a dependency, depth 2:

```json
{
  "type": "skill",
  "name": "summarize",
  "version": "v0.2",
  "enabled": true,
  "source": {
    "kind": "apm",
    "package": "microsoft/common-utilities",
    "resolvedCommit": "bb22cc33dd44ee55ff66778899aabbccddeeff00",
    "depth": 2,
    "resolvedBy": "microsoft/apm-sample-package"
  }
}
```

**Builtin source.**

```json
{
  "type": "mcp",
  "name": "Read",
  "enabled": true,
  "source": { "kind": "builtin" }
}
```

All four variants appear in [examples/team-shared/.harness/snapshots/](examples/team-shared/.harness/snapshots/).

## 3. Snapshot ID derivation

The `id` field of a snapshot is content-addressable:

```
id = sha256(canonical_bytes(snapshot_for_hashing))[:40]
```

Where:

- `snapshot_for_hashing` is the snapshot JSON object **with the `id` field
  removed** (a structure cannot contain its own hash).
- `canonical_bytes(obj)` is the canonical JSON serialization defined below.
- The result of `sha256` is the 64-char lowercase hex digest. The first 40
  characters become `id`. Rationale: matches git's display length; collision
  resistance from sha256 is overkill but matches developer expectations.

### 3.1 Canonical JSON

The serialization `canonical_bytes` is a strict subset of
[RFC 8785 (JCS)](https://datatracker.ietf.org/doc/html/rfc8785) sufficient for
the snapshot domain:

1. **UTF-8.** Output is a UTF-8 byte sequence with no BOM.
2. **Sorted keys, recursive.** At every object depth, keys MUST be ordered
   ascending by their UTF-16 code-unit values (the same order as JavaScript's
   `Array.prototype.sort()` on the keys, and the order RFC 8785 §3.2.3 specifies).
3. **No whitespace.** No spaces or line breaks between or inside JSON tokens.
   Equivalent to JCS / `JSON.stringify(obj)` with no `space` argument.
4. **Strings.** RFC 8259 escaping, with non-ASCII characters emitted as raw
   UTF-8 bytes (no `\uXXXX` escapes for code points ≥ 0x20). Control characters
   < 0x20 MUST be `\uXXXX` escaped (lowercase hex). The short forms `\"`, `\\`,
   `\b`, `\f`, `\n`, `\r`, `\t` MUST be used where defined; `\/` MUST NOT be
   used (write `/` literally).
5. **Numbers.** Implementations SHOULD restrict snapshot blobs to JSON integers
   (the example writer in [scripts/build_examples.py](../scripts/build_examples.py)
   does so); no example field in this spec uses a non-integer number. If a
   writer needs floats, RFC 8785 §3.2.2.3 number canonicalization applies
   verbatim. NaN, +/-Infinity, and `-0` MUST NOT appear.
6. **Arrays preserve order.** Member order is significant.
7. **`null` is `null`.** Optional fields with the value `null` are emitted;
   absent fields are not. Writers SHOULD pick one and remain consistent within
   a single snapshot — the chosen form is part of the canonical bytes.

A conforming implementation MUST produce byte-identical canonical bytes for
inputs that differ only in whitespace, key order, or JSON formatting. The
test vector in §3.2 is the conformance touchstone.

### 3.2 Test vector

The following snapshot (with `id` omitted) hashes to the indicated value.
Implementations MUST reproduce the canonical bytes and the digest exactly.

**Input (snapshot blob with `id` omitted, shown pretty-printed for readability):**

```json
{
  "formatVersion": "0.1",
  "parentIds": ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  "branch": "main",
  "kind": "edit",
  "message": "+ postgres MCP",
  "codePin": "b22e80aa12cc34dd56ee78ff90aabbccddeeff00",
  "createdAt": "2026-04-29T18:20:00.000Z",
  "apmLockHash": null,
  "modules": [
    {
      "type": "chatmode",
      "name": "senior-eng",
      "enabled": true,
      "source": { "kind": "local", "path": ".claude/agents/senior-eng.md" }
    },
    {
      "type": "mcp",
      "name": "postgres",
      "version": "v0.9",
      "enabled": true,
      "source": { "kind": "local", "path": ".claude/settings.json" }
    }
  ]
}
```

**Canonical bytes (UTF-8, 501 bytes, exactly):**

```
{"apmLockHash":null,"branch":"main","codePin":"b22e80aa12cc34dd56ee78ff90aabbccddeeff00","createdAt":"2026-04-29T18:20:00.000Z","formatVersion":"0.1","kind":"edit","message":"+ postgres MCP","modules":[{"enabled":true,"name":"senior-eng","source":{"kind":"local","path":".claude/agents/senior-eng.md"},"type":"chatmode"},{"enabled":true,"name":"postgres","source":{"kind":"local","path":".claude/settings.json"},"type":"mcp","version":"v0.9"}],"parentIds":["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]}
```

**Full sha256:** `977d89c4deef44ae18ab764350d01a54357b84ec92d077de2a9a4531c1048e26`

**`id` (first 40 chars):** `977d89c4deef44ae18ab764350d01a54357b84ec`

The reference generator in [scripts/build_examples.py](../scripts/build_examples.py)
emits this vector at the end of its run. Implementations under test SHOULD
include this vector in their unit tests.

## 4. The DAG (parents, refs, HEAD)

### 4.1 Parents

`parentIds` is an ordered array.

| Length | Meaning |
|---|---|
| 0 | Init snapshot. `kind` MUST be `"init"`. |
| 1 | Normal / `auto` / `edit` / `fork` / `tag`. |
| 2 | Merge. **Reserved**; not produced in v0.1. **Readers MUST tolerate.** A reader-compat fixture lives at [`examples/compat-fixtures/`](examples/compat-fixtures/) — load that example and confirm the merge node renders correctly to verify conformance. |

Each parent id MUST identify a snapshot present in `snapshots/`. Writers MUST
NOT emit dangling parent ids. Readers MAY treat a missing parent as a fatal
error or as an opaque "unknown ancestry" marker, depending on use case
(rendering tools should prefer the latter; reproducers should prefer the former).

Cycles MUST NOT exist. Implementations MAY assume the DAG is acyclic and skip
loop detection — a cycle would imply two snapshots with mutually-referencing
ids, which violates content-addressability under sha256.

### 4.2 Refs

A branch ref is a file `refs/heads/<branch>` whose contents are exactly:

```
<snapshot-id>\n
```

(40 lowercase hex characters, then a single LF, no trailing whitespace.)

Tag refs follow the same format under `refs/tags/<name>`. v0.1 supports only
**lightweight refs** — no annotated tags, no reflog, no notes. The tag's
`message` and `version` live on the tagged snapshot itself.

A branch's tip MAY be any snapshot in the DAG, not necessarily a leaf. Tools
rendering the lineage MUST handle this (a branch may be "behind" a visible
descendant). The set of leaves in the DAG and the set of branch tips need
not coincide.

Branch and tag names MUST match the regex `^[A-Za-z0-9._/-]+$` and MUST NOT
contain `..` or end with `.lock`. (These constraints are a subset of git's
ref name rules; implementations MAY adopt the full git rules but MUST accept
the subset.)

### 4.3 `HEAD`

`HEAD` is one of two forms:

- **Symbolic** (on a branch):
  ```
  ref: refs/heads/<branch>\n
  ```
- **Detached** (after `harness checkout <id>`):
  ```
  <snapshot-id>\n
  ```

A reader determines which by checking whether the file's first non-whitespace
token is `ref:`. Symbolic refs are restricted to `HEAD` only in v0.1; refs
under `refs/` MUST be direct.

### 4.4 The empty repository

A `.harness/` immediately after `harness init`, before any snapshot has
been recorded, is in a well-defined "empty" state. The
[`examples/empty/`](examples/empty/) example is canonical:

| Path | Required state |
|---|---|
| `HEAD` | Symbolic ref pointing at the configured default branch, e.g. `ref: refs/heads/main\n`. MUST exist. |
| `config` | TOML with `[core].default_branch` and `[core].format_version`. MUST exist. |
| `snapshots/` | Empty directory. MUST exist. |
| `refs/heads/` | Empty directory. MUST exist. |
| `refs/heads/<default-branch>` | **MUST NOT exist.** The branch ref file is created on first commit, not at `harness init`. |
| `refs/tags/` | MAY be absent until the first tag. If present, MUST be empty. |
| `lineage.sqlite` | MAY be absent before first commit. If present, the schema MUST match [schema/001_init.sql](schema/001_init.sql) and all index tables MUST be empty. |

This means a fresh `HEAD` legally points at a branch ref that does not
yet exist on disk. This is the **born-ref** pattern, identical to the
state of a repo immediately after `git init`. Resolver semantics:

- Resolving `HEAD` to a snapshot id on an empty repository MUST return
  "no commit" (an explicit empty result, not an error). Implementations
  in typed languages SHOULD model this as `Option<SnapshotId>`,
  `SnapshotId | null`, or equivalent.
- Operations that require a current commit (e.g. `harness checkout`,
  `harness diff`) MAY fail on an empty repository with a clear
  "no commits yet" message. They MUST NOT fail with a generic
  "ref not found" or "file not found" error.
- Operations that do not require a current commit (e.g. `harness init`,
  the SessionStart hook on its first run) MUST succeed and proceed to
  write the first snapshot, creating `refs/heads/<default-branch>` as
  a side effect.

Writers performing the first commit on an empty repository MUST:

1. Write the snapshot blob atomically (per [hooks.md §3](hooks.md#3-atomic-write-protocol)).
2. Create `refs/heads/<default-branch>` containing the new id.
3. Leave `HEAD` unchanged — it remains the symbolic ref it was at init.

After step 2, the repository is no longer empty.

### 4.5 Worked DAG (from `examples/team-shared/`)

```
init      v0.3 (main)        56c54240b524f29b542551e7e20b42762dc215bf
  └── auto                   b01045525b6701fd2f08965be0fd21b67f1ed8f0
       └── tag v0.4 (main)   e6e76866ce636119129509a831acab5a2f70b2b5  ← refs/heads/main
            └── fork (exp)   d042d388476facc44f8f10acffc9fe006286e9ec
                 └── auto    07b0886ea7978ab50f0fc59fecb514c685cb310b  ← refs/heads/experimental
```

`refs/tags/v0.4` points at the same snapshot as the branch tip — that is the
defining relationship of a `tag` snapshot.

## 5. The SQLite index (`lineage.sqlite`)

The schema is defined in [schema/001_init.sql](schema/001_init.sql) and is
**canonical**: implementations MUST execute the statements exactly as written
when initializing or migrating. Paraphrasing the schema in code is non-conforming.

### 5.1 Tables

| Table | Purpose |
|---|---|
| `_schema` | Single row: schema version (currently `1`). |
| `_meta` | Writer-stamped metadata (`format_version`, `created_by`, …). Non-normative. |
| `snapshots` | One row per snapshot blob. `id` is the primary key. |
| `snapshot_parents` | Edges `(child_id, parent_id, parent_index)`. |
| `snapshot_modules` | One row per `(snapshot_id, position, module)`. |
| `sessions` | One row per recorded session (writer-defined `id`). |
| `session_usage` | Per-session per-module observed-use counts. |
| `tool_calls` | Optional fine-grained call log (writers MAY skip in v0.1). |

### 5.2 Reindex contract

The operation `harness reindex` MUST:

1. Drop the existing `lineage.sqlite` (or apply migrations from `_schema.version`).
2. Apply [schema/001_init.sql](schema/001_init.sql) verbatim.
3. Walk every file under `snapshots/`, parse the JSON, and insert
   corresponding rows into `snapshots`, `snapshot_parents`, and `snapshot_modules`.
4. Insert sessions and usage rows when transcripts or other observed data are
   available. Writers MAY skip this in v0.1; readers MUST tolerate empty
   sessions/usage tables.
5. Stamp `_meta` rows with `format_version`, `created_by`, `created_at`,
   and (for re-runs) `reindexed_at`.

Two implementations performing reindex over the same `snapshots/` and
session inputs MUST produce byte-identical SQLite contents at the same
schema version, **excluding** the `_meta` table (which is writer-stamped).
Implementations that need bytewise reproducibility for testing SHOULD apply
`VACUUM;` immediately after reindex; the spec does not require it.

### 5.3 Source-kind indexing

`snapshot_modules.source_kind` is constrained to `apm | local | builtin`
plus extension values starting with `x-` (per §9). Two indexed lookups
underpin Module-page queries:

- `idx_snapshot_modules_apm_origin` — find all snapshots that pulled
  package `microsoft/apm-sample-package` at commit `a3f9c1...`:
  ```sql
  SELECT DISTINCT snapshot_id FROM snapshot_modules
   WHERE source_kind = 'apm'
     AND source_package = 'microsoft/apm-sample-package'
     AND source_resolved_commit = 'a3f9c1ef2244c3e85d10b0a6b7d52f0911aabbcc';
  ```
- `idx_snapshot_modules_local_path` — find all snapshots affected by
  edits to a local file (e.g. `.claude/settings.json`).

## 6. APM interoperability (summary)

`.harness/` integrates with [Microsoft APM](https://microsoft.github.io/apm/)
when an `apm.lock.yaml` is present at the project root. The integration is
specified in full in **[apm-integration.md](apm-integration.md)**; the
requirements load-bearing for this document:

- The writer MUST detect `apm.lock.yaml` at snapshot time when
  `[apm].detect_lockfile = true` (§7).
- Modules whose on-disk file is listed in a lockfile entry's
  `deployed_files` MUST be recorded with `source: { kind: "apm", … }` (§2.6).
- The lockfile bytes MUST be hashed and stored at the top level of the
  snapshot blob as `apmLockHash` (§2.3).
- `kind: "apm"` modules are reproducible via APM tooling, not by extracting
  files from the snapshot. `kind: "local"` modules in v0.1 record only the
  path; reproduction is best-effort.

## 7. The `config` file

`.harness/config` is TOML. The JSON Schema for the parsed structure is
[schema/config.schema.json](schema/config.schema.json).

```toml
# .harness/config — TOML.

[core]
default_branch = "main"
format_version = "0.1"

[capture]
auto_snapshot_on_session = true   # SessionStart hook installs / reads this
include_transcripts      = false  # copy session JSONL into transcripts/
mask_paths               = []     # globs; redact matches from local source paths

[apm]
detect_lockfile = true
lockfile_path   = "apm.lock.yaml"

[gitignore]
policy = "private"
```

### 7.1 `[gitignore].policy`

Three values, each defining what under `.harness/` is committed to git when
the host project is a git repo. Writers SHOULD update the project's
`.gitignore` (or, equivalently, write `.harness/.gitignore`) to match.

| Value | Committed | Gitignored |
|---|---|---|
| `private` (default) | `config` (optional, MAY be ignored) | everything else under `.harness/` |
| `shared-snapshots` | `config`, `snapshots/`, `refs/`, `HEAD` | `lineage.sqlite`, `transcripts/`, `hooks/` |
| `shared-everything` | everything except generated/derivable files | `lineage.sqlite` (always), `transcripts/` if `[capture].include_transcripts = false` |

Rationale: `lineage.sqlite` is derivable (§5) and is excluded under all
policies to avoid merge conflicts. `transcripts/` may contain sensitive
content and is opt-in.

### 7.2 Defaults and absent files

A `.harness/config` MAY omit any section; defaults defined in
[schema/config.schema.json](schema/config.schema.json) apply. A missing
`.harness/config` is non-conforming — writers MUST create it during
`harness init`.

## 8. Hooks (summary)

The SessionStart hook contract is specified in
**[hooks.md](hooks.md)**. Load-bearing for this document: the hook produces
exactly one `auto`-kind snapshot blob per session start (idempotent on
duplicate fires), populates `sessionId` on the blob, and atomically updates
`lineage.sqlite`.

## 9. Compatibility & versioning

### 9.1 Spec versioning

This document is `0.1`. Snapshot blobs MAY include `formatVersion`. If
absent, treat as `"0.1"`.

| Reader sees | Reader behavior |
|---|---|
| Same major (0.x), same or older minor | MUST accept. |
| Same major (0.x), newer minor | SHOULD accept. MAY warn about unknown fields. |
| Different major (≥1.0 vs 0.x, etc.) | MUST refuse unless the reader implements that major. |

### 9.2 Forward-compat: unknown fields and variants

- Unknown **top-level** fields in snapshot blobs MUST be preserved on
  read/write (round-trip safety). Readers MUST NOT silently drop them when
  rewriting.
- Unknown **`source.kind`** values MUST be preserved verbatim. Readers
  SHOULD treat them as opaque (unable to participate in `apm reproduce`,
  `git diff`, etc.) and SHOULD log a warning naming the unknown kind.
  Writers MUST NOT introduce new kinds without a spec amendment; private
  experiments SHOULD use `x-`-prefixed kinds (e.g. `x-experimental-bundle`)
  to make the namespace explicit. A worked example with one such module
  is in [`examples/compat-fixtures/`](examples/compat-fixtures/) — load it
  and confirm the unknown-kind module survives a read/write round-trip
  unchanged to verify conformance with this rule.
- The `_schema.version` integer is the SQLite schema version. Mismatches
  between an existing `lineage.sqlite` and the implementation's known
  version trigger reindex (drop and rebuild from `snapshots/`).

### 9.3 What v0.2 is expected to add

Non-normative; recorded for orientation only.

- Storing local-source module file content inside the snapshot blob (or as
  side-blobs) so `kind: "local"` reproduction is byte-exact.
- Annotated tags and a reflog.
- Multi-machine sync semantics (push/pull, conflict resolution beyond ref
  fast-forward).
- Float canonicalization tightening, if real-world snapshots demand it.

These items are explicitly out of scope for v0.1. Writers SHOULD NOT depend
on them; readers MUST NOT assume they exist.
