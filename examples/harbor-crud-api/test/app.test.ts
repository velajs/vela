import { describe, expect, it } from 'vitest';
import { createHarborCrudApp } from '../src/app.js';

type HarborFixture = Awaited<ReturnType<typeof createHarborCrudApp>>;

const harborHeaders = {
  'content-type': 'application/json',
  'x-harbor-key': 'harbor-secret',
};

async function withFixture(fn: (fixture: HarborFixture) => Promise<void>): Promise<void> {
  const fixture = await createHarborCrudApp();
  try {
    await fn(fixture);
  } finally {
    await fixture.app.close('test-complete');
  }
}

describe('Harbor CRUD API example app', () => {
  it('covers @Crud create/list/read/update/delete with guard, DTOs, and hooks', async () => {
    await withFixture(async ({ app }) => {
      const hono = app.getHonoApp();

      const dashboard = await hono.request('/api/containers/dashboard', {
        headers: { 'x-harbor-key': 'harbor-secret' },
      });
      expect(dashboard.status).toBe(200);
      expect(await dashboard.json()).toEqual({
        resource: 'containers',
        endpoints: ['create', 'list', 'read', 'update', 'delete'],
      });

      const deniedCreate = await hono.request('/api/containers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: 'msku-101',
          status: 'arrived',
          terminal: 'north',
          weightTons: 10,
        }),
      });
      expect(deniedCreate.status).toBe(403);

      const invalidCreate = await hono.request('/api/containers', {
        method: 'POST',
        headers: harborHeaders,
        body: JSON.stringify({
          code: 'x',
          status: 'arrived',
          terminal: 'north',
          weightTons: -1,
        }),
      });
      expect(invalidCreate.status).toBe(400);

      const create = await hono.request('/api/containers', {
        method: 'POST',
        headers: harborHeaders,
        body: JSON.stringify({
          code: 'msku-101',
          status: 'arrived',
          terminal: 'north',
          weightTons: 10,
        }),
      });
      expect(create.status).toBe(201);
      const created = (await create.json()) as {
        result: {
          id: string;
          code: string;
          status: string;
          terminal: string;
          weightTons: number;
        };
      };
      expect(created.result).toMatchObject({
        code: 'MSKU-101',
        status: 'arrived',
        terminal: 'north',
        weightTons: 10,
      });

      const list = await hono.request('/api/containers', {
        headers: { 'x-harbor-key': 'harbor-secret' },
      });
      expect(list.status).toBe(200);
      const listed = (await list.json()) as { result: Array<{ code: string; inspected?: boolean }> };
      expect(listed.result).toContainEqual(expect.objectContaining({
        code: 'MSKU-101',
        inspected: true,
      }));

      const read = await hono.request(`/api/containers/${created.result.id}`, {
        headers: { 'x-harbor-key': 'harbor-secret' },
      });
      expect(read.status).toBe(200);
      expect((await read.json()) as object).toMatchObject({
        result: { id: created.result.id, code: 'MSKU-101' },
      });

      const invalidUpdate = await hono.request(`/api/containers/${created.result.id}`, {
        method: 'PATCH',
        headers: harborHeaders,
        body: JSON.stringify({ terminal: 'south' }),
      });
      expect(invalidUpdate.status).toBe(400);

      const update = await hono.request(`/api/containers/${created.result.id}`, {
        method: 'PATCH',
        headers: harborHeaders,
        body: JSON.stringify({
          status: 'loaded',
          terminal: 'south',
          weightTons: 11,
        }),
      });
      expect(update.status).toBe(200);
      expect((await update.json()) as object).toMatchObject({
        result: {
          id: created.result.id,
          status: 'loaded',
          terminal: 'south',
          weightTons: 11,
        },
      });

      const remove = await hono.request(`/api/containers/${created.result.id}`, {
        method: 'DELETE',
        headers: { 'x-harbor-key': 'harbor-secret' },
      });
      expect(remove.status).toBe(200);

      const missing = await hono.request(`/api/containers/${created.result.id}`, {
        headers: { 'x-harbor-key': 'harbor-secret' },
      });
      expect(missing.status).toBe(404);
    });
  });

  it('covers @Override, CrudService injection, and CrudModule.forResource', async () => {
    await withFixture(async ({ app }) => {
      const hono = app.getHonoApp();

      const reports = await hono.request('/api/container-reports?terminal=south');
      expect(reports.status).toBe(200);
      expect(await reports.json()).toEqual({
        result: [],
        override: true,
        terminal: 'south',
      });

      const service = await hono.request('/api/meta/container-resource');
      expect(service.status).toBe(200);
      expect(await service.json()).toEqual({
        hasMeta: true,
        hasAdapters: true,
      });

      const deniedBerth = await hono.request('/api/berths', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Pier 4', vessel: 'MV Cypress' }),
      });
      expect(deniedBerth.status).toBe(403);

      const createBerth = await hono.request('/api/berths', {
        method: 'POST',
        headers: harborHeaders,
        body: JSON.stringify({ name: 'Pier 4', vessel: 'MV Cypress' }),
      });
      expect(createBerth.status).toBe(201);
      expect((await createBerth.json()) as object).toMatchObject({
        result: { name: 'Pier 4', vessel: 'MV Cypress' },
      });

      const listBerths = await hono.request('/api/berths', {
        headers: { 'x-harbor-key': 'harbor-secret' },
      });
      expect(listBerths.status).toBe(200);
      expect((await listBerths.json()) as object).toMatchObject({
        result: [expect.objectContaining({ name: 'Pier 4' })],
      });

      const deleteBerths = await hono.request('/api/berths/some-id', {
        method: 'DELETE',
        headers: { 'x-harbor-key': 'harbor-secret' },
      });
      expect(deleteBerths.status).toBe(404);
    });
  });
});
