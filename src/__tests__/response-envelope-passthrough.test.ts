import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Type } from '@velajs/vela';
import { buildCrudRoutes } from '../builder';
import type { CrudConfig } from '../types';

let MemoryAdapters: unknown;
let metaFn: ((opts: { model: unknown }) => unknown) | undefined;
let modelFn: ((opts: unknown) => unknown) | undefined;
let clearStorage: (() => void) | undefined;
let z: typeof import('zod') | undefined;
let honoCrudAvailable = false;

beforeAll(async () => {
  try {
    const [honoCrudBase, zod, memMod, authMod, eventsMod] = await Promise.all([import('hono-crud'), import('zod'), import('@hono-crud/memory'), import('hono-crud/auth'), import('hono-crud/events')]);
    const honoCrud = { ...honoCrudBase, ...memMod, ...authMod, ...eventsMod };
    metaFn = honoCrud.defineMeta as typeof metaFn;
    modelFn = honoCrud.defineModel as typeof modelFn;
    MemoryAdapters = honoCrud.MemoryAdapters;
    clearStorage = honoCrud.clearStorage as typeof clearStorage;
    z = zod;
    honoCrudAvailable = true;
  } catch {
    honoCrudAvailable = false;
  }
});

beforeEach(() => {
  if (clearStorage) clearStorage();
});

function makeMeta(): unknown {
  const schema = z!.object({ id: z!.string(), name: z!.string() });
  const model = modelFn!({ tableName: 'envelope_t', schema, primaryKeys: ['id'] });
  return metaFn!({ model });
}

const ctx = () => ({
  globalPrefix: '',
  globalGuards: [],
  joinPaths: (...p: string[]) => p.filter(Boolean).join(''),
});

describe('responseEnvelope forwarding', () => {
  it('forwards CrudConfig.responseEnvelope verbatim into hono-crud RegisterCrudOptions', async () => {
    if (!honoCrudAvailable) return;

    class C {}

    const config: CrudConfig = {
      meta: makeMeta() as never,
      adapters: MemoryAdapters as never,
      only: ['create', 'read'],
      responseEnvelope: {
        success: (result, info) =>
          info ? { data: result, meta: info } : { data: result },
        error: (err) => ({
          error: { code: err.code, message: err.message },
        }),
      },
    };

    const app = new Hono();
    await buildCrudRoutes(app, C as unknown as Type, '/e', config, ctx());

    const created = await app.request('/e', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'r1', name: 'a' }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { data?: { name: string }; result?: unknown };
    // Custom envelope renames `result` → `data`.
    expect(body.data).toBeDefined();
    expect(body.data?.name).toBe('a');
    expect(body.result).toBeUndefined();
  });

  it('omitting responseEnvelope preserves the default hono-crud envelope', async () => {
    if (!honoCrudAvailable) return;

    class C {}

    const config: CrudConfig = {
      meta: makeMeta() as never,
      adapters: MemoryAdapters as never,
      only: ['create'],
      // responseEnvelope intentionally omitted.
    };

    const app = new Hono();
    await buildCrudRoutes(app, C as unknown as Type, '/e2', config, ctx());

    const created = await app.request('/e2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'r2', name: 'b' }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      success?: boolean;
      result?: { name: string };
    };
    // Default envelope: { success: true, result: ... }
    expect(body.success).toBe(true);
    expect(body.result?.name).toBe('b');
  });
});
