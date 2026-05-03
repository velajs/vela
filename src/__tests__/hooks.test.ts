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
    const [honoCrud, zod] = await Promise.all([import('hono-crud'), import('zod')]);
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
  const model = modelFn!({ tableName: 'hooks_t', schema, primaryKeys: ['id'] });
  return metaFn!({ model });
}

function ctx() {
  return {
    globalPrefix: '',
    globalGuards: [],
    joinPaths: (...parts: string[]) => parts.filter(Boolean).join(''),
  };
}

describe('flat hooks', () => {
  it('beforeCreate fires and can mutate the payload', async () => {
    if (!honoCrudAvailable) return;

    const calls: string[] = [];
    class C {}

    const config: CrudConfig = {
      meta: makeMeta() as never,
      adapters: MemoryAdapters as never,
      only: ['create'],
      hooks: {
        beforeCreate: (_ctx, data) => {
          calls.push('before');
          const payload = data as Record<string, unknown>;
          return { ...payload, name: `enriched:${payload.name}` };
        },
        afterCreate: (_ctx, data) => {
          calls.push('after');
          return data;
        },
      },
    };

    const app = new Hono();
    await buildCrudRoutes(app, C as unknown as Type, '/h', config, ctx());

    const res = await app.request('/h', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { result: { name: string } };
    expect(body.result.name).toBe('enriched:Alice');
    expect(calls).toEqual(['before', 'after']);
  });

  it('per-endpoint hook overrides flat sugar', async () => {
    if (!honoCrudAvailable) return;

    class C {}

    const config: CrudConfig = {
      meta: makeMeta() as never,
      adapters: MemoryAdapters as never,
      only: ['create'],
      hooks: {
        beforeCreate: (_ctx, data) => {
          const p = data as Record<string, unknown>;
          return { ...p, name: 'flat-wins' };
        },
      },
      endpoints: {
        create: {
          hooks: {
            before: (data: Record<string, unknown>) => ({ ...data, name: 'specific-wins' }),
          },
        } as never,
      },
    };

    const app = new Hono();
    await buildCrudRoutes(app, C as unknown as Type, '/h2', config, ctx());

    const res = await app.request('/h2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { result: { name: string } };
    expect(body.result.name).toBe('specific-wins');
  });
});
