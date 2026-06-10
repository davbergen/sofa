// Opt-in integration test run (real Claude Agent SDK calls).
// `npm test` uses vite.config.ts, which excludes *.integration.test.ts.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.integration.test.ts'],
    environment: 'node',
    testTimeout: 180_000,
  },
});
