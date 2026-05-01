import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Frame } from '../components/Frame.js';
import { Glyph } from '../components/Glyph.js';
import { DeferredAction } from '../components/DeferredAction.js';
import { T } from '../theme.js';
import { useStore } from '../context.js';
import { useSnapshots } from '../hooks/useSnapshots.js';
import type { TuiDiffRow } from '../data/adapters.js';
import type { Goto } from '../app.js';

interface Props {
  goto: Goto;
  diffA?: string;
  diffB?: string;
}

function pad(s: string, w: number) {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function trunc(s: string, w: number) {
  return s.length <= w ? s : s.slice(0, w - 1) + '…';
}

const stateMark = (s: TuiDiffRow['state']) => {
  if (s === 'added')   return <Text color={T.add} bold>+</Text>;
  if (s === 'removed') return <Text color={T.rm} bold>−</Text>;
  if (s === 'changed') return <Text color={T.chg} bold>~</Text>;
  return <Text color={T.faint}> </Text>;
};

const cellBg = (s: TuiDiffRow['state']): string | undefined => {
  if (s === 'added')   return '#16241b';
  if (s === 'removed') return '#2a1620';
  if (s === 'changed') return '#2a2516';
  return undefined;
};

const Cell: React.FC<{ entry?: TuiDiffRow['left']; bg?: string }> = ({ entry, bg }) => {
  if (entry === undefined) {
    return <Text backgroundColor={bg}>{' '.repeat(28)}</Text>;
  }
  const label = entry.version !== undefined ? `${entry.name} ${entry.version}` : entry.name;
  return (
    <Text backgroundColor={bg}>
      <Glyph type={entry.type} />
      <Text> </Text>
      <Text color={T.fg}>{pad(trunc(label, 22), 24)}</Text>
    </Text>
  );
};

export const Diff: React.FC<Props> = ({ goto, diffA, diffB }) => {
  const store = useStore();
  const { snapshots } = useSnapshots();
  const [deferred, setDeferred] = useState<string | null>(null);

  // If A/B not specified, default to "HEAD vs HEAD's parent" using the
  // newest two snapshots from the log.
  const [idA, idB] = useMemo<[string | null, string | null]>(() => {
    if (diffA !== undefined && diffB !== undefined) return [diffA, diffB];
    if (snapshots.length >= 2) return [snapshots[1]!.id, snapshots[0]!.id];
    if (snapshots.length === 1) return [snapshots[0]!.id, snapshots[0]!.id];
    return [null, null];
  }, [diffA, diffB, snapshots]);

  const rows: TuiDiffRow[] = useMemo(() => {
    if (idA === null || idB === null) return [];
    try {
      return store.diff(idA, idB);
    } catch {
      return [];
    }
  }, [store, idA, idB]);

  useInput((input, key) => {
    if (key.escape) goto('Lineage');
    if (input === 'a') setDeferred('[a] apply');
    if (input === 's') setDeferred('[s] side-by-side');
  });

  const counts = rows.reduce(
    (acc, r) => {
      if (r.state === 'added')   acc.add++;
      if (r.state === 'removed') acc.rm++;
      if (r.state === 'changed') acc.chg++;
      return acc;
    },
    { add: 0, rm: 0, chg: 0 },
  );

  const labelA = idA !== null ? idA.slice(0, 8) : '—';
  const labelB = idB !== null ? idB.slice(0, 8) : '—';

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
      right={`diff  ${counts.add + counts.rm + counts.chg}/${rows.length} changes`}
    >
      <Box>
        <Text color={T.dim}>harness ❯ compare ❯ </Text>
        <Text color={T.fg} bold>{labelA} → {labelB}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          <Text color={T.add} bold>{`+${counts.add}`}</Text>
          <Text color={T.dim}> added  </Text>
          <Text color={T.rm} bold>{`−${counts.rm}`}</Text>
          <Text color={T.dim}> removed  </Text>
          <Text color={T.chg} bold>{`~${counts.chg}`}</Text>
          <Text color={T.dim}> changed  </Text>
        </Text>
      </Box>

      {rows.length === 0 ? (
        <Box marginTop={1} paddingX={1}>
          <Text color={T.faint}>
            {idA === null
              ? 'Need at least one snapshot to diff.'
              : idA === idB
                ? 'A and B are the same snapshot — no differences.'
                : 'No module-level differences between these snapshots.'}
          </Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="row" gap={1}>
          {/* Left A */}
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={T.dim}
            paddingX={1}
            flexBasis="48%"
            flexShrink={1}
          >
            <Text>
              <Text color={T.fg} bold>A · {labelA}</Text>
            </Text>
            {rows.map((r, i) => (
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
            {rows.map((r, i) => (
              <Text key={'m' + i} backgroundColor={cellBg(r.state)}>
                <Text
                  color={
                    r.state === 'added'   ? T.add
                  : r.state === 'removed' ? T.rm
                  : r.state === 'changed' ? T.chg
                                          : T.faint
                  }
                >
                  {r.state === 'same' ? ' · ' : ' → '}
                </Text>
              </Text>
            ))}
          </Box>

          {/* Right B */}
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={T.dim}
            paddingX={1}
            flexBasis="48%"
            flexShrink={1}
          >
            <Text>
              <Text color={T.hook} bold>B · {labelB}</Text>
            </Text>
            {rows.map((r, i) => (
              <Text key={'r' + i} backgroundColor={cellBg(r.state)}>
                {' '}
                {stateMark(r.state)}
                {'  '}
                <Cell entry={r.right} bg={cellBg(r.state)} />
              </Text>
            ))}
          </Box>
        </Box>
      )}

      {deferred !== null && <DeferredAction key={deferred + '-' + Date.now()} label={deferred} />}
    </Frame>
  );
};
