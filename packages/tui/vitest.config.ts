import { defineConfig } from 'vitest/config';

// node:sqlite (transitively via @harness/core) needs the same Vite-side
// resolver shim the core package uses — see packages/core/vitest.config.ts
// for the rationale. node:* imports must be marked external so Vite
// doesn't strip the prefix.
export default defineConfig({
  resolve: { conditions: ['node'] },
  optimizeDeps: { exclude: ['node:sqlite'] },
  ssr: { external: [/^node:/] },
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    pool: 'forks',
    poolOptions: {
      forks: {
        execArgv: ['--no-warnings=ExperimentalWarning'],
      },
    },
  },
});
