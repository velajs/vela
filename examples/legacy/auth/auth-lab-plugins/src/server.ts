import { serve } from '@hono/node-server';
import { createApp } from './app.js';

const app = await createApp();
const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`auth-lab-plugins listening on http://localhost:${info.port}`);
  console.log('  GET  /healthz                          — public');
  console.log('  GET  /me                               — protected');
  console.log('  POST /api/auth/sign-up/email           — email/password sign-up');
  console.log('  POST /api/auth/sign-in/magic-link      — magic link plugin (Pattern C)');
});
