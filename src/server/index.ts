import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { dockerContainerAdapter, ghGitHubAdapter } from './adapters.js';

const dbPath = process.env.SOFA_DB ?? join(homedir(), '.sofa', 'sofa.db');
const port = Number(process.env.SOFA_PORT ?? 5874);

const db = openDb(dbPath);
const app = createApp(db, {
  github: ghGitHubAdapter(),
  container: dockerContainerAdapter(),
});

// Built UI; path is relative to the process working directory (repo root).
app.use('/*', serveStatic({ root: './dist/ui' }));
app.get('/', serveStatic({ path: './dist/ui/index.html' }));

serve({ fetch: app.fetch, port }, () => {
  console.log(`Sofa listening on http://localhost:${port} (db: ${dbPath})`);
});
