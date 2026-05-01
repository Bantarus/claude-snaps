import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../context.js';
import type { Session, TraceEvent } from '../types.js';

export interface UseSessionResult {
  session: Session;
  trace: TraceEvent[] | null;
  traceError: Error | null;
}

/**
 * Loads a session synchronously from the Store, then asynchronously
 * reads the trace JSONL (pin #7). The cancelled flag matters: if the
 * user navigates away mid-load, the resolved promise must NOT call
 * setState on an unmounted component.
 */
export function useSession(id: string): UseSessionResult {
  const store = useStore();
  const sessionWithLoader = useMemo(() => store.session(id), [store, id]);
  const [trace, setTrace] = useState<TraceEvent[] | null>(null);
  const [traceError, setTraceError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTrace(null);
    setTraceError(null);
    sessionWithLoader.loadTrace()
      .then((t) => { if (!cancelled) setTrace(t); })
      .catch((e: unknown) => {
        if (!cancelled) setTraceError(e instanceof Error ? e : new Error(String(e)));
      });
    return () => { cancelled = true; };
  }, [sessionWithLoader]);

  // The Session result drops loadTrace from its public shape — callers
  // get a plain Session and the trace state separately.
  const session: Session = {
    id: sessionWithLoader.id,
    snapshotId: sessionWithLoader.snapshotId,
    message: sessionWithLoader.message,
    startLabel: sessionWithLoader.startLabel,
    durationLabel: sessionWithLoader.durationLabel,
    status: sessionWithLoader.status,
    filesTouched: sessionWithLoader.filesTouched,
    trace: trace ?? [],
    ...(sessionWithLoader.pr !== undefined ? { pr: sessionWithLoader.pr } : {}),
    ...(sessionWithLoader.author !== undefined ? { author: sessionWithLoader.author } : {}),
  };

  return { session, trace, traceError };
}
