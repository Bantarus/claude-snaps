# `@harness/cli`

The `harness` command-line interface for the [`.harness/`](../../spec/format.md)
agent-harness snapshot format. Implementation of the v0.4 format
spec; canonical bytes derivation lives in
[`@harness/core`](../core/).

## Commands

```
harness init [--branch=<name>]                  Initialize a new .harness/ in cwd.
harness log [--branch=<name>] [--limit=N]
            [--with-sessions]                   List snapshots, newest first.
harness diff <a> <b>                            Diff two snapshots' modules.
harness snap "<note>"                           Capture + attach a note.
harness sessions [<session-id>]                 List sessions or one trajectory.
harness notes <snapshot-ref>                    All notes attached to a snapshot.
harness tag <name> [<id>] [--force]             Tag a snapshot.
harness branch <name> [<id>] [--force]          Create a branch.
harness checkout <ref>                          Move HEAD; warns on divergence.
harness reproduce <ref> [--dry-run]             Materialize via APM, subtractively.
harness reindex                                 Rebuild lineage.sqlite.
harness install-hook [--force]                  Wire the SessionStart hook.
```

Refs accept: 40-hex id, 6+-hex prefix, `HEAD`, branch name, tag name.

## `harness reproduce` and backups

`harness reproduce` is APM-driven and **subtractive within scope**
(spec/format.md §6.1). On every invocation it:

1. Backs up `.claude/` to `.claude.harness-backup-<ISO timestamp>/`.
   The backup is unconditional and not auto-deleted — it is the
   safety net for the subtractive contract.
2. Writes the snapshot's recorded `apmLockfile` to `apm.lock.yaml`
   (or removes the lockfile if the snapshot recorded no APM state).
3. Runs `apm install --force` to materialize APM-managed modules.
4. Removes APM-managed paths under `.claude/` that aren't in the
   target snapshot's scope.
5. Verifies each APM-source module's `configHash`.
6. Advances HEAD on success.

### Backup cleanup

Backups accumulate at `<project-root>/.claude.harness-backup-*/`
across reproduce invocations. The CLI does NOT auto-prune them; that
would defeat the safety guarantee. Clean periodically with:

```bash
# Inspect first — identify backups you no longer need.
ls -dh .claude.harness-backup-*

# When sure, remove the ones you don't need:
rm -rf .claude.harness-backup-2026-05-04T12-*
```

A user-initiated `harness reproduce --cleanup-backups` command is on
the v0.5 backlog; for v0.4.x the recommendation is manual file
management with file-system tools.

## Exit codes

- `0` — success.
- `1` — recoverable user error (apm not installed, install failed,
  configHash mismatch, ref unknown, divergence detected).
- `2` — internal error.
