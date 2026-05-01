import React, { useState } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { Frame } from '../components/Frame.js';
import { Tabs } from '../components/Tabs.js';
import { Glyph } from '../components/Glyph.js';
import { T } from '../theme.js';
import { snapshots } from '../data/mock.js';
import type { Snapshot, ModuleRef } from '../types.js';
import type { ScreenName } from '../app.js';

interface Props {
  goto: (s: ScreenName, payload?: unknown) => void;
}

// Lane glyph + color pair, computed naively from kind/branch.
// In a real impl this comes from a graph layout pass over parentIds.
function laneGlyphs(s: Snapshot, branchLane: 0 | 1) {
  // 0 = main, 1 = experimental column
  const onMain = s.branch === 'main';
  const onExp = s.branch === 'experimental';
  if (s.kind === 'fork') {
    return (
      <Text>
        <Text color={T.persona} bold>├</Text>
        <Text color={T.dim}>─</Text>
        <Text color={T.skill} bold>╮</Text>
      </Text>
    );
  }
  if (s.kind === 'tag') {
    return (
      <Text>
        <Text color={T.hook} bold>◆</Text>
        <Text> </Text>
        <Text color={T.dim}>│</Text>
      </Text>
    );
  }
  // experimental row uses right column
  if (onExp) {
    return (
      <Text>
        <Text color={T.dim}>│</Text>
        <Text> </Text>
        <Text color={T.skill} bold>●</Text>
      </Text>
    );
  }
  // main row
  return (
    <Text>
      {s.kind === 'init' ? (
        <Text color={T.persona} bold>★</Text>
      ) : (
        <Text color={T.persona} bold>●</Text>
      )}
      <Text> </Text>
      <Text color={branchLane === 1 ? T.skill : T.dim}>│</Text>
    </Text>
  );
}

function pad(s: string, w: number) {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function kindMarker(kind: Snapshot['kind']) {
  switch (kind) {
    case 'tag':
      return <Text color={T.hook} bold>◆ </Text>;
    case 'fork':
      return <Text color={T.skill} bold>⎇ </Text>;
    case 'auto':
      return <Text color={T.persona}>▶ </Text>;
    case 'init':
      return <Text color={T.fg} bold>★ </Text>;
    default:
      return <Text color={T.fg}>· </Text>;
  }
}

function moduleSummary(modules: ModuleRef[]) {
  // Group by type, render glyph + name
  const groups: Record<string, ModuleRef[]> = {};
  for (const m of modules) (groups[m.type] ??= []).push(m);
  const order = ['persona', 'mcp', 'skill', 'hook', 'cmd', 'style'];
  return (
    <Text>
      {order.flatMap((t) =>
        (groups[t] ?? []).map((m, i) => (
          <Text key={t + i}>
            <Glyph type={t} /> <Text color={T.fg}>{m.name}</Text>
            <Text color={T.dim}> </Text>
          </Text>
        )),
      )}
    </Text>
  );
}

export const Lineage: React.FC<Props> = ({ goto }) => {
  const [sel, setSel] = useState(0);
  const { exit } = useApp();

  useInput((input, key) => {
    if (key.upArrow) setSel((i) => Math.max(0, i - 1));
    if (key.downArrow) setSel((i) => Math.min(snapshots.length - 1, i + 1));
    if (key.return) {
      const s = snapshots[sel];
      if (s?.sessionId) goto('Sessions', { sessionId: s.sessionId });
    }
    if (input === 'd') goto('Compare');
    if (input === 'q') exit();
  });

  const cur = snapshots[sel]!;

  return (
    <Frame
      active="Lineage"
      keys={[
        { k: '↑↓', l: 'nav' },
        { k: '↵', l: 'open' },
        { k: 'd', l: 'diff' },
        { k: 'b', l: 'branch' },
        { k: 't', l: 'tag' },
        { k: 'r', l: 'reproduce' },
        { k: '/', l: 'search' },
        { k: 'q', l: 'quit' },
      ]}
      right={`lineage  ${sel + 1}/${snapshots.length}`}
    >
      <Box>
        <Text>
          <Text color={T.dim}>research-bot ❯ </Text>
          <Text color={T.fg} bold>
            lineage
          </Text>
          <Text color={T.dim}>{'   '}branches: </Text>
          <Text color={T.persona} bold>● main</Text>
          <Text> </Text>
          <Text color={T.skill} bold>● experimental</Text>
          <Text> </Text>
          <Text color={T.cmd} bold>● hotfix</Text>
          <Text color={T.dim}>{'   '}filter: </Text>
          <Text color={T.fg}>[all]</Text>
        </Text>
      </Box>

      <Tabs tabs={['Lineage', 'Tags', 'Branches', 'Search']} active="Lineage" />

      <Box flexDirection="column" marginTop={1}>
        {snapshots.map((s, i) => {
          const isSel = i === sel;
          return (
            <Text key={s.id}>
              {isSel ? (
                <Text color={T.sel} bold>
                  ❯{' '}
                </Text>
              ) : (
                <Text>{'  '}</Text>
              )}
              {laneGlyphs(s, s.branch === 'experimental' ? 1 : 0)}
              <Text>{'   '}</Text>
              <Text color={T.faint}>{pad(s.ageLabel, 4)}</Text>
              <Text color={s.kind === 'tag' ? T.hook : T.dim}>
                {pad(s.id, 5)}
              </Text>
              {kindMarker(s.kind)}
              <Text color={T.fg} bold={s.kind === 'tag'}>
                {pad(s.message, 34)}
              </Text>
              {s.version &&
                (s.kind === 'tag' ? (
                  <Text backgroundColor={T.hook} color={T.selFg} bold>
                    {' '}
                    {s.version}{' '}
                  </Text>
                ) : (
                  <Text color={T.dim}>{s.version}</Text>
                ))}
              <Text>{'  '}</Text>
              <Text color={T.faint}>code·{s.codePin}</Text>
              {s.sessionId && (
                <Text color={T.dim}>{'  ▷ '}{s.sessionId}</Text>
              )}
            </Text>
          );
        })}
      </Box>

      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={T.dim}
        marginTop={1}
        paddingX={1}
      >
        <Text>
          <Text color={T.fg} bold>
            preview · {cur.id}
          </Text>
          <Text color={T.dim}>{'   '}</Text>
          <Text color={T.fg}>{cur.message}</Text>
          <Text color={T.dim}>{'   on '}</Text>
          <Text color={cur.branch === 'main' ? T.persona : T.skill}>
            {cur.branch}
          </Text>
          <Text color={T.dim}>
            {'   '}
            {cur.ageLabel} ago
          </Text>
        </Text>
        <Text>
          <Text color={T.faint}>harness </Text>
          {cur.version && (
            <Text backgroundColor={T.sel} color={T.selFg} bold>
              {' ' + cur.version + ' '}
            </Text>
          )}
          <Text>{'  '}</Text>
          {moduleSummary(cur.modules)}
        </Text>
        <Text>
          <Text color={T.faint}>code </Text>
          <Text color={T.fg}>{cur.codePin}</Text>
          {cur.sessionId && (
            <>
              <Text color={T.faint}> · session </Text>
              <Text color={T.fg}>{cur.sessionId}</Text>
            </>
          )}
        </Text>
      </Box>
    </Frame>
  );
};
