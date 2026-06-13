import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { SdkAgent } from './sdk-agent.js';
import { dockerContainerAdapter, ghGitHubAdapter } from './adapters.js';
import { BIND_HOST } from './bind.js';

const dbPath = process.env.SOFA_DB ?? join(homedir(), '.sofa', 'sofa.db');
const port = Number(process.env.SOFA_PORT ?? 5874);

const db = openDb(dbPath);
const app = createApp(db, new SdkAgent(), {
  github: ghGitHubAdapter(),
  container: dockerContainerAdapter(),
});

// Built UI; path is relative to the process working directory (repo root).
app.use('/*', serveStatic({ root: './dist/ui' }));
app.get('/', serveStatic({ path: './dist/ui/index.html' }));

serve({ fetch: app.fetch, port, hostname: BIND_HOST }, () => {
  console.log(`Sofa listening on http://${BIND_HOST}:${port} (db: ${dbPath})`);
});
