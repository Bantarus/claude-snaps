import React from 'react';
import { Box, Text } from 'ink';
import { T } from '../theme.js';

// Centered setup-instructions screen for a freshly-initialized repo with
// zero snapshots, or for a directory that isn't a harness project at all.
// Pin #5: every empty path renders something useful, never crashes.
export const EmptyRepoScreen: React.FC<{ reason?: string }> = ({ reason }) => (
  <Box flexDirection="column" alignItems="center" justifyContent="center" paddingY={2}>
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={T.dim}
      paddingX={2}
      paddingY={1}
    >
      <Text color={T.fg} bold>No snapshots yet.</Text>
      <Text> </Text>
      <Text color={T.dim}>To start tracking sessions:</Text>
      <Text color={T.fg}>  $ harness install-hook</Text>
      <Text> </Text>
      <Text color={T.dim}>Then run Claude Code in this directory.</Text>
      <Text> </Text>
      <Text color={T.dim}>When snapshots exist, this screen becomes</Text>
      <Text color={T.dim}>the Lineage timeline.</Text>
      <Text> </Text>
      <Text color={T.faint}>q to quit · R to refresh</Text>
      {reason !== undefined && (
        <>
          <Text> </Text>
          <Text color={T.faint}>{reason}</Text>
        </>
      )}
    </Box>
  </Box>
);
