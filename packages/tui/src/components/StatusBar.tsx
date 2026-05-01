import React from 'react';
import { Box, Text } from 'ink';
import { T } from '../theme.js';

export interface KeyHint {
  k: string;
  l: string;
}

export const StatusBar: React.FC<{ keys: KeyHint[]; right?: string }> = ({
  keys,
  right,
}) => {
  return (
    <Box>
      <Box flexGrow={1}>
        <Text backgroundColor={T.fg} color={T.selFg}>
          {' '}
          {keys.map((k, i) => (
            <Text key={i}>
              {i > 0 && <Text color="#5a5853"> · </Text>}
              <Text bold>{k.k}</Text>
              <Text> {k.l}</Text>
            </Text>
          ))}
          {' '.repeat(2)}
        </Text>
      </Box>
      {right && (
        <Text backgroundColor={T.fg} color={T.selFg}>
          {' '}
          {right}{' '}
        </Text>
      )}
    </Box>
  );
};
