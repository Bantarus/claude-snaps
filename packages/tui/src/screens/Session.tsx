import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Frame } from '../components/Frame.js';
import { Tabs } from '../components/Tabs.js';
import { Glyph } from '../components/Glyph.js';
import { T } from '../theme.js';
import { sessions, snapshots } from '../data/mock.js';
import type { TraceKind } from '../types.js';
import type { ScreenName } from '../app.js';

interface Props {
  goto: (s: ScreenName, payload?: unknown) => void;
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

export const SessionDetail: React.FC<Props> = ({ goto }) => {
  const [traceSel, setTraceSel] = useState(7);
  const session = sessions[0]!;
  const snap = snapshots.find((s) => s.id === session.snapshotId);

  useInput((input, key) => {
    if (key.upArrow) setTraceSel((i) => Math.max(0, i - 1));
    if (key.downArrow)
      setTraceSel((i) => Math.min(session.trace.length - 1, i + 1));
    if (key.escape) goto('Lineage');
    if (input === 'r') {
      // re-run with this exact harness — just demo
    }
    if (input === 'f') {
      // fork from this snapshot
    }
  });

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
      right={`trace ${traceSel + 1}/${session.trace.length}`}
    >
      <Box>
        <Text>
          <Text color={T.dim}>research-bot ❯ sessions ❯ </Text>
          <Text color={T.fg} bold>
            {snap?.id} · {session.message}
          </Text>
          <Text color={T.dim}>{'   '}</Text>
          <Text color={T.dim}>
            {session.startLabel} · {session.durationLabel} ·{' '}
          </Text>
          <Text color={T.persona} bold>
            ✓ ended
          </Text>
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text>
          <Text backgroundColor={T.hook} color={T.selFg} bold>
            {' '}
            harness {snap?.version}{' '}
          </Text>
          <Text>{'  '}</Text>
          <Text color={T.faint}>code </Text>
          <Text color={T.fg}>{snap?.codePin}</Text>
          <Text>{'  '}</Text>
          <Text color={T.faint}>pr   </Text>
          <Text color={T.fg}>{session.pr}</Text>
          <Text>{'  '}</Text>
          <Text color={T.faint}>by   </Text>
          <Text color={T.fg}>{session.author}</Text>
        </Text>
      </Box>

      <Tabs
        tabs={['Trace', 'Snapshot', 'Files', 'Tools', 'Re-run']}
        active="Trace"
      />

      <Box flexDirection="row" marginTop={1} gap={1} flexGrow={1}>
        {/* TRACE PANE */}
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={T.dim}
          paddingX={1}
          flexBasis="50%"
          flexShrink={1}
        >
          <Text color={T.dim}>trace</Text>
          {session.trace.map((row, i) => {
            const isSel = i === traceSel;
            return (
              <Text key={i}>
                {isSel ? (
                  <Text color={T.sel} bold>
                    ❯
                  </Text>
                ) : (
                  <Text color={T.dim}>│</Text>
                )}
                <Text color={T.faint}> {row.t} </Text>
                <Text color={TRACE_COLORS[row.kind]} bold>
                  {pad(row.kind, 8)}
                </Text>
                <Text color={T.fg}>{row.message}</Text>
              </Text>
            );
          })}
        </Box>

        {/* SNAPSHOT PANE */}
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
            <Text color={T.fg} bold>
              {snap?.id}
            </Text>
          </Text>
          {snap?.modules.map((m, i) => (
            <Text key={i}>
              <Text color={T.faint}>{pad(m.type, 9)}</Text>
              <Glyph type={m.type} />
              <Text> </Text>
              <Text color={T.fg}>{m.name}</Text>
              {m.version && (
                <>
                  <Text> </Text>
                  <Text color={T.dim}>{m.version}</Text>
                </>
              )}
            </Text>
          ))}
          <Text> </Text>
          <Text color={T.faint}>drift from current (v0.5-draft):</Text>
          <Text>
            <Text color={T.add} bold>
              +{' '}
            </Text>
            <Text color={T.fg}>vector-store MCP added later</Text>
          </Text>
          <Text>
            <Text color={T.add} bold>
              +{' '}
            </Text>
            <Text color={T.fg}>code-review skill added later</Text>
          </Text>
          <Text>
            <Text color={T.chg} bold>
              ~{' '}
            </Text>
            <Text color={T.fg}>terse style updated</Text>
          </Text>
          <Text> </Text>
          <Text backgroundColor={T.persona} color={T.selFg} bold>
            {' [r] re-run with this exact harness '}
          </Text>
        </Box>
      </Box>
    </Frame>
  );
};
