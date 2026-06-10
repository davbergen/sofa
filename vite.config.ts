import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/ui',
  },
  server: {
    proxy: {
      '/api': 'http://localhost:5874',
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration smokes hit the real Claude Agent SDK; run them explicitly
    // via `npm run test:integration` (vitest.integration.config.ts).
    exclude: ['tests/**/*.integration.test.ts', '**/node_modules/**'],
    environment: 'node',
  },
});
