import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { Repo } from '@harness/core';
import { Store } from './data/store.js';
import { StoreProvider } from './context.js';
import { EmptyRepoScreen } from './components/EmptyRepoScreen.js';
import { Lineage } from './screens/Lineage.js';
import { SessionDetail } from './screens/Session.js';
import { Diff } from './screens/Diff.js';
import { Editor } from './screens/Editor.js';
import { ModulePage } from './screens/Module.js';
import type { ModuleType } from './types.js';

export type ScreenName =
  | 'Lineage'
  | 'Sessions'
  | 'Editor'
  | 'Modules'
  | 'Recipes'
  | 'Compare';

export interface NavPayload {
  sessionId?: string;
  snapshotId?: string;
  moduleType?: ModuleType;
  moduleName?: string;
  diffA?: string;
  diffB?: string;
}

export type Goto = (s: ScreenName, payload?: NavPayload) => void;

export interface AppOptions {
  /**
   * Override `process.cwd()`. Tests pass a fixture .harness/ root; the
   * production CLI passes nothing and falls back to the current directory.
   */
  cwd?: string;
  /**
   * Inject a pre-built Store. When set, App skips the internal
   * `Repo.open()` and does NOT close on unmount — the caller owns the
   * lifecycle. Used by tests so they can spy on `store.close()` and
   * keep the fixture Repo alive across re-renders.
   */
  store?: Store;
}

export const App: React.FC<AppOptions> = ({ cwd, store: injected }) => {
  const projectRoot = cwd ?? process.cwd();
  const [store, setStore] = useState<Store | null>(injected ?? null);
  const [openError, setOpenError] = useState<Error | null>(null);
  const [screen, setScreen] = useState<ScreenName>('Lineage');
  const [nav, setNav] = useState<NavPayload>({});
  const [refreshTick, setRefreshTick] = useState(0);
  const { exit } = useApp();

  // Open Repo once on mount, close on unmount. Skipped when an injected
  // store is supplied (test path).
  useEffect(() => {
    if (injected !== undefined) return;
    let opened: Store | null = null;
    try {
      const repo = Repo.open(projectRoot);
      opened = new Store(repo);
      setStore(opened);
    } catch (err) {
      setOpenError(err instanceof Error ? err : new Error(String(err)));
    }
    return () => { opened?.close(); };
  }, [projectRoot, injected]);

  // Global keys. Per-screen useInput hooks coexist; this only handles
  // navigation + quit + refresh.
  useInput((input, key) => {
    if (key.ctrl && input === 'c') exit();
    if (input === 'q') exit();
    if (input === 'R') setRefreshTick((t) => t + 1); // pin #4

    if (!key.meta && !key.ctrl) {
      switch (input) {
        case 'l': setScreen('Lineage'); setNav({}); break;
        case 's': setScreen('Sessions'); break;
        case 'e': setScreen('Editor'); setNav({}); break;
        case 'm': setScreen('Modules'); break;
        case 'c': setScreen('Compare'); break;
      }
    }
  });

  const goto: Goto = (s, payload) => {
    setScreen(s);
    if (payload !== undefined) setNav(payload);
  };

  // Open failure (typically: no .harness/ in cwd). Render the same empty
  // shell as a populated-but-zero-snapshots repo, with the failure
  // message attached so the user can act on it.
  if (openError !== null) {
    return (
      <Box width="100%" flexDirection="column">
        <EmptyRepoScreen reason={`(${openError.message})`} />
      </Box>
    );
  }

  if (store === null) {
    return (
      <Box width="100%" padding={1}>
        <Text>Loading…</Text>
      </Box>
    );
  }

  // Pin #5: empty-repo handling. resolveHead() returns null when no
  // commits exist yet. Wrap in provider anyway so the empty screen can
  // still respond to R (refresh) once a snapshot lands.
  const isEmpty = store.repo.resolveHead() === null;
  if (isEmpty) {
    return (
      <StoreProvider store={store}>
        <Box width="100%" flexDirection="column">
          <EmptyRepoScreen />
        </Box>
      </StoreProvider>
    );
  }

  return (
    <StoreProvider store={store}>
      <Box width="100%" flexDirection="column" key={refreshTick}>
        {screen === 'Lineage'  && <Lineage goto={goto} />}
        {screen === 'Sessions' && <SessionDetail goto={goto} sessionId={nav.sessionId} />}
        {screen === 'Compare'  && <Diff goto={goto} diffA={nav.diffA} diffB={nav.diffB} />}
        {screen === 'Editor'   && <Editor goto={goto} />}
        {screen === 'Modules'  && (
          <ModulePage
            goto={goto}
            moduleType={nav.moduleType}
            moduleName={nav.moduleName}
          />
        )}
        {screen === 'Recipes' && <Lineage goto={goto} />}
      </Box>
    </StoreProvider>
  );
};
