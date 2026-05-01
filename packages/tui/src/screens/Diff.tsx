import React from 'react';
import { Box, Text, useInput } from 'ink';
import { Frame } from '../components/Frame.js';
import { Glyph } from '../components/Glyph.js';
import { T } from '../theme.js';
import type { ModuleType } from '../types.js';
import type { ScreenName } from '../app.js';

interface Props {
  goto: (s: ScreenName, payload?: unknown) => void;
}

type RowState = 'same' | 'added' | 'removed' | 'changed';

interface DiffRow {
  state: RowState;
  left?: { type: ModuleType; name: string; version?: string };
  right?: { type: ModuleType; name: string; version?: string };
}

const ROWS: DiffRow[] = [
  { state: 'same', left: { type: 'persona', name: 'senior-eng' }, right: { type: 'persona', name: 'senior-eng' } },
  { state: 'same', left: { type: 'mcp', name: 'filesystem', version: 'v2.1' }, right: { type: 'mcp', name: 'filesystem', version: 'v2.1' } },
  { state: 'changed', left: { type: 'mcp', name: 'github', version: 'v1.4' }, right: { type: 'mcp', name: 'github', version: 'v1.6' } },
  { state: 'added', right: { type: 'mcp', name: 'postgres', version: 'v0.9' } },
  { state: 'changed', left: { type: 'skill', name: 'research', version: 'v0.4' }, right: { type: 'skill', name: 'research', version: 'v0.5' } },
  { state: 'same', left: { type: 'skill', name: 'summarize', version: 'v0.2' }, right: { type: 'skill', name: 'summarize', version: 'v0.2' } },
  { state: 'same', left: { type: 'hook', name: 'format-pre' }, right: { type: 'hook', name: 'format-pre' } },
  { state: 'same', left: { type: 'hook', name: 'format-post' }, right: { type: 'hook', name: 'format-post' } },
  { state: 'same', left: { type: 'cmd', name: '/plan' }, right: { type: 'cmd', name: '/plan' } },
  { state: 'removed', left: { type: 'cmd', name: '/ship' } },
  { state: 'added', right: { type: 'style', name: 'terse' } },
];

function pad(s: string, w: number) {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

const stateMark = (s: RowState) => {
  if (s === 'added')
    return (
      <Text color={T.add} bold>
        +
      </Text>
    );
  if (s === 'removed')
    return (
      <Text color={T.rm} bold>
        −
      </Text>
    );
  if (s === 'changed')
    return (
      <Text color={T.chg} bold>
        ~
      </Text>
    );
  return <Text color={T.faint}> </Text>;
};

const cellBg = (s: RowState): string | undefined => {
  if (s === 'added') return '#16241b';
  if (s === 'removed') return '#2a1620';
  if (s === 'changed') return '#2a2516';
  return undefined;
};

const Cell: React.FC<{ entry?: DiffRow['left']; bg?: string }> = ({
  entry,
  bg,
}) => {
  if (!entry) {
    return <Text backgroundColor={bg}>{' '.repeat(28)}</Text>;
  }
  const label = entry.version ? `${entry.name} ${entry.version}` : entry.name;
  return (
    <Text backgroundColor={bg}>
      <Glyph type={entry.type} />
      <Text> </Text>
      <Text color={T.fg}>{pad(label, 24)}</Text>
    </Text>
  );
};

export const Diff: React.FC<Props> = ({ goto }) => {
  useInput((input, key) => {
    if (key.escape) goto('Lineage');
  });

  const counts = ROWS.reduce(
    (acc, r) => {
      if (r.state === 'added') acc.add++;
      if (r.state === 'removed') acc.rm++;
      if (r.state === 'changed') acc.chg++;
      return acc;
    },
    { add: 0, rm: 0, chg: 0 },
  );

  return (
    <Frame
      active="Compare"
      keys={[
        { k: 'a', l: 'apply' },
        { k: 'n', l: 'next' },
        { k: 'p', l: 'prev' },
        { k: 'space', l: 'collapse same' },
        { k: 'esc', l: 'back' },
      ]}
      right={`diff  ${counts.add + counts.rm + counts.chg}/${ROWS.length} changes`}
    >
      <Box>
        <Text color={T.dim}>research-bot ❯ compare ❯ </Text>
        <Text color={T.fg} bold>
          v0.3 → v0.4
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          <Text color={T.add} bold>{`+${counts.add}`}</Text>
          <Text color={T.dim}> added  </Text>
          <Text color={T.rm} bold>{`−${counts.rm}`}</Text>
          <Text color={T.dim}> removed  </Text>
          <Text color={T.chg} bold>{`~${counts.chg}`}</Text>
          <Text color={T.dim}> changed  </Text>
          <Text color={T.faint}>·  promote? </Text>
          <Text backgroundColor={T.persona} color={T.selFg} bold>
            {' [a] apply v0.4 '}
          </Text>
          <Text>{'  '}</Text>
          <Text backgroundColor={T.line} color={T.fg}>
            {' [s] side-by-side '}
          </Text>
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="row" gap={1}>
        {/* Left v0.3 */}
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={T.dim}
          paddingX={1}
          flexBasis="48%"
          flexShrink={1}
        >
          <Text>
            <Text color={T.fg} bold>
              v0.3 · 350
            </Text>
            <Text color={T.dim}> code·9c12aa</Text>
          </Text>
          {ROWS.map((r, i) => (
            <Text key={'l' + i} backgroundColor={cellBg(r.state)}>
              {' '}
              {stateMark(r.state)}
              {'  '}
              <Cell entry={r.left} bg={cellBg(r.state)} />
            </Text>
          ))}
        </Box>

        {/* spine */}
        <Box flexDirection="column" paddingTop={1} alignItems="center" flexBasis={3}>
          {ROWS.map((r, i) => (
            <Text key={'m' + i} backgroundColor={cellBg(r.state)}>
              <Text
                color={
                  r.state === 'added'
                    ? T.add
                    : r.state === 'removed'
                      ? T.rm
                      : r.state === 'changed'
                        ? T.chg
                        : T.faint
                }
              >
                {r.state === 'same' ? ' · ' : ' → '}
              </Text>
            </Text>
          ))}
        </Box>

        {/* Right v0.4 */}
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={T.dim}
          paddingX={1}
          flexBasis="48%"
          flexShrink={1}
        >
          <Text>
            <Text color={T.hook} bold>
              v0.4 · 4a1
            </Text>
            <Text color={T.dim}> code·a3f9c1</Text>
          </Text>
          {ROWS.map((r, i) => (
            <Text key={'r' + i} backgroundColor={cellBg(r.state)}>
              {' '}
              {stateMark(r.state)}
              {'  '}
              <Cell entry={r.right} bg={cellBg(r.state)} />
            </Text>
          ))}
        </Box>
      </Box>
    </Frame>
  );
};
