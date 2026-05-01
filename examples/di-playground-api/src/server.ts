import { serve } from '@hono/node-server';
import { createDiPlaygroundApp } from './app.js';

const { app } = await createDiPlaygroundApp();
const port = Number(process.env.PORT ?? 8789);

serve(
  {
    fetch: app.fetch,
    port,
  },
  (info) => {
    console.log(`DI Playground API listening on http://localhost:${info.port}`);
    console.log(`Try http://localhost:${info.port}/api/playground/module-ref`);
  },
);
