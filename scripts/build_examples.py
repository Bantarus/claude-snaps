"""
Build the example .harness/ directories for the spec.

This is the reference generator the spec verification step uses. It:

  1. Defines snapshot blobs for each example as Python dicts (id omitted).
  2. Canonicalizes the dict to JSON bytes per format.md §3.
  3. Hashes those bytes to derive `id`.
  4. Writes the blob (with id added back) to .harness/snapshots/<aa>/<rest>.json.
  5. Writes refs/heads/<branch>, refs/tags/<name>, HEAD, and config.

The same canonicalization + hashing logic must be used by any conforming
writer; the test vector in spec/format.md §3 is generated from the SAMPLE
blob below and must match what `harness reindex` recomputes from the on-disk
JSON file.

Run: python3 scripts/build_examples.py
"""

import hashlib
import json
import os
import shutil
from pathlib import Path

SPEC_ROOT = Path(__file__).resolve().parent.parent / "spec"
EXAMPLES = SPEC_ROOT / "examples"


# ─────────────────────────────────────────────────────────────────────────────
# Canonicalization
# ─────────────────────────────────────────────────────────────────────────────

# Fields excluded from canonical bytes per format.md §3.1. The split is
# composition (participates in id) vs. observation context (does not).
EXCLUDED_FIELDS = ("id", "createdAt", "codePin", "model", "permissionMode")


def canonical_bytes(obj: dict) -> bytes:
    """
    Canonical JSON per format.md §3.2:
      - UTF-8, no BOM
      - sort_keys recursive
      - no whitespace between tokens
      - non-ASCII characters emitted as raw UTF-8 (no \\uXXXX escapes)
      - control chars < 0x20 escaped per RFC 8259 (Python default)
    Notes: integers only in our examples — float canonicalization is left
    to RFC 8785 JCS for implementations that need it (none of the example
    snapshots contain non-integer numbers).
    """
    return json.dumps(
        obj,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def _strip_excluded(snapshot: dict) -> dict:
    """Return a copy with the §3.1 excluded fields removed. The input is
    not mutated."""
    return {k: v for k, v in snapshot.items() if k not in EXCLUDED_FIELDS}


def derive_id(snapshot_without_id: dict) -> str:
    """sha256(canonical_bytes(snapshot \\ EXCLUDED_FIELDS))[:40]; lowercase hex."""
    digest = hashlib.sha256(canonical_bytes(_strip_excluded(snapshot_without_id))).hexdigest()
    return digest[:40]


def write_snapshot(harness_dir: Path, snap_no_id: dict) -> str:
    """Compute id, attach it, write to <aa>/<rest>.json. Returns the id."""
    sid = derive_id(snap_no_id)
    blob = {**snap_no_id, "id": sid}
    aa, rest = sid[:2], sid[2:]
    target_dir = harness_dir / "snapshots" / aa
    target_dir.mkdir(parents=True, exist_ok=True)
    # Pretty-print the on-disk blob — only the canonical bytes are normative
    # for hashing; on-disk format is for human diffability.
    (target_dir / f"{rest}.json").write_text(
        json.dumps(blob, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return sid


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


# ─────────────────────────────────────────────────────────────────────────────
# Module shorthand builders
# ─────────────────────────────────────────────────────────────────────────────

def m_local(t, name, path, version=None, enabled=True, config_hash=None):
    out = {"type": t, "name": name, "enabled": enabled,
           "source": {"kind": "local", "path": path}}
    if version is not None: out["version"] = version
    if config_hash is not None: out["configHash"] = config_hash
    return out


def m_apm(t, name, package, commit, depth=1, version=None, enabled=True,
          resolved_by=None, config_hash=None):
    src = {"kind": "apm", "package": package, "resolvedCommit": commit, "depth": depth}
    if resolved_by is not None: src["resolvedBy"] = resolved_by
    out = {"type": t, "name": name, "enabled": enabled, "source": src}
    if version is not None: out["version"] = version
    if config_hash is not None: out["configHash"] = config_hash
    return out


def m_builtin(t, name, enabled=True):
    return {"type": t, "name": name, "enabled": enabled, "source": {"kind": "builtin"}}


# ─────────────────────────────────────────────────────────────────────────────
# Default config TOML (one source of truth)
# ─────────────────────────────────────────────────────────────────────────────

CONFIG_DEFAULT = """\
# .harness/config — TOML. See spec/format.md §7.

[core]
default_branch = "main"
format_version = "0.3"

[capture]
auto_snapshot_on_session = true
include_transcripts = false
mask_paths = []

[apm]
detect_lockfile = true
lockfile_path = "apm.lock.yaml"

[gitignore]
policy = "private"
"""


# ─────────────────────────────────────────────────────────────────────────────
# Example: empty/
# ─────────────────────────────────────────────────────────────────────────────

def build_empty():
    h = EXAMPLES / "empty" / ".harness"
    if h.exists():
        shutil.rmtree(h)
    (h / "snapshots").mkdir(parents=True)
    (h / "refs" / "heads").mkdir(parents=True)
    write_text(h / "HEAD", "ref: refs/heads/main\n")
    write_text(h / "config", CONFIG_DEFAULT)
    # No snapshots, no refs files yet — `harness init` writes these on first commit.


# ─────────────────────────────────────────────────────────────────────────────
# Example: solo-no-apm/  — five snapshots on `main`, no APM
# ─────────────────────────────────────────────────────────────────────────────

def build_solo_no_apm():
    proj = EXAMPLES / "solo-no-apm"
    h = proj / ".harness"
    if h.exists():
        shutil.rmtree(h)
    (h / "snapshots").mkdir(parents=True)
    (h / "refs" / "heads").mkdir(parents=True)
    (h / "refs" / "tags").mkdir(parents=True)

    base_modules = [
        m_local("chatmode", "senior-eng", ".claude/agents/senior-eng.md"),
        m_local("skill", "research", ".claude/skills/research/SKILL.md", version="v0.4"),
        m_local("prompt", "/plan", ".claude/commands/plan.md"),
        m_local("hook", "format-pre", ".claude/settings.json"),
        m_builtin("mcp", "Read"),
        m_builtin("mcp", "Write"),
        m_builtin("mcp", "Bash"),
    ]
    s_init = {
        "formatVersion": "0.3",
        "parentIds": [],
        "branch": "main",
        "kind": "init",
        "codePin": "71fe33aa01bc4d2e3f8970a14b5cdee2330aa901",
        "createdAt": "2026-04-23T09:12:30.000Z",
        "author": "ben@example.com",
        "apmLockHash": None,
        "modules": base_modules,
    }
    id_init = write_snapshot(h, s_init)

    s_manual_edit = {
        "formatVersion": "0.3",
        "parentIds": [id_init],
        "branch": "main",
        "kind": "auto",
        "codePin": "71fe33aa01bc4d2e3f8970a14b5cdee2330aa901",
        "createdAt": "2026-04-24T17:42:11.500Z",
        "author": "ben@example.com",
        "apmLockHash": None,
        "modules": base_modules + [
            m_local("hook", "format-post", ".claude/settings.json"),
        ],
    }
    id_manual_edit = write_snapshot(h, s_manual_edit)

    auto_modules = base_modules + [m_local("hook", "format-post", ".claude/settings.json")]
    s_auto1 = {
        "formatVersion": "0.3",
        "parentIds": [id_manual_edit],
        "branch": "main",
        "kind": "auto",
        "codePin": "9c12aa44b30115ee61b2c7a890fdc31002ee30bb",
        "createdAt": "2026-04-25T08:03:45.812Z",
        "author": "ben@example.com",
        "apmLockHash": None,
        "modules": auto_modules,
    }
    id_auto1 = write_snapshot(h, s_auto1)

    # v0.3.1: tag is a lightweight ref, not a snapshot. The v0.2 tag
    # points directly at id_auto1 (the underlying composition);
    # s_auto2 below parents on id_auto1 directly (was id_tag pre-v0.3.1).
    s_auto2 = {
        "formatVersion": "0.3",
        "parentIds": [id_auto1],
        "branch": "main",
        "kind": "auto",
        "codePin": "a3f9c1ef2244c3e85d10b0a6b7d52f0911aabbcc",
        "createdAt": "2026-04-30T12:08:24.000Z",
        "author": "ben@example.com",
        "apmLockHash": None,
        "modules": auto_modules,
    }
    id_auto2 = write_snapshot(h, s_auto2)

    write_text(h / "HEAD", "ref: refs/heads/main\n")
    write_text(h / "refs" / "heads" / "main", id_auto2 + "\n")
    write_text(h / "refs" / "tags" / "v0.2", id_auto1 + "\n")
    write_text(h / "config", CONFIG_DEFAULT)


# ─────────────────────────────────────────────────────────────────────────────
# Example: solo-with-apm/  — three snapshots, APM lockfile present
# ─────────────────────────────────────────────────────────────────────────────

APM_YML_SOLO = """\
# apm.yml — Microsoft APM manifest (illustrative).
name: solo-research-bot
primitives:
  - kind: skill
    package: microsoft/research-skills
    version: ^0.5
  - kind: chatmode
    package: microsoft/senior-eng
    version: ^1.0
"""

APM_LOCK_SOLO = """\
# apm.lock.yaml — illustrative; resolved versions pinned to commits.
lockfile_version: 1
packages:
  - package: microsoft/research-skills
    repo_url: https://github.com/microsoft/research-skills
    resolved_commit: 4d2e1aa00ff34b9b1cdef0a1b2c3d4e5f6a7b8c9
    depth: 1
    deployed_files:
      - .claude/skills/research/SKILL.md
      - .claude/skills/summarize/SKILL.md
  - package: microsoft/senior-eng
    repo_url: https://github.com/microsoft/senior-eng
    resolved_commit: 88aa11bb22cc33dd44ee55ff66001122334455aa
    depth: 1
    deployed_files:
      - .claude/agents/senior-eng.md
"""

# sha256 of the lockfile bytes (computed at runtime so the spec example stays
# consistent if the example string ever changes)
def _sha256_str(s: str) -> str:
    return "sha256:" + hashlib.sha256(s.encode("utf-8")).hexdigest()


def build_solo_with_apm():
    proj = EXAMPLES / "solo-with-apm"
    h = proj / ".harness"
    if h.exists():
        shutil.rmtree(h)
    (h / "snapshots").mkdir(parents=True)
    (h / "refs" / "heads").mkdir(parents=True)
    (h / "refs" / "tags").mkdir(parents=True)

    write_text(proj / "apm.yml", APM_YML_SOLO)
    write_text(proj / "apm.lock.yaml", APM_LOCK_SOLO)
    lock_hash = _sha256_str(APM_LOCK_SOLO)

    modules_v1 = [
        m_apm("chatmode", "senior-eng",
              "microsoft/senior-eng",
              "88aa11bb22cc33dd44ee55ff66001122334455aa",
              depth=1),
        m_apm("skill", "research",
              "microsoft/research-skills",
              "4d2e1aa00ff34b9b1cdef0a1b2c3d4e5f6a7b8c9",
              depth=1, version="v0.5"),
        m_apm("skill", "summarize",
              "microsoft/research-skills",
              "4d2e1aa00ff34b9b1cdef0a1b2c3d4e5f6a7b8c9",
              depth=1, version="v0.5"),
        m_local("prompt", "/plan", ".claude/commands/plan.md"),
        m_local("hook", "format-pre", ".claude/settings.json"),
        m_builtin("mcp", "Read"),
        m_builtin("mcp", "Bash"),
    ]
    s_init = {
        "formatVersion": "0.3",
        "parentIds": [],
        "branch": "main",
        "kind": "init",
        "codePin": "1100ffeebbccdd44aa5566778899aabbccddeeff",
        "createdAt": "2026-04-26T10:00:00.000Z",
        "author": "ben@example.com",
        "apmLockHash": lock_hash,
        "modules": modules_v1,
    }
    id_init = write_snapshot(h, s_init)

    s_auto = {
        "formatVersion": "0.3",
        "parentIds": [id_init],
        "branch": "main",
        "kind": "auto",
        "codePin": "1100ffeebbccdd44aa5566778899aabbccddeeff",
        "createdAt": "2026-04-27T11:30:00.000Z",
        "author": "ben@example.com",
        "apmLockHash": lock_hash,
        "modules": modules_v1,
    }
    id_auto = write_snapshot(h, s_auto)

    # v0.3.1: tag is a lightweight ref. v0.1 points at id_auto (the
    # tagged composition). HEAD also points at id_auto via main.
    write_text(h / "HEAD", "ref: refs/heads/main\n")
    write_text(h / "refs" / "heads" / "main", id_auto + "\n")
    write_text(h / "refs" / "tags" / "v0.1", id_auto + "\n")
    write_text(h / "config", CONFIG_DEFAULT)


# ─────────────────────────────────────────────────────────────────────────────
# Example: team-shared/  — main + experimental, one tag, mix of APM + local
# ─────────────────────────────────────────────────────────────────────────────

APM_YML_TEAM = """\
# apm.yml — team manifest with one direct dep that pulls a transitive.
name: team-research
primitives:
  - kind: skill
    package: microsoft/apm-sample-package
    version: ^1.6
"""

APM_LOCK_TEAM = """\
# apm.lock.yaml — team-shared example. apm-sample-package depends on
# common-utilities (depth 2).
lockfile_version: 1
packages:
  - package: microsoft/apm-sample-package
    repo_url: https://github.com/microsoft/apm-sample-package
    resolved_commit: a3f9c1ef2244c3e85d10b0a6b7d52f0911aabbcc
    depth: 1
    deployed_files:
      - .claude/skills/research/SKILL.md
      - .claude/skills/code-review/SKILL.md
  - package: microsoft/common-utilities
    repo_url: https://github.com/microsoft/common-utilities
    resolved_commit: bb22cc33dd44ee55ff66778899aabbccddeeff00
    depth: 2
    resolved_by: microsoft/apm-sample-package
    deployed_files:
      - .claude/skills/summarize/SKILL.md
"""


def build_team_shared():
    proj = EXAMPLES / "team-shared"
    h = proj / ".harness"
    if h.exists():
        shutil.rmtree(h)
    (h / "snapshots").mkdir(parents=True)
    (h / "refs" / "heads").mkdir(parents=True)
    (h / "refs" / "tags").mkdir(parents=True)

    write_text(proj / "apm.yml", APM_YML_TEAM)
    write_text(proj / "apm.lock.yaml", APM_LOCK_TEAM)
    lock_hash = _sha256_str(APM_LOCK_TEAM)

    apm_pkg = "microsoft/apm-sample-package"
    apm_commit = "a3f9c1ef2244c3e85d10b0a6b7d52f0911aabbcc"
    util_pkg = "microsoft/common-utilities"
    util_commit = "bb22cc33dd44ee55ff66778899aabbccddeeff00"

    modules_v04 = [
        m_local("chatmode", "senior-eng", ".claude/agents/senior-eng.md"),
        m_apm("skill", "research", apm_pkg, apm_commit, depth=1, version="v1.6"),
        m_apm("skill", "code-review", apm_pkg, apm_commit, depth=1, version="v1.6"),
        m_apm("skill", "summarize", util_pkg, util_commit, depth=2,
              resolved_by=apm_pkg, version="v0.2"),
        m_local("prompt", "/plan", ".claude/commands/plan.md"),
        m_local("hook", "format-pre", ".claude/settings.json"),
        m_local("hook", "format-post", ".claude/settings.json"),
        m_local("style", "terse", ".claude/output-styles/terse.md"),
        m_builtin("mcp", "Read"),
        m_builtin("mcp", "Write"),
        m_builtin("mcp", "Bash"),
    ]

    s_init = {
        "formatVersion": "0.3",
        "parentIds": [],
        "branch": "main",
        "kind": "init",
        "codePin": "9c12aa44b30115ee61b2c7a890fdc31002ee30bb",
        "createdAt": "2026-04-20T09:00:00.000Z",
        "author": "ben@example.com",
        "apmLockHash": lock_hash,
        "modules": modules_v04,
    }
    id_init = write_snapshot(h, s_init)

    s_auto1 = {
        "formatVersion": "0.3",
        "parentIds": [id_init],
        "branch": "main",
        "kind": "auto",
        "codePin": "a3f9c1ef2244c3e85d10b0a6b7d52f0911aabbcc",
        "createdAt": "2026-04-30T12:04:12.000Z",
        "author": "ben@example.com",
        "apmLockHash": lock_hash,
        "modules": modules_v04,
    }
    id_auto1 = write_snapshot(h, s_auto1)

    # v0.3.1: tag is a lightweight ref. The v0.4 tag points at id_auto1
    # (the tagged composition); main also points there. The fork onto
    # `experimental` is a plain `auto` snapshot whose new branch ref
    # defines the fork — `kind` does not encode "fork" (§2.2).
    s_branch = {
        "formatVersion": "0.3",
        "parentIds": [id_auto1],
        "branch": "experimental",
        "kind": "auto",
        "codePin": "a3f9c1ef2244c3e85d10b0a6b7d52f0911aabbcc",
        "createdAt": "2026-04-30T14:30:00.000Z",
        "author": "alex@example.com",
        "apmLockHash": lock_hash,
        "modules": modules_v04,
    }
    id_branch = write_snapshot(h, s_branch)

    modules_exp = modules_v04 + [
        m_local("chatmode", "haiku-research", ".claude/agents/haiku-research.md"),
    ]
    s_exp_auto = {
        "formatVersion": "0.3",
        "parentIds": [id_branch],
        "branch": "experimental",
        "kind": "auto",
        "codePin": "a3f9c1ef2244c3e85d10b0a6b7d52f0911aabbcc",
        "createdAt": "2026-04-30T15:18:00.000Z",
        "author": "alex@example.com",
        "apmLockHash": lock_hash,
        "modules": modules_exp,
    }
    id_exp_auto = write_snapshot(h, s_exp_auto)

    write_text(h / "HEAD", "ref: refs/heads/main\n")
    write_text(h / "refs" / "heads" / "main", id_auto1 + "\n")
    write_text(h / "refs" / "heads" / "experimental", id_exp_auto + "\n")
    write_text(h / "refs" / "tags" / "v0.4", id_auto1 + "\n")
    write_text(h / "config", CONFIG_DEFAULT)


# ─────────────────────────────────────────────────────────────────────────────
# Example: compat-fixtures/  — synthetic blobs v0.1 readers MUST tolerate
# but v0.1 writers DO NOT produce. Exists to test forward-compat code paths.
# ─────────────────────────────────────────────────────────────────────────────

COMPAT_README = """\
# compat-fixtures — reader compatibility test cases

These snapshots are SYNTHETIC. A v0.3 writer never produces them. A v0.3
reader MUST tolerate them per the rules in spec/format.md §4.1 (merge
parents) and §9.2 (unknown `source.kind` and forward-compat fields).

Purpose: a reference reader can be regression-tested by loading this
example and asserting that it surfaces each blob without crashing,
preserves unknown variants on round-trip, and renders the DAG correctly
(including the merge node and its diamond-shaped ancestry).

| Snapshot kind/role  | What it exercises |
|---|---|
| init                | baseline ancestor for the diamond |
| auto (left)         | one branch of the diamond |
| auto (right)        | other branch of the diamond |
| auto — merge        | `parentIds.length === 2`; readers MUST handle |
| auto — x-extension  | a module whose `source.kind` is `x-experimental-bundle`; readers MUST preserve verbatim and treat as opaque |

The `examples/compat-session-ctx/` example is a sibling fixture that exercises
populated optional `model` and `permissionMode` blob fields — kept separate so
the diamond DAG above stays free of additional descendants.

The example uses the `auto` kind for the merge node rather than
introducing a `merge` kind enum value — v0.3 of the spec reserves
length-2 parents but does not add a kind for it. The `auto` value
covers any composition-change capture in v0.3.
"""


def build_compat_fixtures():
    proj = EXAMPLES / "compat-fixtures"
    h = proj / ".harness"
    if h.exists():
        shutil.rmtree(h)
    (h / "snapshots").mkdir(parents=True)
    (h / "refs" / "heads").mkdir(parents=True)

    base_modules = [
        m_local("chatmode", "senior-eng", ".claude/agents/senior-eng.md"),
        m_builtin("mcp", "Read"),
        m_builtin("mcp", "Bash"),
    ]

    s_init = {
        "formatVersion": "0.3",
        "parentIds": [],
        "branch": "main",
        "kind": "init",
        "codePin": None,
        "createdAt": "2026-04-01T00:00:00.000Z",
        "apmLockHash": None,
        "modules": base_modules,
    }
    id_init = write_snapshot(h, s_init)

    s_left = {
        "formatVersion": "0.3",
        "parentIds": [id_init],
        "branch": "main",
        "kind": "auto",
        "codePin": None,
        "createdAt": "2026-04-02T00:00:00.000Z",
        "apmLockHash": None,
        "modules": base_modules + [
            m_local("skill", "left-only", ".claude/skills/left-only/SKILL.md"),
        ],
    }
    id_left = write_snapshot(h, s_left)

    s_right = {
        "formatVersion": "0.3",
        "parentIds": [id_init],
        "branch": "main",
        "kind": "auto",
        "codePin": None,
        "createdAt": "2026-04-02T00:00:00.000Z",
        "apmLockHash": None,
        "modules": base_modules + [
            m_local("skill", "right-only", ".claude/skills/right-only/SKILL.md"),
        ],
    }
    id_right = write_snapshot(h, s_right)

    # Merge node — parentIds.length == 2. v0.3 writers don't produce this;
    # readers MUST tolerate per format.md §4.1.
    s_merge = {
        "formatVersion": "0.3",
        "parentIds": [id_left, id_right],
        "branch": "main",
        "kind": "auto",
        "codePin": None,
        "createdAt": "2026-04-03T00:00:00.000Z",
        "apmLockHash": None,
        "modules": base_modules + [
            m_local("skill", "left-only", ".claude/skills/left-only/SKILL.md"),
            m_local("skill", "right-only", ".claude/skills/right-only/SKILL.md"),
        ],
    }
    id_merge = write_snapshot(h, s_merge)

    # x-extension source.kind. Readers MUST preserve verbatim per §9.2.
    s_xext = {
        "formatVersion": "0.3",
        "parentIds": [id_merge],
        "branch": "main",
        "kind": "auto",
        "codePin": None,
        "createdAt": "2026-04-04T00:00:00.000Z",
        "apmLockHash": None,
        "modules": base_modules + [
            {
                "type": "skill",
                "name": "private-bundle-skill",
                "enabled": True,
                "source": {
                    "kind": "x-experimental-bundle",
                    "bundleId": "internal/research-bundle-v3",
                    "ref": "abc123",
                },
            },
        ],
    }
    id_xext = write_snapshot(h, s_xext)

    write_text(h / "HEAD", "ref: refs/heads/main\n")
    write_text(h / "refs" / "heads" / "main", id_xext + "\n")
    write_text(h / "config", CONFIG_DEFAULT)
    write_text(proj / "READER-COMPAT.md", COMPAT_README)


# ─────────────────────────────────────────────────────────────────────────────
# Example: compat-session-ctx/  — exercises the optional `model` and
# `permissionMode` top-level fields written by the SessionStart hook from
# its stdin payload (format.md §2.1, hooks.md §1.1). All other examples
# exercise the field-absent path; this one exercises field-present.
# ─────────────────────────────────────────────────────────────────────────────

SESSION_CTX_README = """\
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
"""


def build_compat_session_ctx():
    proj = EXAMPLES / "compat-session-ctx"
    h = proj / ".harness"
    if h.exists():
        shutil.rmtree(h)
    (h / "snapshots").mkdir(parents=True)
    (h / "refs" / "heads").mkdir(parents=True)

    base_modules = [
        m_local("chatmode", "senior-eng", ".claude/agents/senior-eng.md"),
        m_builtin("mcp", "Read"),
        m_builtin("mcp", "Bash"),
    ]

    s_init = {
        "formatVersion": "0.3",
        "parentIds": [],
        "branch": "main",
        "kind": "init",
        "codePin": None,
        "createdAt": "2026-04-05T00:00:00.000Z",
        "apmLockHash": None,
        "modules": base_modules,
    }
    id_init = write_snapshot(h, s_init)

    # Auto snapshot (hook-driven composition change) with both optional
    # session-context fields populated by the hook from its stdin payload.
    s_auto = {
        "formatVersion": "0.3",
        "parentIds": [id_init],
        "branch": "main",
        "kind": "auto",
        "codePin": None,
        "createdAt": "2026-04-05T00:01:00.000Z",
        "apmLockHash": None,
        "model": "claude-opus-4-7",
        "permissionMode": "default",
        "modules": base_modules,
    }
    id_auto = write_snapshot(h, s_auto)

    write_text(h / "HEAD", "ref: refs/heads/main\n")
    write_text(h / "refs" / "heads" / "main", id_auto + "\n")
    write_text(h / "config", CONFIG_DEFAULT)
    write_text(proj / "READER-COMPAT.md", SESSION_CTX_README)


# ─────────────────────────────────────────────────────────────────────────────
# Example: solo-with-apm-lockfile/  — v0.4.0 fixture exercising the new
# `apmLockfile` top-level field. The same lockfile bytes that produce
# `apmLockHash` are also stored verbatim in `apmLockfile` so that
# `harness reproduce` can drive `apm install --frozen` without
# depending on the project's git state. format.md §6.1.
# ─────────────────────────────────────────────────────────────────────────────

APM_LOCKFILE_README = """\
# solo-with-apm-lockfile — v0.4.0 reproducer fixture

Exercises the optional top-level `apmLockfile` field added in v0.4.0
(format.md §2.1, §6.1, §9.8). The single `auto` snapshot has both
`apmLockHash` and `apmLockfile` populated; the hash is the sha-256
of the lockfile's verbatim bytes. A v0.3.x reader preserves
`apmLockfile` as an unknown field per §9.2; a v0.4.0 reader uses it
to drive `harness reproduce`.

| Field | Source |
|---|---|
| `apmLockHash` | sha-256 of `apm.lock.yaml` bytes (existing v0.3 field) |
| `apmLockfile` | verbatim text of `apm.lock.yaml` (new v0.4 field) |

The fixture's `apm.lock.yaml` resolves a local file:// repo
(`./apm-source-fixture/`) so the reproducer can verify end-to-end
without network. The repo isn't checked in here as a real git tree —
it's a documentation hint that a real-world reproduction setup uses
local sources for tests. End-to-end test fixtures with real APM-
managed git repos live under `packages/core/test/fixtures/`.
"""

APM_LOCKFILE_SOLO = """\
# apm.lock.yaml — illustrative; pinned to a single local-source package.
lockfile_version: 1
packages:
  - package: harness/test-fixture-skills
    repo_url: https://example.invalid/harness/test-fixture-skills
    resolved_commit: 1234567890abcdef1234567890abcdef12345678
    depth: 1
    deployed_files:
      - .claude/skills/test-fixture/SKILL.md
"""


def build_solo_with_apm_lockfile():
    proj = EXAMPLES / "solo-with-apm-lockfile"
    h = proj / ".harness"
    if h.exists():
        shutil.rmtree(h)
    (h / "snapshots").mkdir(parents=True)
    (h / "refs" / "heads").mkdir(parents=True)

    write_text(proj / "apm.lock.yaml", APM_LOCKFILE_SOLO)
    lock_hash = _sha256_str(APM_LOCKFILE_SOLO)

    modules = [
        m_apm("skill", "test-fixture",
              "harness/test-fixture-skills",
              "1234567890abcdef1234567890abcdef12345678",
              depth=1),
        m_builtin("mcp", "Read"),
    ]

    s_init = {
        "formatVersion": "0.4",
        "parentIds": [],
        "branch": "main",
        "kind": "init",
        "codePin": None,
        "createdAt": "2026-05-04T12:00:00.000Z",
        "apmLockHash": lock_hash,
        "apmLockfile": APM_LOCKFILE_SOLO,
        "modules": modules,
    }
    id_init = write_snapshot(h, s_init)

    write_text(h / "HEAD", "ref: refs/heads/main\n")
    write_text(h / "refs" / "heads" / "main", id_init + "\n")
    write_text(h / "config", CONFIG_DEFAULT)
    write_text(proj / "READER-COMPAT.md", APM_LOCKFILE_README)


# ─────────────────────────────────────────────────────────────────────────────
# The canonical-id test vector (used in spec/format.md §3)
# ─────────────────────────────────────────────────────────────────────────────

TEST_VECTOR_INPUT = {
    "formatVersion": "0.3",
    "parentIds": ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    "branch": "main",
    "kind": "auto",
    "codePin": "b22e80aa12cc34dd56ee78ff90aabbccddeeff00",
    "createdAt": "2026-04-29T18:20:00.000Z",
    "apmLockHash": None,
    "modules": [
        {
            "type": "chatmode",
            "name": "senior-eng",
            "enabled": True,
            "source": {"kind": "local", "path": ".claude/agents/senior-eng.md"},
        },
        {
            "type": "mcp",
            "name": "postgres",
            "version": "v0.9",
            "enabled": True,
            "source": {"kind": "local", "path": ".claude/settings.json"},
        },
    ],
}


def emit_test_vector_summary() -> None:
    cb = canonical_bytes(_strip_excluded(TEST_VECTOR_INPUT))
    full = hashlib.sha256(cb).hexdigest()
    # Write the byte fixture used by cross-language conformance tests.
    fixture = SPEC_ROOT / "test-vectors" / "canonical-501.bin"
    fixture.parent.mkdir(parents=True, exist_ok=True)
    fixture.write_bytes(cb)
    print("\n=== canonical-id test vector (format.md §3) ===")
    print("canonical_bytes (utf-8 string):")
    print(cb.decode("utf-8"))
    print(f"canonical_bytes length: {len(cb)} bytes")
    print(f"full sha256:    {full}")
    print(f"id (first 40):  {full[:40]}")
    print(f"wrote fixture:  {fixture.relative_to(SPEC_ROOT.parent)}")


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    EXAMPLES.mkdir(parents=True, exist_ok=True)
    build_empty()
    build_solo_no_apm()
    build_solo_with_apm()
    build_team_shared()
    build_compat_fixtures()
    build_compat_session_ctx()
    build_solo_with_apm_lockfile()
    print("Built example harness directories under spec/examples/.")
    emit_test_vector_summary()
