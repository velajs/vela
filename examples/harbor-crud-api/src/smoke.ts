import { createHarborCrudApp } from './app.js';

const { app } = await createHarborCrudApp();
const hono = app.getHonoApp();

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await hono.request(path, init);
  const body = response.status === 204 ? null : await response.json();
  return { status: response.status, body };
}

const auth = {
  'content-type': 'application/json',
  'x-harbor-key': 'harbor-secret',
};

console.log(await request('/api/containers/dashboard', { headers: auth }));
console.log(
  await request('/api/containers', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      code: 'msku-100',
      status: 'arrived',
      terminal: 'north',
      weightTons: 12,
    }),
  }),
);
console.log(await request('/api/containers', { headers: auth }));
console.log(await request('/api/container-reports?terminal=south'));
console.log(await request('/api/meta/container-resource'));

await app.close('smoke');
