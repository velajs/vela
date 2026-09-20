import { serve } from '@hono/node-server';
import { createEvergreenMarketApp } from './app.js';

const { app } = await createEvergreenMarketApp();
const port = Number(process.env.PORT ?? 8787);

serve(
  {
    fetch: app.fetch,
    port,
  },
  (info) => {
    console.log(`Evergreen Market API listening on http://localhost:${info.port}`);
    console.log(`Try http://localhost:${info.port}/api/v1/catalog/items`);
    console.log(`OpenAPI JSON: http://localhost:${info.port}/openapi.json`);
  },
);
