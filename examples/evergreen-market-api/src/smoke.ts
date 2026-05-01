import { createEvergreenMarketApp } from './app.js';

const { app } = await createEvergreenMarketApp({ cors: false });
const hono = app.getHonoApp();

async function json(path: string, init?: RequestInit): Promise<unknown> {
  const response = await hono.request(path, init);
  const body = response.status === 204 ? null : await response.json();
  return { status: response.status, body };
}

console.log(await json('/api/v1/catalog/items'));
console.log(
  await json('/api/v1/catalog/items', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'secret',
    },
    body: JSON.stringify({ name: 'travel mug', price: 18, tags: ['kitchen'] }),
  }),
);
console.log(await json('/api/built-ins/config'));
console.log(await json('/openapi.json'));

await app.close('smoke');
