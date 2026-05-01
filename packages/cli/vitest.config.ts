import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30000, // e2e spawns subprocesses
    pool: 'forks',
    poolOptions: {
      forks: {
        // node:sqlite Stability 1 warning suppression — see core's vitest.config.ts.
        execArgv: ['--no-warnings=ExperimentalWarning'],
      },
    },
  },
});
