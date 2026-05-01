import { serve } from '@hono/node-server';
import { createHarborCrudApp } from './app.js';

const { app } = await createHarborCrudApp();
const port = Number(process.env.PORT ?? 8788);

serve(
  {
    fetch: app.fetch,
    port,
  },
  (info) => {
    console.log(`Harbor CRUD API listening on http://localhost:${info.port}`);
    console.log(`Containers: http://localhost:${info.port}/api/containers`);
    console.log(`Reports override: http://localhost:${info.port}/api/container-reports`);
  },
);
