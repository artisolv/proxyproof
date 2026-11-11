import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'node:fs';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { createApp } from './app.js';

const config = loadConfig();
const db = openDb(config.DATABASE_PATH);
const { app } = createApp({ db, config });
if (existsSync('./dist/web/index.html')) {
  app.use('/assets/*', serveStatic({ root: './dist/web' }));
  app.get('/favicon.svg', serveStatic({ path: './dist/web/favicon.svg' }));
  app.get('*', (c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'Not found.' }, 404) : c.html(readFileSync('./dist/web/index.html', 'utf8'))));
}
serve({ fetch: app.fetch, port: config.PORT }, (i) => console.log(`ProxyProof listening on port ${i.port}`));
