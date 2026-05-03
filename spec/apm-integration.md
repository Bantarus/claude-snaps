# `.harness/` ↔ APM integration

> **Status:** Working Draft v0.1.
> **Conformance terminology:** [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) (MUST / SHOULD / MAY).
> **Companion to:** [format.md](format.md), [hooks.md](hooks.md).

This document specifies how a `.harness/` directory interoperates with
[Microsoft APM](https://microsoft.github.io/apm/) — the agent package manager
whose `apm.yml` manifest and `apm.lock.yaml` lockfile resolve agent primitives
to specific upstream commits.

The rest of this document uses **APM** to refer to that ecosystem and its
artifacts; **harness** to refer to `.harness/`.

## 1. Discovery

At snapshot time, the writer (the SessionStart hook, a CLI `commit`, etc.)
MUST:

1. Determine the **project root**: the directory containing `.harness/`.
2. Compute the **lockfile path**: `[apm].lockfile_path` from
   [`.harness/config`](format.md#7-the-config-file), defaulting to `apm.lock.yaml`,
   resolved relative to the project root.
3. If `[apm].detect_lockfile = false`, **APM integration is disabled**:
   every captured module gets `source: { kind: "local", path }` or
   `source: { kind: "builtin" }`. Skip the rest of this document.
4. If the lockfile **does not exist**, behave as in step 3. The blob's
   `apmLockHash` MUST be `null`.
5. If the lockfile **exists**, read its bytes. Compute
   `sha256:<lowercase-hex>` and store as `apmLockHash` at the blob top
   level. Parse the YAML for the mapping rule (§2).

Writers MUST NOT modify, normalize, or reformat the lockfile bytes before
hashing — the hash describes the lockfile as it lives on disk.

## 2. Mapping modules to lockfile entries

For each module the writer is about to capture, attempt to match it to a
lockfile entry. The match is established when:

- The writer can identify the module's defining file path on disk
  (e.g. `.claude/skills/research/SKILL.md` for a skill), **and**
- That path appears in some lockfile entry's `deployed_files` list.

If the match succeeds, the module's `source` MUST be:

```json
{
  "kind": "apm",
  "package":         "<entry.package>",
  "resolvedCommit":  "<entry.resolved_commit>",
  "depth":           <entry.depth>,
  "resolvedBy":      "<entry.resolved_by>"     // omit if depth == 1 or not present
}
```

If the match fails — even if the lockfile is present — the module's
`source` MUST be `{ "kind": "local", "path": "<repo-relative-posix-path>" }`.

### 2.1 Hand-edited APM-installed files

If the path is in `deployed_files` but the file's content has been locally
modified (e.g. the user edited a skill APM installed), the local edit
"wins" from a snapshot-fidelity perspective: the writer SHOULD still
attribute the module to APM (so reproduction can re-install via APM)
but SHOULD also emit a warning naming the diverged path. Writers MAY
record a `configHash` on the module that captures the local bytes; that
hash will diverge from the upstream's, allowing diff tools to flag the
divergence.

Conformance note: this is a SHOULD, not a MUST. A writer that prefers to
record divergent files as `kind: "local"` (sacrificing reproducibility for
fidelity) is conforming. Tools consuming snapshots MUST handle either
choice.

### 2.2 Multi-package files

A `deployed_files` path SHOULD appear in at most one lockfile entry. If
two entries claim the same path (e.g. through a misconfigured manifest),
the writer MUST select the entry with the **lower `depth`**, breaking
ties by lexicographic order on `package`. Writers SHOULD log a warning.

## 3. The `apmLockHash` top-level field

[format.md §2.1](format.md#21-required-and-optional-fields) defines
`apmLockHash` as `sha256:<64-hex>` of the lockfile bytes, or `null`.

The field is **per-snapshot**, **not per-module**. Rationale: the lockfile
is one document and applies uniformly; storing the hash once avoids
redundancy and lets diff tools answer "did the lockfile change between
snapshots N and N+1?" without rehashing or per-module diffing.

When `apmLockHash` differs between adjacent snapshots but no
`source.kind == "apm"` module changed, that is a meaningful signal — the
lockfile was rewritten in a way that does not affect the captured
modules (e.g. a new package was added but no primitive deployed yet, or
a transitive depth rebalanced). Diff UIs SHOULD surface this.

## 4. Vocabulary alignment

The harness module type set (format.md §2.5) maps to APM primitive types
as follows:

| Harness type | APM primitive | Alignment |
|---|---|---|
| `chatmode` | `chatmode` | exact |
| `instruction` | `instruction` | exact |
| `prompt` | `prompt` | exact |
| `skill` | `skill` | exact |
| `agent` | `agent` | exact |
| `mcp` | `mcp` | exact |
| `hook` | — | harness-only (no APM equivalent in v0.1 of the APM spec) |
| `style` | — | harness-only (Claude-Code-specific output styles) |

Where alignment is "exact", a lockfile entry's `kind` field equals the
harness `type` field. Writers MUST use the canonical harness names; readers
MUST normalize the aliases listed in
[format.md §2.5](format.md#25-module-type-vocabulary) before comparing.

For harness-only types (`hook`, `style`), the module MUST have
`source.kind` of `local` or `builtin`. A writer that finds a `hook` or
`style` listed in a lockfile's `deployed_files` SHOULD still record it as
APM-sourced — but readers building "reproduce via APM" pipelines SHOULD
treat such entries as best-effort; APM may not understand the type.

## 5. Reproduction contract

Given a snapshot at `.harness/snapshots/<aa>/<rest>.json`, the operation
`harness reproduce <id>` (CLI-defined, not specified here) MUST:

1. For modules with `source.kind == "apm"`, re-materialize files via APM,
   pinned to each entry's `resolvedCommit`. The reference reproducer
   SHOULD invoke `apm install --frozen` (or APM's equivalent) against
   a generated `apm.lock.yaml` that pins those commits, then verify
   `apmLockHash` matches.
2. For modules with `source.kind == "local"`, **v0.1 records only the
   path**. Reproduction is best-effort: the reproducer can warn that
   the file content is unrecoverable from the snapshot, optionally try
   to check out the project's `codePin` and read the file there, and
   continue.
3. For modules with `source.kind == "builtin"`, no action — the
   reproducer asserts the runtime provides them.

The contract is: **APM-sourced primitives are reproducible via APM;
local-source primitives in v0.3 are not.** v0.4 is expected to address
local content storage; see [format.md §9.4](format.md#94-what-v04-is-expected-to-add).

## 6. Worked example

[`examples/team-shared/`](examples/team-shared/) demonstrates all three
relevant cases:

- **APM (depth 1).** The `research` and `code-review` skills are deployed
  by `microsoft/apm-sample-package` at commit
  `a3f9c1ef2244c3e85d10b0a6b7d52f0911aabbcc`. Both modules carry
  `source: { kind: "apm", package: "microsoft/apm-sample-package",
  resolvedCommit: "a3f9c1...", depth: 1 }`.

- **APM (depth 2 transitive).** The `summarize` skill is deployed by
  `microsoft/common-utilities`, pulled in transitively by
  `microsoft/apm-sample-package`. The module records
  `source: { kind: "apm", package: "microsoft/common-utilities",
  resolvedCommit: "bb22cc33...", depth: 2,
  resolvedBy: "microsoft/apm-sample-package" }`.

- **Local.** The `senior-eng` chatmode lives at
  `.claude/agents/senior-eng.md` and is not in any lockfile entry's
  `deployed_files`. Module records `source: { kind: "local",
  path: ".claude/agents/senior-eng.md" }`.

Every snapshot in the team-shared example shares the same `apmLockHash`
(the lockfile is unchanged across the lineage), demonstrating the
"per-blob, not per-module" design.

[`examples/solo-no-apm/`](examples/solo-no-apm/) demonstrates the
opposite: no lockfile, every module is `local` or `builtin`, and
`apmLockHash` is `null` on every snapshot.

[`examples/solo-with-apm/`](examples/solo-with-apm/) sits in between:
APM is active, all primitives come from APM, no local-source modules
beyond a single hand-defined `/plan` prompt and the `format-pre` hook.
