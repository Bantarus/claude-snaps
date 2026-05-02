#!/usr/bin/env python3
"""
Mechanical detection of major-bump-masquerading-as-minor changes.

Compares the current spec schemas against the previous git revision
(HEAD by default; CHECK_AGAINST=<ref> overrides) and flags changes
that violate spec/format.md §9.3:

  - Additions to a closed enum (`enum:` in JSON Schema; `IN (...)` in
    SQL CHECK) — these require a major bump or an `x-` extension.
  - Additions to the `required` array in a JSON Schema — same rule.
  - Removals from `enum:` or `required:` — same rule.
  - Field renames or type changes in JSON Schema property definitions.

Removals from `required:` are not flagged (a field becoming optional
is reader-compatible if v0.1.0 readers preserve unknowns, which §9.2
mandates).

Exit code is 0 if the diff is minor-bump-safe (or there is no diff to
the spec schemas at all). Exit code 1 with a human-readable explanation
otherwise. The `harness-spec-amend` skill includes this script in its
walk; CI configurations should run it on every PR that touches `spec/`.

Usage:
    python3 scripts/check_format_version_bump.py [--against <git-ref>]
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Iterable, Iterator

REPO_ROOT = Path(__file__).resolve().parent.parent
SCHEMA_FILES = [
    "spec/schema/snapshot.schema.json",
    "spec/schema/config.schema.json",
]
SQL_FILE = "spec/schema/001_init.sql"


# ─── git plumbing ────────────────────────────────────────────────────────────

def show_at_ref(path: str, ref: str) -> str | None:
    """Return file contents at `ref`, or None if file didn't exist there."""
    try:
        out = subprocess.run(
            ["git", "show", f"{ref}:{path}"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        if out.returncode != 0:
            return None
        return out.stdout
    except FileNotFoundError:
        return None


def read_current(path: str) -> str | None:
    p = REPO_ROOT / path
    if not p.exists():
        return None
    return p.read_text(encoding="utf-8")


# ─── JSON Schema shape walker ────────────────────────────────────────────────

def walk_enums(node: object, breadcrumbs: list[str]) -> Iterator[tuple[str, list[str]]]:
    """Yield (path, enum-values-as-list-of-strings) for every `enum:` array."""
    if isinstance(node, dict):
        if "enum" in node and isinstance(node["enum"], list):
            yield (".".join(breadcrumbs) or "<root>", [str(v) for v in node["enum"]])
        if "const" in node:
            # Treat const as a single-value enum so additions to a oneOf
            # discriminated by const get caught.
            yield (
                ".".join(breadcrumbs) or "<root>",
                [f"const:{node['const']}"],
            )
        for k, v in node.items():
            if k in ("enum", "const"):
                continue
            yield from walk_enums(v, breadcrumbs + [k])
    elif isinstance(node, list):
        for i, item in enumerate(node):
            yield from walk_enums(item, breadcrumbs + [f"[{i}]"])


def walk_required(node: object, breadcrumbs: list[str]) -> Iterator[tuple[str, set[str]]]:
    """Yield (path, set-of-required-field-names) for every `required:` array."""
    if isinstance(node, dict):
        if "required" in node and isinstance(node["required"], list):
            yield (".".join(breadcrumbs) or "<root>", set(str(v) for v in node["required"]))
        for k, v in node.items():
            if k == "required":
                continue
            yield from walk_required(v, breadcrumbs + [k])
    elif isinstance(node, list):
        for i, item in enumerate(node):
            yield from walk_required(item, breadcrumbs + [f"[{i}]"])


def walk_properties(node: object, breadcrumbs: list[str]) -> Iterator[tuple[str, dict[str, object]]]:
    """Yield (path, properties-dict) for every `properties:` object."""
    if isinstance(node, dict):
        if "properties" in node and isinstance(node["properties"], dict):
            yield (".".join(breadcrumbs) or "<root>", dict(node["properties"]))
        for k, v in node.items():
            if k == "properties":
                continue
            yield from walk_properties(v, breadcrumbs + [k])
    elif isinstance(node, list):
        for i, item in enumerate(node):
            yield from walk_properties(item, breadcrumbs + [f"[{i}]"])


# ─── SQL CHECK enum extraction ───────────────────────────────────────────────

CHECK_IN_RE = re.compile(
    r"CHECK\s*\(\s*\w+\s+IN\s*\(([^)]*)\)",
    re.IGNORECASE,
)


def sql_check_enums(sql: str) -> dict[str, set[str]]:
    """
    Extract `CHECK (col IN ('a','b',...))` enum sets.

    Returns {column_name: {value, ...}}. Only matches the simple `IN (...)`
    form; the OR-conjunction patterns (e.g. the source_kind extension
    branch) aren't covered — those are exercised by the schema-agreement
    test instead.
    """
    out: dict[str, set[str]] = {}
    pat = re.compile(
        r"(\w+)\s+TEXT[^,]*CHECK\s*\(\s*\1\s+IN\s*\(([^)]*)\)",
        re.IGNORECASE,
    )
    for m in pat.finditer(sql):
        col = m.group(1)
        values = re.findall(r"'([^']+)'", m.group(2))
        out[col] = set(values)
    return out


# ─── verdict ─────────────────────────────────────────────────────────────────

def diff_json_schema(old_text: str, new_text: str, label: str) -> list[str]:
    """Return human-readable major-bump findings for a JSON Schema diff."""
    findings: list[str] = []
    old = json.loads(old_text)
    new = json.loads(new_text)

    # Enum + const values aggregated across the whole file. This collapses
    # `oneOf` array reordering (a removed variant shifts later indices,
    # which a path-keyed comparison would report as both "gained" and
    # "lost" at different indices). The §9.3 rule cares about the value
    # set, not the JSON shape — what's the union of allowed values, did
    # it grow or shrink?
    old_values: set[str] = set()
    for _, vs in walk_enums(old, []): old_values.update(vs)
    new_values: set[str] = set()
    for _, vs in walk_enums(new, []): new_values.update(vs)
    added = new_values - old_values
    removed = old_values - new_values
    if added:
        findings.append(
            f"  {label}: enum/const value(s) gained {sorted(added)} — "
            f"§9.3 requires a major bump (or `x-` prefix)."
        )
    if removed:
        findings.append(
            f"  {label}: enum/const value(s) lost {sorted(removed)} — "
            f"§9.3 requires a major bump."
        )

    # Required additions. New required fields are major-bump-only.
    old_req: set[str] = set()
    for _, vs in walk_required(old, []): old_req.update(vs)
    new_req: set[str] = set()
    for _, vs in walk_required(new, []): new_req.update(vs)
    added_req = new_req - old_req
    if added_req:
        findings.append(
            f"  {label}: required field(s) gained {sorted(added_req)} — "
            f"§9.3 requires a major bump."
        )

    # Property type changes. Detect `type:` mutations on existing keys.
    old_props = {p: v for p, v in walk_properties(old, [])}
    new_props = {p: v for p, v in walk_properties(new, [])}
    for path, props in new_props.items():
        prior = old_props.get(path, {})
        for key, schema in props.items():
            prior_schema = prior.get(key)
            if prior_schema is None:
                continue  # new properties are minor-bump-allowed if optional
            if isinstance(schema, dict) and isinstance(prior_schema, dict):
                if "type" in schema and "type" in prior_schema and \
                        schema["type"] != prior_schema["type"]:
                    findings.append(
                        f"  {label} {path}.{key}: type changed "
                        f"{prior_schema['type']!r} → {schema['type']!r} — "
                        f"§9.3 requires a major bump."
                    )

    return findings


def diff_sql_enums(old_text: str, new_text: str) -> list[str]:
    findings: list[str] = []
    old = sql_check_enums(old_text)
    new = sql_check_enums(new_text)
    for col, values in new.items():
        old_values = old.get(col, set())
        added = values - old_values
        removed = old_values - values
        if added:
            findings.append(
                f"  SQL CHECK {col}: enum gained {sorted(added)} — "
                f"§9.3 requires a major bump."
            )
        if removed:
            findings.append(
                f"  SQL CHECK {col}: enum lost {sorted(removed)} — "
                f"§9.3 requires a major bump."
            )
    return findings


def detect_major_bump(old_text: str | None, new_text: str | None) -> tuple[str, str] | None:
    """If snapshot.schema.json's formatVersion.default changed at all
    (e.g. "0.1" → "0.2", or "0.2" → "1.0"), return (old_default,
    new_default). Otherwise None.

    Note: in this spec's terminology a 0.1 → 0.2 transition is a
    major-bump-shape change per format.md §9.3 (even though §9.1 calls
    both "same major (0.x)"). Any deliberate change to the default IS
    the bump declaration; partial changes (e.g. patching "0.1" → "0.1.1"
    when the schema is otherwise additive-optional) are not interesting
    for this detector — minor bumps don't have findings to begin with.
    """
    if old_text is None or new_text is None:
        return None
    try:
        old = json.loads(old_text)
        new = json.loads(new_text)
    except json.JSONDecodeError:
        return None
    old_default = old.get("properties", {}).get("formatVersion", {}).get("default")
    new_default = new.get("properties", {}).get("formatVersion", {}).get("default")
    if not isinstance(old_default, str) or not isinstance(new_default, str):
        return None
    if old_default != new_default:
        return (old_default, new_default)
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--against",
        default="HEAD",
        help="Git ref to diff against (default: HEAD).",
    )
    args = parser.parse_args()
    ref: str = args.against

    findings: list[str] = []
    checked: list[str] = []

    snapshot_old = show_at_ref("spec/schema/snapshot.schema.json", ref)
    snapshot_new = read_current("spec/schema/snapshot.schema.json")
    declared_major_bump = detect_major_bump(snapshot_old, snapshot_new)

    for path in SCHEMA_FILES:
        old = show_at_ref(path, ref)
        new = read_current(path)
        if old is None or new is None:
            continue
        if old == new:
            continue
        checked.append(path)
        try:
            findings.extend(diff_json_schema(old, new, path))
        except json.JSONDecodeError as e:
            findings.append(f"  {path}: parse error ({e})")

    sql_old = show_at_ref(SQL_FILE, ref)
    sql_new = read_current(SQL_FILE)
    if sql_old is not None and sql_new is not None and sql_old != sql_new:
        checked.append(SQL_FILE)
        findings.extend(diff_sql_enums(sql_old, sql_new))

    if not checked:
        print("✓ no spec schema changes detected vs", ref)
        return 0

    print(f"checked {len(checked)} file(s) vs {ref}: " + ", ".join(checked))
    if not findings:
        print("✓ minor-bump-safe — additions appear additive-optional only.")
        return 0

    if declared_major_bump is not None:
        old_v, new_v = declared_major_bump
        print()
        print(f"✓ declared major bump: formatVersion default {old_v!r} → {new_v!r}")
        print("  Findings below are expected for this major bump (informational):")
        for f in findings:
            print(f)
        print()
        print("If this matches the change you intended, all good. If a finding")
        print("looks unrelated to the declared bump, surface it before merging.")
        return 0

    print()
    print("✗ major-bump indicators found (spec/format.md §9.3):")
    for f in findings:
        print(f)
    print()
    print("If this is intentional (a real major bump), bump")
    print("snapshot.schema.json's formatVersion.default to a new major")
    print("(e.g. \"0.1\" → \"0.2\") and document the bump in spec/format.md §9.5.")
    print("If it is not, back out the change or move it under an `x-` extension.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
