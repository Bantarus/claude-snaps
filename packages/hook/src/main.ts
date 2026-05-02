import { Repo, captureCurrentStateFast } from '@harness/core';
import { parseHookArgs, type HookEventName } from './args.js';

/**
 * harness-hook entry point. Records an attribution event for the
 * current `(session_id, hook_event_name)` against the project's
 * `.harness/`. Exits 0 on every code path including caught exceptions
 * (spec/hooks.md §1.5).
 *
 * Flow (spec/hooks.md §2 + §2.4):
 *
 *   1. parseHookArgs (stdin > CLI > env)
 *   2. captureCurrentStateFast → fastHash (mtime/size fingerprint, ~ms)
 *   3. Read session_observation_cache for this session
 *   4. Cache hit (fastHash matches) → appendAttribution against the
 *      cached snapshot id; skip the full walk. NO new snapshot, NO
 *      ref advance, NO cache write (entry is still valid).
 *   5. Cache miss → repo.observe() does the full walk and decides
 *      change-path vs no-change-path internally; then writeObservation
 *      Cache best-effort (separate from the attribution txn — if it
 *      fails or process dies, next fire safely re-walks).
 *
 * The `manual_snap` event kind is reserved for `harness snap`; the
 * hook only fires the `session_start` and `user_prompt` kinds.
 */
export async function run(argv: string[]): Promise<void> {
  let repo: Repo | undefined;
  try {
    const args = parseHookArgs(argv);
    repo = Repo.open(args.cwd);

    const eventKind = eventKindFor(args.hookEventName);

    if (args.dryRun) {
      // Dry-run path: emit a one-line description of what would happen,
      // do not write. Useful for hook smoke tests.
      const fastHash = captureCurrentStateFast(args.cwd);
      const cached = repo.readObservationCache(args.sessionId);
      const hit = cached !== null && cached.fastHash === fastHash;
      process.stdout.write(JSON.stringify({
        sessionId: args.sessionId,
        eventKind,
        cacheHit: hit,
        wouldAttributeTo: hit ? cached!.snapshotId : '<would compute via observe()>',
      }) + '\n');
      return;
    }

    // Hot-path: cheap fingerprint + per-session cache lookup.
    const fastHash = captureCurrentStateFast(args.cwd);
    const cached = repo.readObservationCache(args.sessionId);

    if (cached !== null && cached.fastHash === fastHash) {
      // No change since last fire in this session — short-circuit.
      // Append attribution against the cached snapshot id; do not
      // touch ref, do not write a new blob, do not refresh the cache
      // (the existing entry still points at the right id).
      repo.appendAttribution({
        sessionId: args.sessionId,
        snapshotId: cached.snapshotId,
        eventKind,
        source: args.source ?? null,
      });
      return;
    }

    // Cache miss: do the full work via observe() — composition-change
    // detection happens inside (compares head snapshot's modules to
    // live modules; writes new snapshot only on actual change).
    const snapshotId = repo.observe({
      sessionId: args.sessionId,
      eventKind,
      source: args.source ?? null,
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(args.permissionMode !== undefined ? { permissionMode: args.permissionMode } : {}),
    });

    // Refresh the cache for the next fire. Best-effort: a failure here
    // does NOT undo the attribution; the next fire just full-walks.
    try {
      repo.writeObservationCache(args.sessionId, fastHash, snapshotId);
    } catch (cacheErr) {
      const msg = cacheErr instanceof Error ? cacheErr.message : String(cacheErr);
      process.stderr.write(`harness-hook: warn: cache write failed: ${msg}\n`);
    }
  } catch (err) {
    // Defense in depth: never give the host a non-zero exit.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`harness-hook: error: ${msg}\n`);
  } finally {
    repo?.close();
  }
  process.exit(0);
}

function eventKindFor(name: HookEventName): 'session_start' | 'user_prompt' {
  return name === 'UserPromptSubmit' ? 'user_prompt' : 'session_start';
}
