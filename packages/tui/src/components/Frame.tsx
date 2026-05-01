import React from 'react';
import { Box } from 'ink';
import { Sidebar } from './Sidebar.js';
import { StatusBar, type KeyHint } from './StatusBar.js';
import type { ScreenName } from '../app.js';

interface Props {
  active: ScreenName;
  keys: KeyHint[];
  right?: string;
  children: React.ReactNode;
}

export const Frame: React.FC<Props> = ({ active, keys, right, children }) => {
  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="row" flexGrow={1}>
        <Sidebar active={active} />
        <Box flexDirection="column" flexGrow={1}>
          {children}
        </Box>
      </Box>
      <StatusBar keys={keys} right={right} />
    </Box>
  );
};
