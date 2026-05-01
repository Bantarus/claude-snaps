import React, { useState } from 'react';
import { Box, useInput, useApp } from 'ink';
import { Lineage } from './screens/Lineage.js';
import { SessionDetail } from './screens/Session.js';
import { Diff } from './screens/Diff.js';
import { Editor } from './screens/Editor.js';
import { ModulePage } from './screens/Module.js';

export type ScreenName =
  | 'Lineage'
  | 'Sessions'
  | 'Editor'
  | 'Modules'
  | 'Recipes'
  | 'Compare';

export const App: React.FC = () => {
  const [screen, setScreen] = useState<ScreenName>('Lineage');
  const { exit } = useApp();

  // Global navigation keys. Per-screen `useInput` hooks coexist, so each
  // screen still owns its local interactions (↑↓, ⏎, etc).
  useInput((input, key) => {
    if (key.ctrl && input === 'c') exit();
    if (input === 'q') exit();
    // single-letter screen jumps mirror the sidebar legend
    if (!key.meta && !key.ctrl) {
      switch (input) {
        case 'l':
          setScreen('Lineage');
          break;
        case 's':
          setScreen('Sessions');
          break;
        case 'e':
          setScreen('Editor');
          break;
        case 'm':
          setScreen('Modules');
          break;
        case 'c':
          setScreen('Compare');
          break;
      }
    }
  });

  const goto = (s: ScreenName) => setScreen(s);

  return (
    <Box width="100%" flexDirection="column">
      {screen === 'Lineage' && <Lineage goto={goto} />}
      {screen === 'Sessions' && <SessionDetail goto={goto} />}
      {screen === 'Compare' && <Diff goto={goto} />}
      {screen === 'Editor' && <Editor goto={goto} />}
      {screen === 'Modules' && <ModulePage goto={goto} />}
      {screen === 'Recipes' && <Lineage goto={goto} />}
    </Box>
  );
};
