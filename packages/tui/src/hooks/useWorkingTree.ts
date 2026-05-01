import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../context.js';
import type { WorkingTree } from '../types.js';

/**
 * Refreshes on every mount per pin #3. The Editor screen re-mounts when
 * the user navigates to it, so a fresh `captureCurrentState()` runs each
 * time. No caching across navigations.
 */
export function useWorkingTree(refreshTick = 0): { tree: WorkingTree; refresh: () => void } {
  const store = useStore();
  const [tree, setTree] = useState<WorkingTree>(() => store.workingTree());
  useEffect(() => {
    setTree(store.workingTree());
  }, [store, refreshTick]);
  const refresh = useCallback(() => setTree(store.workingTree()), [store]);
  return { tree, refresh };
}
