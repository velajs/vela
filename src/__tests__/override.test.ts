import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Type } from '@velajs/vela';
import { buildCrudRoutes } from '../builder';
import { Override } from '../override.decorator';
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
  const model = modelFn!({ tableName: 'override_t', schema, primaryKeys: ['id'] });
  return metaFn!({ model });
}

function ctx() {
  return {
    globalPrefix: '',
    globalGuards: [],
    joinPaths: (...parts: string[]) => parts.filter(Boolean).join(''),
  };
}

describe('@Override', () => {
  it('replaces only the named route while base routes still work', async () => {
    if (!honoCrudAvailable) return;

    class C {
      @Override('list')
      async customList(c: Context) {
        return c.json({ overridden: true, items: [] });
      }
    }

    const config: CrudConfig = {
      meta: makeMeta() as never,
      adapters: MemoryAdapters as never,
    };

    const app = new Hono();
    await buildCrudRoutes(app, C as unknown as Type, '/x', config, ctx());

    // Override fires for list
    const listRes = await app.request('/x');
    expect(listRes.status).toBe(200);
    expect(await listRes.json()).toEqual({ overridden: true, items: [] });

    // Base create still works (hono-crud default)
    const createRes = await app.request('/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice' }),
    });
    expect(createRes.status).toBe(201);
  });

  it('does not register middleware for non-overridden routes', async () => {
    if (!honoCrudAvailable) return;

    class C {} // no overrides

    const config: CrudConfig = {
      meta: makeMeta() as never,
      adapters: MemoryAdapters as never,
      only: ['list'],
    };

    const app = new Hono();
    await buildCrudRoutes(app, C as unknown as Type, '/y', config, ctx());

    // Base list returns hono-crud's empty result envelope, not the override shape
    const res = await app.request('/y');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('overridden');
  });
});
