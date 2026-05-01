import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../context.js';
import type { Snapshot } from '../types.js';

export interface UseSnapshotsOpts {
  branch?: string;
  limit?: number;
  /** Bumping this re-pulls from the Store (e.g. App's R-keybind tick). */
  refreshTick?: number;
}

export function useSnapshots(opts?: UseSnapshotsOpts): { snapshots: Snapshot[]; refresh: () => void } {
  const store = useStore();
  const branch = opts?.branch;
  const limit = opts?.limit;
  const tick = opts?.refreshTick ?? 0;
  const [snapshots, setSnapshots] = useState<Snapshot[]>(() =>
    store.snapshots(buildOpts(branch, limit)),
  );
  // Reload whenever the tick changes (App-level R) or filter changes.
  useEffect(() => {
    setSnapshots(store.snapshots(buildOpts(branch, limit)));
  }, [store, branch, limit, tick]);
  const refresh = useCallback(() => {
    store.refresh();
    setSnapshots(store.snapshots(buildOpts(branch, limit)));
  }, [store, branch, limit]);
  return { snapshots, refresh };
}

function buildOpts(branch: string | undefined, limit: number | undefined) {
  const out: { branch?: string; limit?: number } = {};
  if (branch !== undefined) out.branch = branch;
  if (limit !== undefined) out.limit = limit;
  return Object.keys(out).length > 0 ? out : undefined;
}
