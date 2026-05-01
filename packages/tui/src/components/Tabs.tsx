import React from 'react';
import { Box, Text } from 'ink';
import { T } from '../theme.js';

// One outer <Text> wraps the whole strip — Ink's <Box> would otherwise
// treat each tab as its own flex item and drop short tokens at narrow widths.
export const Tabs: React.FC<{ tabs: string[]; active: string }> = ({
  tabs,
  active,
}) => {
  return (
    <Box>
      <Text>
        <Text color={T.dim}>─</Text>
        {tabs.map((t, i) => {
          const isOn = t === active;
          return (
            <Text key={t}>
              <Text color={T.dim}>{i === 0 ? '[ ' : ' [ '}</Text>
              {isOn ? (
                <Text color={T.sel} bold>
                  {t}
                </Text>
              ) : (
                <Text color={T.dim}>{t}</Text>
              )}
              <Text color={T.dim}> ]</Text>
            </Text>
          );
        })}
        <Text color={T.dim}>──</Text>
      </Text>
    </Box>
  );
};
