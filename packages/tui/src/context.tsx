import React, { createContext, useContext } from 'react';
import type { Store } from './data/store.js';

// React context carrying the single Store/Repo instance opened in App.
// Per pin #2 the Repo is opened ONCE in App.tsx and reused. Screens never
// call Repo.open(); they consume the Store via useStore().
export const StoreContext = createContext<Store | null>(null);

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (store === null) {
    throw new Error('useStore must be used inside <StoreContext.Provider>');
  }
  return store;
}

export const StoreProvider: React.FC<{ store: Store; children: React.ReactNode }> = ({
  store,
  children,
}) => <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
