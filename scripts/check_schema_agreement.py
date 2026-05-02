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
SQL_001 = os.path.join(ROOT, "spec", "schema", "001_init.sql")
SQL_002 = os.path.join(ROOT, "spec", "schema", "002_v0_2_decoupling.sql")
JSCH = os.path.join(ROOT, "spec", "schema", "snapshot.schema.json")


def _setup_sql():
    """Apply 001 then 002 to a fresh in-memory DB. Tests run against
    the post-migration v2 schema — the actual shape clients will see."""
    conn = sqlite3.connect(":memory:")
    with open(SQL_001) as f:
        conn.executescript(f.read())
    with open(SQL_002) as f:
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


def _check_snapshot_kind_agreement(conn, validator) -> tuple[int, int]:
    """Verify snapshot.kind enum agrees between SQL CHECK and JSON Schema
    after the v0.2.0 migration. Returns (passed, failed)."""
    cases = [
        ("init",   True),
        ("manual", True),
        ("tag",    True),
        # legacy v0.1.x kinds — must be rejected by both post-migration
        ("auto",   False),
        ("edit",   False),
        ("fork",   False),
        ("",       False),
    ]
    print(f'\n{"snapshot.kind":18s}  {"SQL":5s}  {"JSON":5s}  {"expect":6s}  result')
    passed = failed = 0
    for kind_val, expected in cases:
        try:
            conn.execute(
                "INSERT INTO snapshots(id,branch,kind,message,created_at) VALUES "
                "(?, 'main', ?, 'x', '2026-01-01T00:00:00.000Z')",
                (kind_val * 4 + "a" * (40 - len(kind_val) * 4), kind_val),
            )
            sql_ok = True
        except sqlite3.IntegrityError:
            sql_ok = False
        # JSON schema check: build a blob with this kind, validate
        blob = {
            "id": "a" * 40, "parentIds": [] if kind_val == "init" else ["b" * 40],
            "branch": "main", "kind": kind_val, "message": "x",
            "codePin": None, "createdAt": "2026-01-01T00:00:00.000Z",
            "apmLockHash": None, "modules": [],
        }
        if kind_val == "tag":
            blob["version"] = "v1"
        json_ok = len(list(validator.iter_errors(blob))) == 0
        ok = (sql_ok == json_ok == expected)
        flag = "ok" if ok else "FAIL"
        if ok: passed += 1
        else:  failed += 1
        print(f"{repr(kind_val):18s}  {str(sql_ok):5s}  {str(json_ok):5s}  {str(expected):6s}  {flag}")
    return passed, failed


def _check_attribution_table(conn) -> tuple[int, int]:
    """Verify the attributions table exists with the expected event_kind
    CHECK and the composite primary key. Returns (passed, failed)."""
    print(f'\n{"attribution check":34s}  result')
    passed = failed = 0
    accept_cases = [
        ("session_start", True),
        ("user_prompt",   True),
        ("manual_snap",   True),
        ("migrated",      True),
        ("bogus",         False),
        ("",              False),
    ]
    # Need a snapshot row to satisfy the FK
    conn.execute(
        "INSERT OR IGNORE INTO snapshots(id,branch,kind,message,created_at) VALUES "
        "('1111111111111111111111111111111111111111','main','manual','x',"
        "'2026-01-02T00:00:00.000Z')"
    )
    for i, (kind_val, expected) in enumerate(accept_cases):
        try:
            conn.execute(
                "INSERT INTO attributions(session_id, snapshot_id, observed_at, event_kind, source) "
                "VALUES (?, '1111111111111111111111111111111111111111', ?, ?, NULL)",
                (f"sess-{i}", f"2026-01-02T00:00:0{i}.000Z", kind_val),
            )
            ok_insert = True
        except sqlite3.IntegrityError:
            ok_insert = False
        ok = (ok_insert == expected)
        flag = "ok" if ok else "FAIL"
        label = f"event_kind={kind_val!r}"
        if ok: passed += 1
        else:  failed += 1
        print(f"{label:34s}  {flag}")
    return passed, failed


def main() -> int:
    conn = _setup_sql()
    v = _setup_jsonschema()

    print(f'{"source.kind":18s}  {"SQL":5s}  {"JSON":5s}  {"expect":6s}  result')
    rc = 0
    pass_total = fail_total = 0
    for i, (kind, expected) in enumerate(CASES):
        s = _sql_accepts(conn, kind, i)
        j = _schema_accepts(v, kind)
        ok = (s == j == expected)
        flag = "ok" if ok else "FAIL"
        if ok: pass_total += 1
        else:  fail_total += 1; rc = 1
        print(f"{repr(kind):18s}  {str(s):5s}  {str(j):5s}  {str(expected):6s}  {flag}")

    p, f = _check_snapshot_kind_agreement(conn, v)
    pass_total += p
    fail_total += f
    if f: rc = 1

    p, f = _check_attribution_table(conn)
    pass_total += p
    fail_total += f
    if f: rc = 1

    print(f"\nTotal: {pass_total} passed, {fail_total} failed.")
    if rc == 0:
        print("All cases agree across SQL CHECK and JSON Schema (post-002 v0.2.0 schema).")
    else:
        print("AGREEMENT FAILURE — SQL CHECK and JSON Schema have drifted.")
    return rc


if __name__ == "__main__":
    sys.exit(main())
