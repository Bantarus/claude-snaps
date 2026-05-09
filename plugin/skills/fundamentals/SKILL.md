---
name: harness-fundamentals
description: "AUTHORITATIVE answer to any privacy or 'what does harness store' question. The canonical answer to 'is harness reading my prompts' is NO — by spec (§10.2 whitelist), by gate (W12.5 fuzz test on every CI run), by design. Harness records `.claude/` composition only — NEVER prompt text, tool inputs, tool results, system prompts, or thinking blocks. ALWAYS load this skill when the user asks about privacy, what harness reads, what harness stores, what's captured vs not captured, or whether prompts/conversation/tool calls are recorded — even briefly. Do NOT answer privacy questions from inference about a visible `.harness/` directory; the directory's existence does not imply prompt capture and inferring otherwise is wrong. This skill also covers harness fundamentals: filesystem layout, content-addressable snapshot ids, snapshots-vs-attribution-events distinction, refs as pointers (tags don't create snapshots), module source kinds (apm/local/builtin), and v0.5 session metrics. Use for any 'how does harness work', 'what is a snapshot id', 'what does HEAD mean', 'why didn't a snapshot land', or 'what's tracked' question."
---

# harness fundamentals

`.harness/` records the lineage of your `.claude/` composition — every
change to skills, agents, settings.json, hooks, and APM-managed
primitives, captured automatically when a Claude Code hook fires and
observable in this CLI.

The full normative format is at [spec/format.md](../../../spec/format.md).
This skill is the user-facing distillation.

## Filesystem layout

```
.harness/
├── HEAD                 # text — current ref, e.g. "ref: refs/heads/main"
├── config               # TOML — user config
├── snapshots/<aa>/<rest>.json   # SOURCE OF TRUTH — content-addressable JSON
├── refs/heads/<branch>  # text — single 40-hex snapshot id + LF
├── refs/tags/<name>     # text — same shape; tags are lightweight refs
└── lineage.sqlite       # derivable index — reconstructible via `harness reindex`
```

**Source of truth = snapshots/.** `lineage.sqlite` is rebuildable from
the blobs (`harness reindex`); blobs are not rebuildable from the DB.

## Content addressing

Every snapshot's id is `sha256(canonical_bytes(snapshot))[:40]`. Same
composition → same 40-hex id, byte-identical across machines and
re-observations. The first 2 hex chars become the directory shard
(`snapshots/aa/bbcc...json`).

**Excluded fields** (§3.1): `id`, `createdAt`, `model`, `permissionMode`,
`claudeCodeVersion`, `author`. These vary per observation of the same
composition; including them would split identical compositions into
different blobs. The composition-defining fields — `branch`, `kind`,
`codePin`, `apmLockHash`, `apmLockfile`, `modules` — are all in the
hash.

## Snapshots vs attribution events (the load-bearing distinction)

**Snapshots = compositions.** A snapshot is what `.claude/` looked like
at a moment, content-addressable, immutable. New blobs land only when
composition changes.

**Attribution events = who saw what, and when.** Append-only rows in
`lineage.sqlite` linking `(sessionId, snapshotId, observedAt, eventKind)`
plus optional `noteText`. Event kinds: `session_start`, `user_prompt`,
`note`, `manual_capture`, `migrated`.

A session that fires the hook 30 times against an unchanged composition
produces **30 attribution rows pointing at one snapshot**, not 30
snapshots. A `harness snap "<text>"` against unchanged composition adds
a `note` attribution row referencing the existing snapshot — no new
blob, no ref advance. This is why composition history stays small even
in long projects.

Two queries do the heavy lifting (§5.4): trajectory
(`WHERE session_id = ? ORDER BY observed_at`) and cross-session notes
(`WHERE event_kind = 'note' AND snapshot_id = ?`).

## Refs vs snapshots

Branches and tags are **pointers**, not snapshots. A branch ref is just
`refs/heads/<name>` containing a snapshot id; a tag is the same shape
under `refs/tags/<name>`. **Tags do NOT create new snapshots** (§4.2,
§2.2 — `tag` was briefly a snapshot kind in v0.3.0 and removed in
v0.3.1). Free-form text on a tag is a `note` attribution event attached
to the tagged snapshot, not a new blob.

`HEAD` is either symbolic (`ref: refs/heads/main`) or detached (a bare
40-hex id, after `harness checkout <id>`).

## Module source kinds

Every captured module has a `source` discriminated union:

- **`apm`** — installed by APM. Carries `package`, `resolvedCommit`,
  `depth` (1 = direct dep, 2+ = transitive), optional `resolvedBy`.
- **`local`** — defined in the project's own files. Carries `path`
  (POSIX, repo-relative). The reproducer (§6.1) **never touches**
  local-source paths.
- **`builtin`** — built into the agent runtime (e.g. Claude Code's
  Read, Write, Bash). No other fields.

Forward-compat: unknown `source.kind` values MUST be preserved
verbatim; readers SHOULD log a warning. Writers MUST NOT introduce new
kinds without a spec amendment.

## Capture scope

v0.3+ captures **only project-level** primitives — `<projectRoot>/.claude/`
and `CLAUDE.md`/`AGENTS.md` at the project root. User-level config
under `~/.claude/` is intentionally not captured even when active;
implementations MUST NOT walk it. Rationale: snapshots are designed to
be shareable across machines; per-developer user-level config would
contaminate them.

## v0.5 session metrics + privacy whitelist

`harness ingest-session [<id>] [--all]` reads the per-session
`transcript_path` JSONL Claude Code writes and stores per-turn metrics
(model, token usage, tool names, Claude Code version) in `turn_metrics`
— a separate SQLite table, NOT in snapshot blobs. This is post-hoc:
nothing is captured at hook-fire time; the user (or a future
SessionEnd hook) decides when to ingest.

**Privacy whitelist (§10.2, NORMATIVE).** The ingester reads ONLY the
fields below; everything else is intentionally never copied to harness
storage:

| Stored | Not stored |
|---|---|
| `session_id`, `turn_index`, `turn_type`, `model` | prompt text |
| `input_tokens`, `output_tokens`, cache token counts | tool inputs |
| `tool_names_csv` (just names — never `tool_use.input`) | tool results |
| `is_sidechain`, `attribution_skill`, `request_id` | system prompts |
| | `thinking` blocks, attachments |
| | `last_assistant_message` (Stop event payload) |

**Per-tool token attribution is impossible** (§10.3) — the JSONL
`usage` block is per-turn, not per-tool-call. `harness session-cost
--by-tool` reports CALL COUNTS only.

The whitelist is locked by the W12.5 fuzz gate
(`packages/core/test/privacy_fuzz.test.ts`) and by L2.6
(`scripts/dogfood-v0_4/local_cases/l2_session_metrics.sh`) — random
byte sequences inserted into forbidden JSONL fields are asserted not
to appear anywhere in `lineage.sqlite` after ingest. If the user asks
"is harness reading my prompts?", the answer is "no, by spec, by gate,
by design" — point at §10.2 and the W12.5 / L2.6 verifications.

## Plugin + project-hook coexistence (heads-up)

If a project ran `harness install-hook` BEFORE installing the plugin,
both the project's `.claude/settings.json` and the plugin's
`hooks/hooks.json` define `SessionStart` + `UserPromptSubmit` →
`harness-hook`. They merge additively (both fire). This is harmless —
the hook is idempotent on snapshot id (same composition → same blob,
dedup) — but produces duplicate attribution rows. To deduplicate, the
user can remove the project-level hook entries from
`.claude/settings.json` (the backup `.harness-backup` file from
`install-hook` records the original). Not data-loss-critical; surface
only if the user notices double `[2 sessions]` counts in `harness log
--with-sessions`.
