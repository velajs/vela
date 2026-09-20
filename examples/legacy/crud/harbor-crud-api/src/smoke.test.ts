import { describe, expect, it } from 'vitest';
import { createApp } from './app';

const KEY = { 'X-Harbor-Key': 'letmein' };
const json = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json', ...KEY },
  body: JSON.stringify(body),
});

describe('harbor example', () => {
  it('exercises the decorated /containers resource end to end', async () => {
    const app = await createApp();
    const hono = app.getHonoApp();

    // Guard: no key → 403.
    expect((await hono.request('/containers/stats')).status).toBe(403);

    // Hand-written route.
    const stats = await hono.request('/containers/stats', { headers: KEY });
    expect(await stats.json()).toEqual({ total: 0 });

    // create → beforeCreate hook uppercases the code.
    const created = await hono.request(
      '/containers',
      json('POST', { code: 'msku1234', weightKg: 800, hazardous: false }),
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as { result: { id: string; code: string } };
    expect(body.result.code).toBe('MSKU1234');

    // @Override('list') serves the collection.
    const list = await hono.request('/containers', { headers: KEY });
    const listBody = (await list.json()) as { result: unknown[]; result_info: { note: string } };
    expect(listBody.result).toHaveLength(1);
    expect(listBody.result_info.note).toBe('served by @Override');

    // delete → soft; read-after 404.
    await hono.request(`/containers/${body.result.id}`, { method: 'DELETE', headers: KEY });
    expect((await hono.request(`/containers/${body.result.id}`, { headers: KEY })).status).toBe(404);
  });

  it('serves the headless /berths resource with verb selection', async () => {
    const app = await createApp();
    const hono = app.getHonoApp();

    const created = await hono.request('/berths', json('POST', { label: 'B-12', depthM: 14.5 }));
    expect(created.status).toBe(201);

    // update is NOT in `only` → no PATCH route.
    const id = ((await created.json()) as { result: { id: string } }).result.id;
    expect((await hono.request(`/berths/${id}`, json('PATCH', { label: 'X' }))).status).toBe(404);

    const list = await hono.request('/berths');
    expect(((await list.json()) as { result: unknown[] }).result).toHaveLength(1);
  });
});
