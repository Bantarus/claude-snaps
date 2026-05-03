import { Repo, summarizeDiff } from '@harness/core';
import { c } from '../format.js';
import type { ParsedArgs } from '../main.js';

/**
 * `harness sessions [<session-id>]`
 *
 * Without args: list all sessions with trajectory length.
 * With a session id: render that session's trajectory — the
 * (snapshotId, observedAt, eventKind, noteText?) sequence in
 * chronological order.
 *
 * The trajectory render is the load-bearing query (Q1) from
 * spec/format.md §2.7 / §5.4: tells you which snapshots a session
 * traversed, when, with any user notes inline.
 *
 * Visual conventions in the trajectory:
 *   →  composition transition (arrived at a new snapshot)
 *   =  unchanged composition (still on the same snapshot)
 *   @  note attached to the current snapshot
 */
export async function cmdSessions(parsed: ParsedArgs): Promise<number> {
  const sessionId = parsed.positional[0];
  const repo = Repo.open(process.cwd());
  try {
    if (sessionId === undefined) {
      const all = listAllSessions(repo);
      if (all.length === 0) {
        process.stderr.write('(no sessions recorded yet)\n');
        return 0;
      }
      for (const row of all) {
        const noteSuffix = row.notes > 0
          ? ', ' + c.add(`${row.notes} note${row.notes === 1 ? '' : 's'}`)
          : '';
        process.stdout.write(
          `${c.dim(row.firstSeen)}  ${row.sessionId}  ` +
          c.dim(`${row.events} event${row.events === 1 ? '' : 's'}, ` +
                `${row.uniqueSnapshots} snapshot${row.uniqueSnapshots === 1 ? '' : 's'}`) +
          noteSuffix + '\n',
        );
      }
      return 0;
    }

    const traj = repo.trajectoryOf(sessionId);
    if (traj.length === 0) {
      process.stderr.write(`(no events recorded for session ${sessionId})\n`);
      return 1;
    }
    process.stdout.write(`Session ${sessionId} trajectory:\n`);
    let lastSnapshotId: string | null = null;
    let noteCount = 0;
    for (const ev of traj) {
      const time = c.dim(formatTime(ev.observedAt));
      const kind = formatEventKind(ev.eventKind);
      const source = ev.source !== null ? ` (${ev.source})` : '';
      const snap = c.dim(ev.snapshotId.slice(0, 8));

      if (ev.eventKind === 'note') {
        // Note row — `@` marker, verbatim text (truncated for one-line render).
        const text = ev.noteText ?? '';
        const truncated = text.length > 80 ? text.slice(0, 79) + '…' : text;
        process.stdout.write(
          `  ${time}  ${kind}${source}  ${c.add('@')} ${snap} "${truncated}"\n`,
        );
        noteCount++;
      } else {
        // Observation row — `→` (transition) or `=` (no change).
        const transition = lastSnapshotId === null || lastSnapshotId !== ev.snapshotId
          ? c.add('→') : c.dim('=');
        // For transitions, derive a short summary from the snapshot vs
        // its parent. For unchanged rows, leave it blank.
        let summary = '';
        if (lastSnapshotId === null || lastSnapshotId !== ev.snapshotId) {
          const blob = repo.snapshot(ev.snapshotId);
          const parentBlob = blob.parentIds.length > 0 ? repo.snapshot(blob.parentIds[0]!) : null;
          summary = ' ' + c.dim(`(${summarizeDiff(parentBlob?.modules ?? null, blob.modules)})`);
        }
        process.stdout.write(
          `  ${time}  ${kind}${source}  ${transition} ${snap}${summary}\n`,
        );
        lastSnapshotId = ev.snapshotId;
      }
    }
    const uniqueSnapshots = new Set(traj.map((t) => t.snapshotId)).size;
    const span = msSpan(traj[0]!.observedAt, traj[traj.length - 1]!.observedAt);
    const noteTail = noteCount > 0
      ? `; ${noteCount} user note${noteCount === 1 ? '' : 's'}` : '';
    process.stdout.write(
      `\nSpanned ${uniqueSnapshots} snapshot${uniqueSnapshots === 1 ? '' : 's'} ` +
      `over ${span}${noteTail}.\n`,
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
  notes: number;
}

function listAllSessions(repo: Repo): SessionRow[] {
  const seen = new Map<
    string,
    { events: number; snaps: Set<string>; firstSeen: string; notes: number }
  >();
  for (const snap of repo.log()) {
    for (const sa of repo.sessionsAt(snap.id)) {
      if (seen.has(sa.sessionId)) continue;
      const traj = repo.trajectoryOf(sa.sessionId);
      seen.set(sa.sessionId, {
        events: traj.length,
        snaps: new Set(traj.map((t) => t.snapshotId)),
        firstSeen: traj[0]!.observedAt,
        notes: traj.filter((t) => t.eventKind === 'note').length,
      });
    }
  }
  return [...seen.entries()]
    .map(([sessionId, v]) => ({
      sessionId,
      firstSeen: v.firstSeen,
      events: v.events,
      uniqueSnapshots: v.snaps.size,
      notes: v.notes,
    }))
    .sort((a, b) => (a.firstSeen < b.firstSeen ? -1 : 1));
}

function formatEventKind(k: string): string {
  switch (k) {
    case 'session_start':  return c.bold('session_start');
    case 'user_prompt':    return 'user_prompt';
    case 'manual_capture': return c.chg('manual_capture');
    case 'note':           return c.add('note');
    case 'migrated':       return c.dim('migrated');
    default:               return k;
  }
}

function formatTime(iso: string): string {
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
