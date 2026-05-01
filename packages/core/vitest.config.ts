import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 10000,
    pool: 'forks',
    poolOptions: {
      forks: {
        // node:sqlite is Stability 1 (per Node's stability index) and emits
        // an ExperimentalWarning at module-load time, before any JS hook can
        // intercept. Suppress only that warning class in the worker exec
        // args; we accept the API-evolution risk via the engines.node pin.
        execArgv: ['--no-warnings=ExperimentalWarning'],
      },
    },
  },
});
