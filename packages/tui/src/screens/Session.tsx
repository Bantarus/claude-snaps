import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Frame } from '../components/Frame.js';
import { Tabs } from '../components/Tabs.js';
import { Glyph } from '../components/Glyph.js';
import { DeferredAction } from '../components/DeferredAction.js';
import { T } from '../theme.js';
import { useStore } from '../context.js';
import { useSession } from '../hooks/useSession.js';
import { useSnapshots } from '../hooks/useSnapshots.js';
import type { TraceKind } from '../types.js';
import type { Goto } from '../app.js';

interface Props {
  goto: Goto;
  sessionId?: string;
}

const TRACE_COLORS: Record<TraceKind, string> = {
  user: T.fg,
  hook: T.hook,
  persona: T.persona,
  tool: T.mcp,
  skill: T.skill,
  ok: T.persona,
};

function pad(s: string, w: number) {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function trunc(s: string, w: number) {
  return s.length <= w ? s : s.slice(0, w - 1) + '…';
}

export const SessionDetail: React.FC<Props> = ({ goto, sessionId }) => {
  const store = useStore();
  const { snapshots } = useSnapshots();

  // If no specific session was selected, fall back to the most recent
  // session-bearing snapshot. Predictable starting point per pin #5.
  const fallbackId = useMemo(() => {
    const found = snapshots.find((s) => s.sessionId !== undefined);
    return found?.sessionId;
  }, [snapshots]);

  const effectiveId = sessionId ?? fallbackId;

  if (effectiveId === undefined) {
    return (
      <Frame
        active="Sessions"
        keys={[{ k: 'esc', l: 'back' }]}
        right="sessions"
      >
        <Box paddingX={1}>
          <Text color={T.faint}>
            No sessions yet. Auto-snapshots from `harness-hook` will appear here
            once Claude Code runs in this project.
          </Text>
        </Box>
      </Frame>
    );
  }

  return <SessionView goto={goto} sessionId={effectiveId} store={store} />;
};

interface ViewProps {
  goto: Goto;
  sessionId: string;
  store: ReturnType<typeof useStore>;
}

const SessionView: React.FC<ViewProps> = ({ goto, sessionId, store }) => {
  const { session, trace, traceError } = useSession(sessionId);
  const [traceSel, setTraceSel] = useState(0);
  const [deferred, setDeferred] = useState<string | null>(null);

  const snap = useMemo(() => {
    try {
      return store.snapshot(session.snapshotId);
    } catch {
      return null;
    }
  }, [store, session.snapshotId]);

  useInput((input, key) => {
    const len = trace?.length ?? 0;
    if (key.upArrow) setTraceSel((i) => Math.max(0, i - 1));
    if (key.downArrow) setTraceSel((i) => Math.min(Math.max(0, len - 1), i + 1));
    if (key.escape) goto('Lineage');
    if (input === 'r') setDeferred('[r] reproduce');
    if (input === 'f') setDeferred('[f] fork');
    if (input === 'B') setDeferred('[B] bisect');
    if (input === 'p') setDeferred('[p] publish');
  });

  const traceLoading = trace === null && traceError === null;

  return (
    <Frame
      active="Sessions"
      keys={[
        { k: 'tab', l: 'pane' },
        { k: '↑↓', l: 'step' },
        { k: 'r', l: 'reproduce' },
        { k: 'f', l: 'fork' },
        { k: 'B', l: 'bisect' },
        { k: 'p', l: 'publish' },
        { k: 'esc', l: 'back' },
      ]}
      right={
        traceLoading
          ? 'loading trace…'
          : trace !== null && trace.length > 0
            ? `trace ${traceSel + 1}/${trace.length}`
            : 'trace 0/0'
      }
    >
      <Box>
        <Text>
          <Text color={T.dim}>harness ❯ sessions ❯ </Text>
          <Text color={T.fg} bold>{snap?.id ?? session.snapshotId} · {session.message}</Text>
          <Text color={T.dim}>{'   '}{session.startLabel}</Text>
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text>
          {snap?.version !== undefined && (
            <Text backgroundColor={T.hook} color={T.selFg} bold>
              {' '}harness {snap.version}{' '}
            </Text>
          )}
          <Text>{'  '}</Text>
          <Text color={T.faint}>code </Text>
          <Text color={T.fg}>{snap?.codePin ?? '—'}</Text>
          <Text>{'  '}</Text>
          <Text color={T.faint}>session </Text>
          <Text color={T.fg}>{session.id.slice(0, 8)}</Text>
        </Text>
      </Box>

      <Tabs
        tabs={['Trace', 'Snapshot', 'Files', 'Tools', 'Re-run']}
        active="Trace"
      />

      <Box flexDirection="row" marginTop={1} gap={1} flexGrow={1}>
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={T.dim}
          paddingX={1}
          flexBasis="50%"
          flexShrink={1}
        >
          <Text color={T.dim}>trace</Text>
          {traceLoading && <Text color={T.faint}>loading trace…</Text>}
          {traceError !== null && (
            <Text color={T.rm}>error: {trunc(traceError.message, 50)}</Text>
          )}
          {trace !== null && trace.length === 0 && (
            <Text color={T.faint}>
              (no trace recorded — JSONL not found at the expected path,
              or this session pre-dates the harness hook)
            </Text>
          )}
          {trace !== null && trace.map((row, i) => {
            const isSel = i === traceSel;
            return (
              <Text key={i}>
                {isSel ? (
                  <Text color={T.sel} bold>❯</Text>
                ) : (
                  <Text color={T.dim}>│</Text>
                )}
                <Text color={T.faint}> {row.t} </Text>
                <Text color={TRACE_COLORS[row.kind]} bold>
                  {pad(row.kind, 8)}
                </Text>
                <Text color={T.fg}>{trunc(row.message, 60)}</Text>
              </Text>
            );
          })}
        </Box>

        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={T.dim}
          paddingX={1}
          flexBasis="50%"
          flexShrink={1}
        >
          <Text>
            <Text color={T.dim}>harness snapshot · </Text>
            <Text color={T.fg} bold>{snap?.id ?? '—'}</Text>
          </Text>
          {snap?.modules.map((m, i) => (
            <Text key={i}>
              <Text color={T.faint}>{pad(m.type, 11)}</Text>
              <Glyph type={m.type} />
              <Text> </Text>
              <Text color={T.fg}>{m.name}</Text>
              {m.version !== undefined && (
                <>
                  <Text> </Text>
                  <Text color={T.dim}>{m.version}</Text>
                </>
              )}
            </Text>
          ))}
        </Box>
      </Box>

      {deferred !== null && <DeferredAction key={deferred + '-' + Date.now()} label={deferred} />}
    </Frame>
  );
};
