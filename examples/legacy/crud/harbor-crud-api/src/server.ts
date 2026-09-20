import { serve } from '@hono/node-server';
import { createApp } from './app.js';

const app = await createApp();
serve({ fetch: app.getHonoApp().fetch, port: 3000 });
console.log('harbor-crud-api listening on http://localhost:3000');
