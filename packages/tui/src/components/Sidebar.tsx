import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { basename } from 'node:path';
import { T } from '../theme.js';
import { useStore } from '../context.js';
import type { ScreenName } from '../app.js';

const NAV: Array<{ key: string; name: ScreenName }> = [
  { key: 'l', name: 'Lineage' },
  { key: 's', name: 'Sessions' },
  { key: 'e', name: 'Editor' },
  { key: 'm', name: 'Modules' },
  { key: 'r', name: 'Recipes' },
  { key: 'c', name: 'Compare' },
];

interface Props { active: ScreenName }

// All metadata is derived from the Store on every render. The Store does
// no caching (pin from prompt C), so each frame reflects current state —
// the cost is a few sub-millisecond SQLite reads, which is invisible at
// TUI frame rates.
export const Sidebar: React.FC<Props> = ({ active }) => {
  const store = useStore();
  const meta = useMemo(() => deriveMeta(store), [store]);

  return (
    <Box flexDirection="column" width={26} flexShrink={0} marginRight={1}>
      <Box
        borderStyle="round"
        borderColor={T.dim}
        flexDirection="column"
        paddingX={1}
      >
        <Text color={T.dim}>harness</Text>
        <Text>
          <Text color={T.dim}>name </Text>
          <Text color={T.fg} bold>{meta.name}</Text>
        </Text>
        <Text>
          <Text color={T.dim}>brnch </Text>
          <Text color={T.persona} bold>● {meta.branch}</Text>
        </Text>
        {meta.tag !== null && (
          <Text>
            <Text color={T.dim}>tag   </Text>
            <Text backgroundColor={T.sel} color={T.selFg} bold>
              {' ' + meta.tag + ' '}
            </Text>
          </Text>
        )}
        <Text>
          <Text color={T.dim}>code  </Text>
          <Text color={T.fg}>{meta.code}</Text>
        </Text>
      </Box>

      <Box
        borderStyle="round"
        borderColor={T.dim}
        flexDirection="column"
        paddingX={1}
        marginTop={1}
      >
        {NAV.map((it) => {
          const isActive = it.name === active;
          return (
            <Text key={it.name}>
              {isActive ? (
                <Text backgroundColor={T.sel} color={T.selFg} bold>
                  {' ▸ ' + it.name.padEnd(18)}
                </Text>
              ) : (
                <Text>
                  <Text color={T.dim}>   </Text>
                  <Text color={T.fg}>{it.name.padEnd(15)}</Text>
                  <Text color={T.faint}>[{it.key}]</Text>
                </Text>
              )}
            </Text>
          );
        })}
      </Box>

      <Box
        borderStyle="round"
        borderColor={T.dim}
        flexDirection="column"
        paddingX={1}
        marginTop={1}
      >
        <Text color={T.dim}>stats</Text>
        <Text>
          <Text color={T.dim}>snapshots </Text>
          <Text color={T.fg} bold>{String(meta.snapshotCount).padStart(3)}</Text>
        </Text>
        <Text>
          <Text color={T.dim}>branches  </Text>
          <Text color={T.fg} bold>{String(meta.branchCount).padStart(3)}</Text>
        </Text>
        <Text>
          <Text color={T.dim}>sessions  </Text>
          <Text color={T.fg} bold>{String(meta.sessionCount).padStart(3)}</Text>
        </Text>
      </Box>
    </Box>
  );
};

interface SidebarMeta {
  name: string;
  branch: string;
  tag: string | null;
  code: string;
  snapshotCount: number;
  branchCount: number;
  sessionCount: number;
}

function deriveMeta(store: ReturnType<typeof useStore>): SidebarMeta {
  const snaps = store.snapshots();
  const tip = snaps[0];
  const tagged = snaps.find((s) => s.kind === 'tag' && s.version !== undefined);
  return {
    name: basename(store.repo.projectRoot) || 'harness',
    branch: store.repo.currentBranchName() ?? 'main',
    tag: tagged?.version ?? null,
    code: tip?.codePin ?? '—',
    snapshotCount: snaps.length,
    branchCount: Object.keys(store.repo.branches()).length,
    sessionCount: snaps.filter((s) => s.sessionId !== undefined).length,
  };
}
