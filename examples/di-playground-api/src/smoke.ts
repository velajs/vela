import { createDiPlaygroundApp } from './app.js';

const { app } = await createDiPlaygroundApp();
const hono = app.getHonoApp();

async function json(path: string, init?: RequestInit): Promise<unknown> {
  const response = await hono.request(path, init);
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('json') ? await response.json() : await response.text();
  return { status: response.status, body };
}

console.log(await json('/api/playground/global'));
console.log(await json('/api/playground/forward-ref'));
console.log(await json('/api/playground/module-ref'));
console.log(await json('/api/playground/runtime'));

await app.close('smoke');
