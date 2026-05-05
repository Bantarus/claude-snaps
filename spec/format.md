# `.harness/` — Agent harness lineage format

> **Status:** Working Draft v0.4.0 — unstable, may change without notice until v1.0.
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
- Symbolic refs are restricted: in v0.3, only `HEAD` MAY be symbolic. All other
  refs MUST be direct (a literal id).
- `config` is TOML, not YAML, not JSON. Rationale: small, line-oriented,
  comments survive round-trips, no significant whitespace.
- All on-disk paths MUST use forward-slash separators regardless of host OS.
- All text files (`HEAD`, refs, `config`) MUST be UTF-8 with LF line endings.

### 1.1 Capture scope: project-level only (v0.3)

A v0.3 snapshot captures **only** primitives defined under the project's
`<projectRoot>/.claude/` tree (plus `CLAUDE.md` / `AGENTS.md` at the project
root). User-level config — `~/.claude/skills/`, `~/.claude/agents/`,
`~/.claude/settings.json`, `~/.claude/CLAUDE.md`, etc. — is intentionally
**not** captured even when those primitives are active in the runtime that
fires the hook.

Rationale: snapshots are designed to be shared across machines (team-sync
is a v0.4 candidate). Including per-developer user-level config would
contaminate every shared snapshot with differences neither developer can
change, defeating the comparability goal. The blind spot is by design:
if a primitive must be reproducible on a different machine, it MUST live
in the project's `.claude/` (or be an APM dependency).

Implementations MUST NOT walk `~/.claude/` or any non-project path during
capture. Implementations MAY surface a one-time advisory note to the user
when an active user-level primitive (skill, hook, etc.) is observed but
not captured, but MUST NOT include it in the blob. User-level capture is
a v0.4 candidate gated on team-sync semantics being designed.

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
| `kind` | string enum | `init` \| `auto`. See §2.2. |
| `codePin` | string (40-hex) or `null` | Git sha at snapshot time, or `null` if not in a git repo. |
| `createdAt` | string (ISO 8601 UTC, ms) | Pattern: `YYYY-MM-DDTHH:MM:SS.sssZ`. |
| `modules` | array of `Module` | See §2.4. |

Optional top-level fields:

| Field | Type | Notes |
|---|---|---|
| `formatVersion` | string | Default `"0.3"` if absent. See §9. |
| `model` | string \| `null` | Model id reported by the host on SessionStart / UserPromptSubmit (e.g. `"claude-opus-4-7"`). Optional; pre-amendment snapshots and non-hook writers omit it. Pass-through; not normalized. |
| `permissionMode` | string \| `null` | Permission mode reported by the host on SessionStart / UserPromptSubmit (e.g. `"default"`, `"plan"`, `"acceptEdits"`). Optional; pre-amendment snapshots and non-hook writers omit it. Pass-through; not normalized. |
| `apmLockHash` | string \| `null` | `sha256:<64-hex>` of `apm.lock.yaml` bytes; see [apm-integration.md](apm-integration.md). |
| `apmLockfile` | string \| `null` | Full text content of `apm.lock.yaml` at capture time. Null when no lockfile. Captured to enable self-contained reproduction (§6.1) without requiring the user's project to be at the snapshot's `codePin`. Added v0.4.0. |
| `author` | string \| `null` | Free-form (e.g. email or username). |

`model` and `permissionMode` are session-level context shipped in the
hook stdin payload (see [hooks.md §1.1](hooks.md#11-channel-a--stdin-json-primary-claude-code-native)).
The hook writes them through to the blob unchanged. Both are optional —
older hosts, the CLI testing path, and writers other than the hook all
leave them absent. A reader MUST tolerate either presence or absence and
MUST preserve them on round-trip per §9.2.

**Removed in v0.2.0:** `sessionId`. Snapshots are now session-independent
— the same harness composition observed by two different sessions yields
the same snapshot id. Session attribution is recorded separately in
**Attribution events** (§2.7), stored in `lineage.sqlite` only.

**Removed in v0.3.0:** `message`. Snapshots no longer carry free-form
text. User annotations are first-class **attribution events** (`note`
kind, see §2.7); display strings rendered by tools (e.g. the per-row
diff summary in `harness log`) are computed from `(parentIds[0],
modules)` at read time, never stored. The format stays small; UX
surfaces evolve independently. There is no automated migration from
v0.2.x — see §9.6.

**Added in v0.4.0:** `apmLockfile`. Carries the verbatim text of
`apm.lock.yaml` at capture time so the reproducer (§6.1) can run
`apm install --frozen` against the recorded lockfile without depending
on the project's git state. The pre-existing `apmLockHash` is retained
as the cheap equality probe used by composition-change detection
(§2.7) — when both fields are set, `apmLockHash` MUST equal
`sha256:` + sha-256 of `apmLockfile` bytes. Both participate in
canonical bytes (§3.1); a snapshot with a different `apmLockfile`
content is a different snapshot. v0.3.x snapshots are read-compatible
with `apmLockfile` absent (treated as `null`).

**Removed in v0.3.1:** `version` and the `tag` value of `kind`.
Snapshots represent composition observations, period; promotion
events ("v0.4 is the version we're shipping") are recorded in
`refs/tags/<name>` (lightweight refs, see §4.2), not as snapshots
with a special kind and a version string. The `version` field's only
purpose was annotating tag-kind snapshots, so it goes with them. v0.3.0
was a brief draft state where §2.2 (tag as kind) and §4.2 (tags as
lightweight refs) disagreed; v0.3.1 resolves toward §4.2 — see §9.7.

Unknown top-level fields MUST be preserved on round-trip per §9.

### 2.2 `kind`

| Value | Meaning |
|---|---|
| `init` | First snapshot of a harness. `parentIds` MUST be empty. |
| `auto` | Any composition-change capture. Covers hook-driven captures (SessionStart / UserPromptSubmit observed a new composition) and CLI captures (`harness snap`). |

Snapshots represent **composition observations**, period. Events that
*promote* (a tag is applied), *reference* (a branch is created), or
*annotate* (a user attached a note) compositions are recorded
elsewhere — `refs/tags/`, `refs/heads/`, and the `attributions` table
respectively (§4, §2.7). Adding more snapshot kinds for these events
would make snapshots mean things beyond their composition; v0.3.1 is
deliberate that snapshots stay content-addressable observations and
nothing more.

What makes a snapshot a "fork" (in the v0.1.x sense) is the new branch ref
pointing at it, not a structural property of the snapshot. Readers MUST
inspect refs and `parentIds` to understand DAG topology; `kind` is advisory
metadata only.

**Renamed in v0.3.0:** `manual` → `auto`. The v0.2.0 vocabulary singled
out CLI captures with the `manual` label, but a hook-driven capture and
a `harness snap` produce structurally identical snapshots; the `manual`
name suggested a meaningful distinction that did not exist. The `auto`
name reflects what the kind actually means: "the writer captured
composition automatically; the snapshot's identity is its content."
Pre-v0.3.0 blobs with `kind: "manual"` are not auto-migrated (§9.6); a
v0.3.0 reader treats them as a major-version mismatch per §9.1.

**Removed in v0.3.1:** `tag` kind. Tags are lightweight refs only
(§4.2); a tag is `refs/tags/<name>` containing the id of an existing
snapshot. No new snapshot is written when a tag is applied. v0.3.0
briefly listed `tag` as a kind with a required `version` field; the
field and the kind are both gone in v0.3.1 — see §9.7.

**Removed in v0.2.0:** `edit`, `auto`, `fork` (the v0.1.x kinds). All
collapsed to `manual` in v0.2.0 and now collapse to `auto` in v0.3.0.

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

`source` is a tagged union on `kind`. In v0.3, three variants are defined:

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

### 2.7 Attribution events

A snapshot records *what the harness composition was*, independent of who
observed it and independent of any free-form annotation. Sessions are
recorded as **attribution events**: append-only rows linking a
`(sessionId, snapshotId, observedAt, eventKind)` tuple, optionally
carrying a `noteText`. A session that traverses three distinct
compositions over its lifetime produces three attribution rows pointing
at three snapshots. A session that fires the hook 30 times against an
unchanged composition produces 30 attribution rows pointing at *one*
snapshot. A user who runs `harness snap "<note>"` against an unchanged
composition produces a `note` attribution row pointing at the existing
snapshot — no new blob, no ref advance.

Attribution events live exclusively in `lineage.sqlite`; they have no
on-disk blob form and are not content-addressable. Their schema is
defined by [schema/001_init.sql](schema/001_init.sql) (the `attributions`
table, added in migration `002_v0_2_decoupling.sql` and extended with
`note_text` in `004_v0_3_notes.sql` — see §5.4).

**Event kinds.** The `eventKind` column takes one of these values:

| Value | Meaning | `noteText` |
|---|---|---|
| `session_start` | Recorded when the SessionStart hook fired. The `source` column carries `startup` / `resume` / `clear` / `compact` from the hook stdin payload. | MUST be null. |
| `user_prompt` | Recorded when the UserPromptSubmit hook fired. The dominant event kind in normal use. | MUST be null. |
| `manual_capture` | Recorded when a writer captured composition without an annotation. Reserved for non-CLI writers (e.g. an IDE plugin's "snapshot now" button). The CLI's `harness snap` always carries a note (see `note` below); there is no anonymous CLI capture path. | MUST be null. |
| `note` | Recorded when the user attached an annotation to a snapshot via `harness snap "<text>"`. The `sessionId` is the literal string `"<manual>"` to distinguish from runtime sessions. If composition changed since the previous fire, a new snapshot is written first; the `note` row references whichever snapshot (existing or new) carries the current composition. | MUST be non-null. |
| `migrated` | Reserved for backfill events written by migration tooling. Not emitted by any v0.3 writer; readers MUST tolerate the value for forward/backward compatibility. | MUST be null. |

The `noteText` invariant — non-null iff `eventKind = 'note'` — MUST be
enforced both by the SQL CHECK constraint (`004_v0_3_notes.sql`) and at
write time in the writer. Defense in depth: a code path that constructs
an event with the wrong shape fails fast in TypeScript before reaching
SQL; a corrupted database that ever gets a misshapen row is rejected by
the CHECK on next write.

Forward-compat rule: unknown `eventKind` values MUST be preserved on
read/write. Readers SHOULD log a warning naming the unknown kind. New
event kinds (e.g. `pre_compact`, `session_end`) MUST go through a spec
amendment.

**Source field.** For `session_start` events, attribution rows MAY
record the trigger source (`startup` / `resume` / `clear` / `compact`)
copied from the SessionStart hook stdin payload's `source` field. For
other event kinds, `source` is null.

**Composition-change detection.** When the hook fires, the writer:

1. Computes the snapshot id the current composition *would* have, by
   walking `.claude/` and canonicalizing per §3.
2. Looks up that id in the `snapshots` table.
3. If found: appends one attribution row pointing at the existing id.
   No new snapshot blob is written; no ref is advanced.
4. If not: writes the new snapshot blob (with `parentIds` = `[<current
   branch tip>]`), advances the branch ref, then appends the attribution
   row pointing at the new id.

`harness snap "<text>"` follows the same path, then unconditionally
appends a `note` attribution carrying the user's text. If composition
was unchanged, the only on-disk effect is that one extra attribution
row; if composition changed, both the new snapshot blob and a `note`
row land in one transaction.

This is the load-bearing mechanism: snapshots accumulate only on
composition change; attribution events accumulate on every hook fire
and every user note. The two load-bearing queries (§5.4) are:

- **Trajectory** — `WHERE session_id = ? ORDER BY observed_at`.
  Returns the ordered series of `(snapshot, when, kind, note)` events.
- **Cross-session notes** — `WHERE event_kind = 'note' AND snapshot_id = ?
  ORDER BY observed_at`. Returns every annotation ever attached to a
  snapshot, regardless of which session attached it.

## 3. Snapshot ID derivation

The `id` field of a snapshot is content-addressable:

```
id = sha256(canonical_bytes(snapshot_for_hashing))[:40]
```

Where:

- `snapshot_for_hashing` is the snapshot JSON object with **the fields
  enumerated in §3.1 removed** before serialization.
- `canonical_bytes(obj)` is the canonical JSON serialization defined in §3.2.
- The result of `sha256` is the 64-char lowercase hex digest. The first 40
  characters become `id`. Rationale: matches git's display length; collision
  resistance from sha256 is overkill but matches developer expectations.

### 3.1 Excluded fields

The following snapshot fields are deliberately excluded from canonical
bytes (i.e. removed from `snapshot_for_hashing` before serialization):

| Field | Reason |
|---|---|
| `id` | Recursion — the field being computed. |
| `createdAt` | Observation timestamp; varies per observation of the same harness. |
| `codePin` | Project's git sha at observation time; varies independently of harness composition. |
| `model` | Claude Code invocation context; not part of the captured `.claude/` state. |
| `permissionMode` | Claude Code invocation context; not part of the captured `.claude/` state. |

All other fields participate in canonical bytes derivation, including:

- `modules` — obviously.
- `kind`, `parentIds`, `branch` — structural identity in the DAG. Two
  observations of identical modules on different branches (or with
  different parents) produce different snapshots: the trajectory query
  in §2.7 needs to distinguish them, since reproducing each requires
  checking out different lineage. Stripping these would collapse the
  DAG into a content graph — a weaker structure than what the spec
  describes.
- `apmLockHash` — structural despite being a hash itself. APM-source
  modules' identities depend on the lockfile bytes; two snapshots with
  the same `modules` array but different `apmLockHash` mean a module's
  resolved commit changed under the same path. Deduping them would be
  wrong.
- `apmLockfile` — structural for the same reason as `apmLockHash`,
  and additionally because the reproducer (§6.1) reconstructs APM-source
  modules from this exact byte content. A snapshot whose `apmLockfile`
  differed from another's would resolve to a different APM dependency
  set on reproduction; treating them as the same snapshot would be a
  reproducibility bug.
- `formatVersion`, `author` — additive metadata; preserved on
  round-trip per §9.2 and participate in identity.

There is no `message` field in v0.3.0 (§2.1, §2.7). Snapshots have no
free-form text; user annotations are attribution events.

The dedup rule that emerges: **same `(modules, kind, parentIds, branch,
apmLockHash, formatVersion, author)` produces the same snapshot id**.
Two `observe()` calls (§2.7) against an unchanged composition therefore
append attribution events referencing the existing snapshot, never write
a new blob, and never advance any ref. A `harness snap "<note>"` against
an unchanged composition appends a `note` attribution row referencing
the existing snapshot — same outcome on the snapshot table, plus one
annotation row.

### 3.2 Canonical JSON

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
test vector in §3.3 is the conformance touchstone.

### 3.3 Test vector

The following snapshot (with the §3.1 excluded fields stripped) hashes
to the indicated value. Implementations MUST reproduce the canonical
bytes and the digest exactly.

**Input (snapshot blob with `id` omitted, shown pretty-printed for readability):**

```json
{
  "formatVersion": "0.3",
  "parentIds": ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  "branch": "main",
  "kind": "auto",
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

**Canonical bytes (UTF-8, 382 bytes, exactly).** Note: `createdAt` and
`codePin` from the input above are absent here — they are stripped per
§3.1.

```
{"apmLockHash":null,"branch":"main","formatVersion":"0.3","kind":"auto","modules":[{"enabled":true,"name":"senior-eng","source":{"kind":"local","path":".claude/agents/senior-eng.md"},"type":"chatmode"},{"enabled":true,"name":"postgres","source":{"kind":"local","path":".claude/settings.json"},"type":"mcp","version":"v0.9"}],"parentIds":["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]}
```

**Full sha256:** `da5289e572c0fe42e6dcda250a6d392543302965325c56a31f9fce9c4d740412`

**`id` (first 40 chars):** `da5289e572c0fe42e6dcda250a6d392543302965`

The fixture filename `canonical-501.bin` is historical (the v0.1.x
fixture was 501 bytes); the v0.3.0 fixture under that filename is 382
bytes after the §3.1 strip and the v0.3 removal of the `message` field.
See [spec/test-vectors/README.md](test-vectors/README.md) for the
preserved v0.1.1 and v0.2.0 fixtures (`canonical-501-v0_1_1.bin` and
`canonical-501-v0_2_0.bin`) kept as breadcrumbs of the canonical-bytes
evolution.

The reference generator in [scripts/build_examples.py](../scripts/build_examples.py)
emits this vector at the end of its run. Implementations under test SHOULD
include this vector in their unit tests.

## 4. The DAG (parents, refs, HEAD)

### 4.1 Parents

`parentIds` is an ordered array.

| Length | Meaning |
|---|---|
| 0 | Init snapshot. `kind` MUST be `"init"`. |
| 1 | Normal `auto` snapshot. The single parent is the previous tip of the snapshot's branch. |
| 2 | Merge. **Reserved**; not produced in v0.3. **Readers MUST tolerate.** A reader-compat fixture lives at [`examples/compat-fixtures/`](examples/compat-fixtures/) — load that example and confirm the merge node renders correctly to verify conformance. |

Branch tips advance on new snapshots; they do **not** advance on
attribution events. A session that fires the hook 30 times against an
unchanged composition produces 30 attribution rows but zero new
snapshots and zero ref updates.

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

Tag refs follow the same format under `refs/tags/<name>`. **Tags are
lightweight refs** — a tag is just a name in `refs/tags/` containing
the id of an existing snapshot. Applying a tag does NOT write a new
snapshot (no "tag-kind" snapshot exists in v0.3.1; see §2.2). This is
normative, not a v0.3 limitation: snapshots represent compositions and
tags are pointers, by design. Free-form text associated with a tag is
captured as a `note` attribution event (§2.7) attached to the tagged
snapshot. Any future "annotated tags" mechanism (a v0.4+ design
discussion) would introduce a separate artifact alongside refs, NOT a
new snapshot kind — see §9.4.

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
token is `ref:`. Symbolic refs are restricted to `HEAD` only in v0.3; refs
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
init                          <id1>  ← refs/heads/main, refs/tags/v0.3
  └── auto                    <id2>  ← refs/tags/v0.4 (no new snapshot for the tag)
       └── auto (experimental) <id3>
            └── auto           <id4>  ← refs/heads/experimental
```

`refs/tags/v0.4` points directly at `<id2>` — applying the tag did
NOT write a new snapshot (§4.2; no tag-kind in v0.3.1). `refs/heads/main`
also points at `<id2>`. The fork onto `experimental` is a plain `auto`
snapshot whose new branch ref is what makes it a fork; see §2.2 on why
`kind` does not encode "fork."

### 4.6 Session attribution and the SessionStart firing on resume

In v0.1.x the SessionStart hook was the only writer, so a session's
"snapshot" was implicit: the snapshot whose `sessionId` field matched.
The early v0.1.x soak appeared to show a **resume gap** — resumed
sessions producing no observable artifact — but later instrumentation
revealed the host (Claude Code) DOES fire `SessionStart` on resume,
with `source: "resume"`. The audit recipe in v0.1 was undercounting
because it matched a JSONL attachment shape that fires only on fresh
SessionStart events. The data model gap was real; the firing gap was a
measurement bug.

v0.2.0 (attribution events §2.7) and dual-event capture
([hooks.md §1.1](hooks.md#11-channel-a--stdin-json-primary-claude-code-native))
close the data-model gap; v0.3 reaffirms what the host actually does:

- `SessionStart` fires on every host-level session-start event,
  including `startup`, `resume`, `clear`, `compact`. Each records a
  `session_start` attribution event with the corresponding `source`.
- `UserPromptSubmit` fires on every user prompt, fresh or resumed.

A session may therefore produce **multiple `session_start` attribution
events** with different `source` values over its lifetime. Tools
rendering session timelines:

- MUST handle multiple `session_start` rows per session_id gracefully,
  ordered by `observed_at`.
- MUST NOT assume a session's first attribution is `session_start`
  (host-level filtering or hook installation timing can still leave
  some sessions starting from a `user_prompt`).
- SHOULD render a session's timeline starting from whichever of its
  attributions has the earliest `observed_at`, regardless of kind.

A session's earliest attribution timestamp answers "when did we first
observe this session," not "when did the session begin in the host
runtime." Those usually coincide; they may diverge if the hook was
installed mid-session.

## 5. The SQLite index (`lineage.sqlite`)

The schema is defined in [schema/001_init.sql](schema/001_init.sql) and is
**canonical**: implementations MUST execute the statements exactly as written
when initializing or migrating. Paraphrasing the schema in code is non-conforming.

### 5.1 Tables

| Table | Purpose |
|---|---|
| `_schema` | Single row: schema version (currently `5`). |
| `_meta` | Writer-stamped metadata (`format_version`, `created_by`, …). Non-normative. |
| `snapshots` | One row per snapshot blob. `id` is the primary key. **No `session_id` column** (dropped in v0.2.0); **no `message` column** (dropped in v0.3.0 by `004_v0_3_notes.sql`); **no `version` column** (dropped in v0.3.1 by `005_drop_tag_kind.sql`). |
| `snapshot_parents` | Edges `(child_id, parent_id, parent_index)`. |
| `snapshot_modules` | One row per `(snapshot_id, position, module)`. |
| `attributions` | One row per `(sessionId, snapshotId, observedAt, eventKind)` event. Carries optional `note_text` (v0.3.0). See §5.4. |
| `sessions` | One row per recorded session (writer-defined `id`). |
| `session_usage` | Per-session per-module observed-use counts. |
| `tool_calls` | Optional fine-grained call log (writers MAY skip in v0.3). |

### 5.2 Reindex contract

The operation `harness reindex` MUST:

1. Drop the existing `lineage.sqlite` (or apply migrations from `_schema.version`).
2. Apply [schema/001_init.sql](schema/001_init.sql) verbatim.
3. Walk every file under `snapshots/`, parse the JSON, and insert
   corresponding rows into `snapshots`, `snapshot_parents`, and `snapshot_modules`.
4. Insert sessions and usage rows when transcripts or other observed data are
   available. Writers MAY skip this in v0.3; readers MUST tolerate empty
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

### 5.4 Attribution semantics

The `attributions` table is the load-bearing structure for session
trajectory queries. Conforming implementations MUST honor:

- **Append-only.** Attributions are never updated or deleted in normal
  operation. Migration tooling MAY rewrite them; no other path SHOULD.
- **Composite primary key** = `(session_id, observed_at, event_kind)`.
  This permits multiple events at the same instant disambiguated by
  kind (e.g. a hook fire that coincides with a `note`).
- **`event_kind` enum.** The CHECK constraint enumerates `'session_start'`,
  `'user_prompt'`, `'manual_capture'`, `'note'`, `'migrated'`.
  Forward-compat per §9.2 applies to unknown values: readers preserve
  them, but adding a new kind requires a spec amendment.
- **`source` column.** Free-form text or null. Conventionally one of
  `'startup'` / `'resume'` / `'clear'` / `'compact'` for `session_start`
  events; null otherwise. Reader tools SHOULD treat unrecognized
  `source` strings as opaque.
- **`note_text` column.** Non-null iff `event_kind = 'note'`. The SQL
  CHECK constraint enforces this exactly: `(event_kind = 'note' AND
  note_text IS NOT NULL) OR (event_kind != 'note' AND note_text IS
  NULL)`. Writers MUST also enforce the invariant in code so a malformed
  event fails before reaching SQL. The text is verbatim user input;
  multi-line MAY appear; readers MUST handle it.
- **Foreign key** `snapshot_id REFERENCES snapshots(id)` — an
  attribution always points at a real snapshot. Migration tooling that
  rewrites snapshot ids MUST update attribution rows in the same
  transaction.

The three load-bearing queries:

```sql
-- Trajectory (Q1): ordered events for one session, with notes inline
SELECT snapshot_id, observed_at, event_kind, source, note_text
  FROM attributions
 WHERE session_id = ?
 ORDER BY observed_at;

-- Cross-session notes (Q2): every note ever attached to a snapshot
SELECT session_id, observed_at, note_text
  FROM attributions
 WHERE event_kind = 'note' AND snapshot_id = ?
 ORDER BY observed_at;

-- Inverse session lookup: which sessions observed this snapshot
SELECT session_id, MIN(observed_at) AS first_seen, MAX(observed_at) AS last_seen
  FROM attributions
 WHERE snapshot_id = ?
 GROUP BY session_id;
```

All three are O(log n) given the indexes in `001_init.sql` /
`002_v0_2_decoupling.sql` (Q1 covered by `idx_attributions_session`;
Q2 and the inverse covered by `idx_attributions_snapshot`).

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
  files from the snapshot. `kind: "local"` modules record only the path;
  the reproducer (§6.1) reports them and does not materialize their
  content. (Storing local-source content is deferred — §9.4.)

### 6.1 Reproducer contract (v0.4.0)

The `harness reproduce <ref>` command materializes a snapshot's
harness composition into the working `.claude/` directory.
Reproduction is **APM-driven**: APM is a hard prerequisite for
reproducer content. Projects without an `apm.lock.yaml` at capture
time produce snapshots whose reproducer is a no-op for content
(builtins are still verified, local-source modules are still reported).

**Materialized:**

- **APM-managed modules** (`source.kind = "apm"`). The reproducer writes
  the snapshot's recorded `apmLockfile` content into the project's
  `apm.lock.yaml` (backing up any existing file as
  `apm.lock.yaml.harness-backup`) and invokes APM in lockfile-honoring
  install mode. With APM 0.8.x this is `apm install --force` —
  `apm install` without `--update` already reuses locked commits, and
  `--force` is needed because the reproducer typically overwrites a
  drifted `.claude/`. After install, the reproducer recomputes
  `configHash` for each APM-source module against the deployed file at
  its `deployed_files`-mapped path and verifies equality with the
  value recorded on the module.
- **Builtin modules** (`source.kind = "builtin"`). The reproducer
  verifies that each is present in the host's known-builtin set. No
  filesystem write — builtins are runtime-defined.

**Reported but not materialized:**

- **Local-source modules** (`source.kind = "local"`). The reproducer
  prints the list of local-source modules with their recorded
  `configHash` and source path. The contract is honest: v0.4.0
  snapshots do not store local-source content; the reproducer cannot
  recreate it. Users who want full reproducibility on a local module
  promote it to APM. Storing local-source content (option (d) in
  prompt v0.4.0's pre-thoughts) is a deferred decision; see §9.4.

**Subtractive within scope (v0.4.1).** Reproduction is subtractive
within its scope. APM-managed paths and builtin verifications
recorded in the snapshot are materialized exactly. APM-managed paths
not recorded in the target snapshot but present in the working
`.claude/` are removed before HEAD advances. The project's
`apm.lock.yaml` is restored to match the snapshot's recorded
`apmLockfile` (written if non-null; removed if the snapshot recorded
no APM state). Local-source paths are not touched. The unconditional
backup is the recovery path; users wishing to merge state across
snapshots do so manually from the backup.

Rationale: reproduction's value depends on the working tree post-
reproduce being byte-equivalent (modulo local-source) to a fresh
capture of the target snapshot. An additive-only reproducer leaves
files from the prior state behind and silently breaks that
equivalence — a subsequent `harness diff HEAD` against working state
would show extras and the user has to disambiguate "drift since
reproduce" from "leftover the reproducer didn't clean." The
unconditional backup, not the absence of deletion, is the safety
mechanism.

**Side effects:**

- `.claude/` is backed up to `.claude.harness-backup-<ISO timestamp>/`
  before any write. The backup is unconditional (no `--no-backup`
  flag) and not auto-deleted. Manual restoration is `mv` of the backup
  back over `.claude/`. The backup path is printed on every invocation,
  including dry-run.
- APM's lockfile-honoring install (`apm install --force`) writes
  APM-managed files into `.claude/` (subject to APM's own deployment
  rules) when the snapshot's `apmLockfile` is non-null.
- `.harness/HEAD` advances to the reproduced snapshot id on success
  (whether the snapshot is a branch tip or a detached id). The
  reproducer does not rewrite branch refs.

**Failure modes:**

| Failure | Behavior |
|---|---|
| Snapshot's `apmLockfile` is null (no APM at capture, or v0.3.x snapshot) | Reproducer skips the APM phase; verifies builtins; reports local-source; advances HEAD. Prints a notice that APM-driven reproduction was skipped (no APM lockfile recorded). |
| `apm install` exits non-zero (network failure, missing package, version conflict, deleted upstream commit) | Reproducer aborts BEFORE advancing HEAD. Backup retained. APM stderr surfaced with the backup path. |
| APM module verification fails (installed but `configHash` mismatch) | Reproducer aborts BEFORE advancing HEAD. Backup retained. The mismatched modules are listed with expected vs. actual `configHash`. |
| Builtin missing from host (rare; e.g. snapshot taken on a host with extra builtins) | Reported but does not abort — builtins are advisory metadata, not load-bearing for reproduction. |
| `apm` binary not found on PATH | Reproducer aborts BEFORE backup. Clear error: `harness: apm not found on PATH; install APM (https://github.com/microsoft/apm) to use harness reproduce`. |

**`codePin` handling:** The reproducer does NOT check or modify the
user's project git state. `codePin` is preserved on the snapshot as
alignment metadata; users who want to align project git state to a
snapshot's `codePin` do so via `git checkout <codePin>` independently.

**Atomicity boundary:** If the APM phase fails partway, the user's
`.claude/` may be in a partial state (some modules deployed, some
not). The reproducer does not auto-restore — the backup is the
recovery mechanism. This is deliberate: a partially-deployed install
is not necessarily wrong (the user may want to inspect it), and an
auto-rollback would itself need a recovery path.

**Dry-run:** `harness reproduce <ref> --dry-run` performs all reads
(loading the snapshot, parsing the lockfile, listing planned actions)
without side effects. `.claude/`, `apm.lock.yaml`, HEAD, and APM's
`apm_modules/` are unchanged. The dry-run output describes what
would happen.

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

The hook contract is specified in **[hooks.md](hooks.md)**. Load-bearing
for this document: the hook fires on **two** events — `SessionStart`
(every host-level session-start, including resume/clear/compact) and
`UserPromptSubmit` (every user prompt) — and on each fire either writes
a new `auto`-kind snapshot blob (when composition changed) or appends
an attribution event to an existing snapshot (when composition is
unchanged). Both paths are idempotent on the composite key `(session_id,
observed_at, event_kind)` and atomically update `lineage.sqlite`.

## 9. Compatibility & versioning

### 9.1 Spec versioning

This document is `0.4.0`. Snapshot blobs MAY include `formatVersion`. If
absent, treat as `"0.4"` (the MAJOR.MINOR family).

| Reader sees | Reader behavior |
|---|---|
| Same major (0.x), same or older minor | MUST accept. |
| Same major (0.x), newer minor | SHOULD accept. MAY warn about unknown fields. |
| Different major (≥1.0 vs 0.x, vs 0.3 etc.) | MUST refuse unless the reader implements that major. |

The 0.1 → 0.2 transition was a major bump (`sessionId` removed; `kind`
enum reshaped). The 0.2 → 0.3 transition was also a major bump:
`message` removed; `kind` enum renamed `manual` → `auto`. v0.2.x readers
MUST refuse v0.3.x blobs and vice versa. Migration from v0.1.x → v0.2.0
is described in §9.5; there is **no automated migration** from v0.2.x →
v0.3.0 — see §9.6.

The 0.3.0 → 0.3.1 transition is documented as a **patch bump** despite
removing the `tag` kind and the `version` field (which §9.3 doctrine
would normally classify as major). The justification: v0.3.0 was a
brief draft state with internal inconsistency between §2.2 (tag as
kind) and §4.2 (tags as lightweight refs); no external consumer ever
held v0.3.0 data, and v0.3.1 resolves the inconsistency toward §4.2.
See §9.7 for the full transition narrative and the SQL/blob
considerations.

The 0.3.1 → 0.4.0 transition is a **minor bump**: one new optional
top-level field (`apmLockfile`) and the new reproducer contract (§6.1).
v0.3.x readers preserve the unknown field per §9.2 and continue to
function. v0.4.0 readers handle the field's absence by treating it as
null, which makes pre-v0.4.0 snapshots reproducer-compatible (the
reproducer reports them as "no APM lockfile recorded" and skips the
APM phase). See §9.8 for the full transition narrative.

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

### 9.3 What constitutes a minor bump within the v0.3.x family

The minor-version digit moves only for **additive, reader-compatible**
changes. A v0.3.0 reader, following the §9.2 unknown-field-preservation
rule, MUST be able to round-trip and render any v0.3.x blob without
data loss. Concretely:

**Counts as a minor bump (v0.3.0 → v0.3.x):**

- Adding a new **optional top-level field** to `Snapshot`. v0.3.0 readers
  preserve it as an unknown field per §9.2.
- Adding a new **optional `Module` field**. Same rule.
- Tightening an existing pattern or CHECK constraint that was previously
  permissive (so previously-rejecting writers continue to reject).

**Does NOT count as a minor bump (requires a major bump or `x-` prefix):**

- Adding a new value to an existing closed enum (`kind`, `source.kind`,
  attribution `eventKind`). v0.3.0 readers MUST tolerate unknown
  `source.kind` per §9.2 (preserve verbatim, render opaque), so a writer
  experimenting with a new kind SHOULD use the `x-` prefix until the
  spec adopts it normatively. A normative addition (without `x-`) is a
  major bump because it changes what writers MUST emit; a v0.3.0 writer
  would never emit the new kind.
- Adding a new **required** field (would break v0.3.0 reader validation).
- Removing a field, renaming a field, changing a field's type.
- Changing the canonical-bytes derivation rule (§3.1) or the module
  ordering rule (§2.5/hooks.md §2.2).

**Worked example — the v0.2 → v0.3.0 transition.** Removing `message`
from the snapshot blob and renaming `manual` → `auto` in the `kind`
enum are both major-bump shapes. They were landed together in v0.3.0
because the data-model reshape (annotations as first-class events;
snapshot identity as composition-only) required both at once;
keeping `manual` while removing `message` would have left the kind
name suggesting a distinction the data no longer carries.

**Process check.** Any normative addition (even an "additive optional
field") should pair with: a §9.4 entry in the v0.4 list, a paragraph in
the relevant section, and a `compat-<topic>/` example fixture exercising
the present-and-populated case. The `harness-spec-amend` skill in
`.claude/skills/` codifies the workflow.

### 9.4 What v0.4 is expected to add

Non-normative; recorded for orientation only.

- Additional hook events: `PreCompact`, `SessionEnd`, `ConfigChange`.
  Each gains a corresponding attribution `eventKind` per §2.7.
- Storing local-source module file content inside the snapshot blob
  (or as side-blobs) so `kind: "local"` reproduction is byte-exact.
  v0.4.0's reproducer (§6.1) reports local-source modules without
  materializing them; full local-source materialization is deferred
  to a future minor or major bump (the choice depends on whether
  storing content can be made additive-optional).
- A reflog (history of ref movements). If "annotated tags" enter the
  design conversation, they would land as a separate artifact alongside
  refs, NOT as a snapshot kind (per the §2.2 / §4.2 commitment).
- Multi-machine sync semantics (push/pull, conflict resolution beyond
  ref fast-forward).
- User-level capture (`~/.claude/`) gated on the team-sync semantics
  above.
- `harness log --since <ref>` filter.
- Float canonicalization tightening, if real-world snapshots demand it.

These items are explicitly out of scope for v0.3. Writers SHOULD NOT
depend on them; readers MUST NOT assume they exist.

### 9.5 Migration from v0.1.x → v0.2.0 (historical)

`harness migrate` is the supported migration path from v0.1.x. It is
idempotent and operates in-place on a `.harness/` directory.

The migration:

1. Detects current schema version from `_schema.version`.
2. Applies `002_v0_2_decoupling.sql` if not already applied. This:
   - Adds the `attributions` table.
   - Drops `snapshots.session_id` and the corresponding index.
   - Updates the `snapshots.kind` CHECK constraint to
     `IN ('init', 'manual', 'tag')`.
3. Rewrites every existing snapshot blob:
   - Strips the `sessionId` top-level field.
   - Maps `kind` values: `auto` / `edit` / `fork` → `manual`; `init`
     and `tag` unchanged.
   - Sets `formatVersion` to `"0.2"` (overwriting any prior value).
   - Recomputes the canonical bytes and the snapshot id.
   - Writes the new blob at `snapshots/<aa>/<rest>.json` derived from
     the new id; deletes the old blob path.
   - Updates `parentIds` references in any blob that pointed at a
     rewritten id.
4. Deduplicates: snapshots that became byte-identical after
   re-canonicalization (i.e. v0.1.x compositions identical except for
   `sessionId`) are merged. Attribution rows from the absorbed snapshot
   are reattached to the surviving id; ref entries pointing at absorbed
   ids are rewritten.
5. Backfills attributions: for each pre-migration snapshot row that had
   a non-null `session_id`, inserts one attribution row with
   `event_kind = 'migrated'`, `observed_at = old.created_at`,
   `source = NULL`.

Lossiness: any mid-session composition changes v0.1.x missed (the
firing-time measurement bug discussed in §4.6 left some sessions
under-recorded) are not recoverable. The migration preserves what
v0.1.x captured and no more.

The migration runs only forward. Reverting from v0.2.x to v0.1.x is not
supported; restore from a backup if needed.

The `migrate` command produces v0.2.0 data. It does NOT produce v0.3.0
data — see §9.6.

### 9.6 v0.2.x → v0.3.0: no automated migration

There is no `harness migrate` path from v0.2.x to v0.3.0. The v0.3.0
data model treats user annotations as first-class attribution events
(§2.7) rather than a `message` field on the snapshot blob; mechanically
mapping a v0.2.x `message` to a v0.3.0 `note` event would require
synthesizing a `(sessionId, observedAt)` pair that the original capture
did not record, and the `created_at` timestamp on the snapshot is the
*composition-change* time, not the annotation time. The two concepts
coincided in v0.2.x because messages lived on the snapshot; under the
v0.3 separation that conflation no longer holds.

The supported path forward for v0.2.x users:

1. Take a backup of the existing `.harness/` directory.
2. Delete it.
3. Run `harness init` against the project; v0.3.0 capture begins from
   that point.

v0.2.x snapshots in the backup remain readable by v0.2.x tools. v0.3.0
tools refuse them per §9.1. There is no plan to add a v0.2 → v0.3
migrator: the cost of a hand-built migration tool exceeds the value of
re-importing data that was already captured in service of feedback
loops the v0.3 design supersedes.

### 9.7 v0.3.0 → v0.3.1: drop `tag` kind + `version` field

v0.3.0 was a brief draft state with internal inconsistency: §2.2
listed `tag` as a snapshot kind with required `version`, while §4.2
described tags as lightweight refs. The CLI implemented §4.2 (`harness
tag` writes `refs/tags/<name>`, no new snapshot); the example
generator (`scripts/build_examples.py`) implemented §2.2 (writing
`kind: "tag"` snapshot blobs into every example fixture). Spec
readers had to handle both interpretations.

v0.3.1 resolves toward §4.2: tags are lightweight refs, period. The
`tag` kind value and the `version` field are removed. Snapshots
represent composition observations; promotion events live in
`refs/tags/`, not in snapshot kinds. This is the same architectural
discipline that drove the v0.3.0 removal of `message` (snapshots
don't mean things beyond their composition).

**Why a patch bump despite §9.3 "removing an enum value is a major
bump" doctrine:**

- v0.3.0 was never shipped to external consumers. Its lifetime was
  the brief window between the v0.3 cutover commit and the v0.3.1
  cleanup; only the developer who landed both commits ever held
  v0.3.0 data.
- The CLI's actual behavior in v0.3.0 produced **zero** `tag`-kind
  snapshots — `harness tag` already wrote lightweight refs only. The
  only v0.3.0 sites that ever produced `tag`-kind snapshots were the
  example-fixture generator and any reader/writer that mirrored §2.2.
- The §9.3 doctrine exists to protect downstream readers. With no
  downstream readers of v0.3.0, the protection has nothing to
  preserve.

The v0.3.0 → v0.3.1 schema migration (`spec/schema/005_drop_tag_kind.sql`):

1. Reshapes the `snapshots` table CHECK constraint to
   `kind IN ('init', 'auto')`.
2. Drops the `version` column (its only purpose was annotating tag-
   kind snapshots).
3. Drops any `kind = 'tag'` rows that exist (no-op for real CLI users
   per the previous bullet; logs a notice if any are found).
4. Bumps `_schema.version` to 5.

The migration does NOT rewrite snapshot blob files on disk. A v0.3.0
`.harness/` that ran the example-generator would have orphan
`<aa>/<rest>.json` files for the dropped tag-kind blobs after the
migration; they're harmless (not loaded by `harness reindex`) and
can be deleted manually. Real v0.3.0 CLI users have no such orphans.

The supported path for anyone who somehow held v0.3.0 example data:

1. Optionally back up `.harness/snapshots/` for forensic value.
2. Run any v0.3.1 tool against the directory; it migrates the SQLite
   automatically on `IndexDb.open()`.
3. Optionally `harness reindex` to rebuild the SQLite from on-disk
   blobs, dropping any orphaned tag-kind blobs in the process.

The example fixtures under `spec/examples/` are regenerated by the
v0.3.1 `build_examples.py` without tag-kind snapshots. Each fixture's
underlying composition is reachable from the `refs/tags/<name>` ref
directly.

### 9.8 v0.3.1 → v0.4.0: `apmLockfile` and the reproducer

v0.4.0 adds one optional top-level field (`apmLockfile`, §2.1) and
introduces the reproducer contract (§6.1). The format change itself
is small; what matters is that v0.4.0 captures enough state in the
blob for `harness reproduce` to drive APM's lockfile-honoring install
deterministically without depending on the project's git state at
reproduction time.

**Why this is a minor bump (per §9.3):**

- The new field is **optional**. v0.3.x readers per §9.2 preserve the
  field on round-trip and ignore its semantics. They continue to function.
- No existing field changed type, name, or required status.
- No enum value was added or removed.
- The canonical-bytes derivation rule (§3.1) is unchanged in shape
  — `apmLockfile` joins the existing list of participating fields,
  consistent with the doctrine that composition-defining fields
  participate.

**The schema migration (`spec/schema/006_apm_lockfile.sql`):**

1. Adds `apm_lockfile TEXT` column to `snapshots` (nullable).
2. Bumps `_schema.version` to 6.

No data migration is needed for existing v0.3.x rows — they remain
valid with `apm_lockfile = NULL`. A v0.4.0 reader loads them
unchanged; the reproducer treats null as "no APM lockfile recorded"
and skips the APM phase.

**Reading v0.3.x snapshots in v0.4.0:** Fully compatible. The
reproducer reports such snapshots as "no APM lockfile recorded" and
proceeds with builtins-only verification + local-source reporting. No
reader-side migration is needed.

**Reading v0.4.0 snapshots in v0.3.x:** Per §9.2, v0.3.x readers
preserve `apmLockfile` as an unknown top-level field on round-trip.
They cannot reproduce, but they can render lineage and diffs.

**Test vector continuity:** `spec/test-vectors/canonical-501.bin` is
unchanged in v0.4.0. The vector's input snapshot does not carry
`apmLockfile` (the field is optional and absent), and v0.4.0 byte
production for an absent field is identical to v0.3.1 byte production.
A new fixture exercising the present-and-populated case lives at
`spec/examples/solo-with-apm-lockfile/` (added in v0.4.0).
