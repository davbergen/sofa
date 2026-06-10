import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Each e2e run gets a throwaway database so the smoke starts from a clean slate.
const dbPath = join(mkdtempSync(join(tmpdir(), 'sofa-e2e-')), 'sofa.db');

export default defineConfig({
  testDir: 'e2e',
  use: {
    baseURL: 'http://localhost:5874',
  },
  webServer: {
    command: 'npm run start',
    port: 5874,
    env: { SOFA_DB: dbPath },
  },
});
