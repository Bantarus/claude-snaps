import { Repo } from '@harness/core';
import { c } from '../format.js';
import type { ParsedArgs } from '../main.js';

/**
 * `harness sessions [<session-id>]`
 *
 * Without args: list all sessions with trajectory length.
 * With a session id: render that session's trajectory — the
 * (snapshotId, observedAt, eventKind) sequence in chronological order.
 *
 * The trajectory render is the "success criterion" output shape from
 * spec/hooks.md §2 / format.md §2.7: tells you which snapshots a
 * session traversed and when.
 */
export async function cmdSessions(parsed: ParsedArgs): Promise<number> {
  const sessionId = parsed.positional[0];
  const repo = Repo.open(process.cwd());
  try {
    if (sessionId === undefined) {
      // List all sessions present in the attributions table.
      const all = listAllSessions(repo);
      if (all.length === 0) {
        process.stderr.write('(no sessions recorded yet)\n');
        return 0;
      }
      for (const row of all) {
        process.stdout.write(
          `${c.dim(row.firstSeen)}  ${row.sessionId}  ` +
          c.dim(`${row.events} event${row.events === 1 ? '' : 's'}, ` +
                `${row.uniqueSnapshots} snapshot${row.uniqueSnapshots === 1 ? '' : 's'}`) +
          '\n',
        );
      }
      return 0;
    }

    // Render one session's trajectory.
    const traj = repo.trajectoryOf(sessionId);
    if (traj.length === 0) {
      process.stderr.write(`(no events recorded for session ${sessionId})\n`);
      return 1;
    }
    process.stdout.write(`Session ${sessionId} trajectory:\n`);
    let lastSnapshotId: string | null = null;
    for (const ev of traj) {
      const time = c.dim(formatTime(ev.observedAt));
      const kind = formatEventKind(ev.eventKind);
      const source = ev.source !== null ? ` (${ev.source})` : '';
      const snap = c.dim(ev.snapshotId.slice(0, 8));
      const transition = lastSnapshotId === null || lastSnapshotId !== ev.snapshotId
        ? c.add('→') : c.dim('=');
      const blob = repo.snapshot(ev.snapshotId);
      const msg = blob.message ?? c.dim('(no message)');
      process.stdout.write(
        `  ${time}  ${kind}${source}  ${transition} ${snap} ${c.dim(msg.toString().slice(0, 60))}\n`,
      );
      lastSnapshotId = ev.snapshotId;
    }
    const uniqueSnapshots = new Set(traj.map((t) => t.snapshotId)).size;
    const span = msSpan(traj[0]!.observedAt, traj[traj.length - 1]!.observedAt);
    process.stdout.write(
      `\nSpanned ${uniqueSnapshots} snapshot${uniqueSnapshots === 1 ? '' : 's'} ` +
      `over ${span}.\n`,
    );
  } finally {
    repo.close();
  }
  return 0;
}

interface SessionRow {
  sessionId: string;
  firstSeen: string;
  events: number;
  uniqueSnapshots: number;
}

function listAllSessions(repo: Repo): SessionRow[] {
  // Walk every snapshot, accumulate session ids from sessionsAt(). This
  // is O(snapshots × sessions) but the index has snapshot_id-keyed access
  // so each query is fast. For v0.2 this is good enough; v0.3 may add a
  // dedicated query path on the attributions table.
  const seen = new Map<string, { events: number; snaps: Set<string>; firstSeen: string }>();
  for (const snap of repo.log()) {
    for (const sa of repo.sessionsAt(snap.id)) {
      const traj = repo.trajectoryOf(sa.sessionId);
      if (!seen.has(sa.sessionId)) {
        seen.set(sa.sessionId, {
          events: traj.length,
          snaps: new Set(traj.map((t) => t.snapshotId)),
          firstSeen: traj[0]!.observedAt,
        });
      }
    }
  }
  return [...seen.entries()]
    .map(([sessionId, v]) => ({
      sessionId,
      firstSeen: v.firstSeen,
      events: v.events,
      uniqueSnapshots: v.snaps.size,
    }))
    .sort((a, b) => (a.firstSeen < b.firstSeen ? -1 : 1));
}

function formatEventKind(k: string): string {
  switch (k) {
    case 'session_start': return c.bold('session_start');
    case 'user_prompt':   return 'user_prompt';
    case 'manual_snap':   return c.chg('manual_snap');
    case 'migrated':      return c.dim('migrated');
    default:              return k;
  }
}

function formatTime(iso: string): string {
  // 2026-05-02T12:04:18.000Z → 12:04:18
  const m = iso.match(/T(\d{2}:\d{2}:\d{2})/);
  return m !== null ? m[1]! : iso;
}

function msSpan(fromIso: string, toIso: string): string {
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return `${m}m${s}s`;
  const h = Math.floor(m / 60), mm = m % 60;
  return `${h}h${mm}m${s}s`;
}
