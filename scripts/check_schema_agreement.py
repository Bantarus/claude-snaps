"""
Cross-check that SQL CHECK constraint and JSON Schema agree on what
values for `source.kind` are acceptable.

The two schemas describe the SAME data from different angles:
  - schema/001_init.sql `snapshot_modules.source_kind` CHECK
  - schema/snapshot.schema.json $defs.ModuleSource.oneOf[*].properties.kind

If they disagree, a snapshot blob can pass JSON Schema validation and
then fail SQL insertion (or vice versa) — silent corruption of the
script-as-load-bearing property described in spec/README.md.

This script exits non-zero on any disagreement. Run it whenever either
schema changes.
"""

import json
import os
import sqlite3
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SQL = os.path.join(ROOT, "spec", "schema", "001_init.sql")
JSCH = os.path.join(ROOT, "spec", "schema", "snapshot.schema.json")


def _setup_sql():
    conn = sqlite3.connect(":memory:")
    with open(SQL) as f:
        conn.executescript(f.read())
    conn.execute(
        "INSERT INTO snapshots(id,branch,kind,message,created_at) VALUES "
        "('0000000000000000000000000000000000000000','main','init','x',"
        "'2026-01-01T00:00:00.000Z')"
    )
    return conn


def _sql_accepts(conn, kind, idx):
    try:
        conn.execute(
            "INSERT INTO snapshot_modules "
            "(snapshot_id,position,type,name,enabled,source_kind) VALUES "
            "('0000000000000000000000000000000000000000', ?, 'mcp','x', 1, ?)",
            (idx, kind),
        )
        return True
    except sqlite3.IntegrityError:
        return False


def _setup_jsonschema():
    from jsonschema import Draft202012Validator

    with open(JSCH) as f:
        schema = json.load(f)
    return Draft202012Validator(schema)


def _schema_accepts(v, kind):
    if kind == "builtin":
        src = {"kind": kind}
    elif kind == "apm":
        src = {"kind": kind, "package": "a/b", "resolvedCommit": "a" * 40, "depth": 1}
    elif kind == "local":
        src = {"kind": kind, "path": "a/b"}
    else:
        src = {"kind": kind, "opaque": "whatever"}
    blob = {
        "id": "a" * 40, "parentIds": [], "branch": "main", "kind": "init",
        "message": "x", "codePin": None, "createdAt": "2026-01-01T00:00:00.000Z",
        "apmLockHash": None,
        "modules": [{"type": "mcp", "name": "n", "enabled": True, "source": src}],
    }
    from jsonschema import Draft202012Validator
    return len(list(v.iter_errors(blob))) == 0


# Cases the spec rules MUST agree on. Add a row whenever either schema
# is touched. Pairs are (kind, expected_acceptance).
CASES = [
    # canonical kinds
    ("apm",          True),
    ("local",        True),
    ("builtin",      True),
    # well-formed extensions
    ("x-foo",        True),
    ("x-foo.bar",    True),
    ("x-a",          True),
    ("x-1",          True),
    ("x-A-Z",        True),
    ("x-_-.",        True),
    # ill-formed extensions
    ("x-",           False),  # empty namespace
    ("x-foo!bar",    False),  # invalid char
    ("x-foo bar",    False),  # space
    ("x-foo/bar",    False),  # slash
    ("x-é",          False),  # non-ASCII
    # not-an-extension
    ("xfoo",         False),  # no dash
    ("y-foo",        False),  # wrong prefix
    ("",             False),  # empty
]


def main() -> int:
    conn = _setup_sql()
    v = _setup_jsonschema()

    print(f'{"kind":18s}  {"SQL":5s}  {"JSON":5s}  {"expect":6s}  result')
    rc = 0
    for i, (kind, expected) in enumerate(CASES):
        s = _sql_accepts(conn, kind, i)
        j = _schema_accepts(v, kind)
        ok = (s == j == expected)
        flag = "ok" if ok else "FAIL"
        if not ok:
            rc = 1
        print(f"{repr(kind):18s}  {str(s):5s}  {str(j):5s}  {str(expected):6s}  {flag}")
    if rc == 0:
        print(f"\nAll {len(CASES)} cases agree across SQL CHECK and JSON Schema.")
    else:
        print("\nAGREEMENT FAILURE — SQL CHECK and JSON Schema have drifted.")
    return rc


if __name__ == "__main__":
    sys.exit(main())
