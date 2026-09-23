import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { VelaFactory } from '@velajs/vela';
import { registerWebSocketGateways } from '@velajs/vela/websocket-node';
import { TodoAppModule } from './app.module.js';

const PORT = 8788;
// `pnpm run bundle:web` writes the page and its client bundle to public/.
const webDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const indexHtml = readFileSync(join(webDir, 'index.html'), 'utf8');
const mainJs = readFileSync(join(webDir, 'main.js'), 'utf8');

const app = await VelaFactory.create(TodoAppModule.forRoot());

const hono = app.getHonoApp();
hono.get('/', (c) => c.html(indexHtml));
hono.get('/main.js', (c) =>
  c.body(mainJs, 200, { 'content-type': 'text/javascript; charset=utf-8' }),
);

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app: hono });
registerWebSocketGateways(app, upgradeWebSocket);

const server = serve({ fetch: hono.fetch, port: PORT }, () => {
  console.log(`live-todo (node transport) → http://localhost:${PORT}`);
});
injectWebSocket(server);
