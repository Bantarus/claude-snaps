import React from 'react';
import { Box, Text } from 'ink';
import { T } from '../theme.js';
import type { ScreenName } from '../app.js';

const NAV: Array<{ key: string; name: ScreenName }> = [
  { key: 'l', name: 'Lineage' },
  { key: 's', name: 'Sessions' },
  { key: 'e', name: 'Editor' },
  { key: 'm', name: 'Modules' },
  { key: 'r', name: 'Recipes' },
  { key: 'c', name: 'Compare' },
];

interface Props {
  active: ScreenName;
}

// Width-locked: borderStyle="round" gives the corners and side lines.
// Inner content padded to align like the wireframe.
export const Sidebar: React.FC<Props> = ({ active }) => {
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
          <Text color={T.fg} bold>
            research-bot
          </Text>
        </Text>
        <Text>
          <Text color={T.dim}>brnch </Text>
          <Text color={T.persona} bold>
            ● main
          </Text>
        </Text>
        <Text>
          <Text color={T.dim}>pin   </Text>
          <Text backgroundColor={T.sel} color={T.selFg} bold>
            {' v0.4 '}
          </Text>
        </Text>
        <Text>
          <Text color={T.dim}>code  </Text>
          <Text color={T.fg}>a3f9c1</Text>
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
          <Text color={T.dim}>snapshots  </Text>
          <Text color={T.fg} bold>
            42
          </Text>
        </Text>
        <Text>
          <Text color={T.dim}>branches    </Text>
          <Text color={T.fg} bold>
            3
          </Text>
        </Text>
        <Text>
          <Text color={T.dim}>sessions  </Text>
          <Text color={T.fg} bold>
            187
          </Text>
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1} paddingX={1}>
        <Text color={T.faint}>v0.4 → working tree</Text>
        <Text color={T.faint}>↑ 3 uncommitted edits</Text>
      </Box>
    </Box>
  );
};
