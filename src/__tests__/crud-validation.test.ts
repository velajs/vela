import { describe, it, expect, beforeAll } from 'vitest';
import { Hono } from 'hono';
import type { Type } from '@velajs/vela';
import { buildCrudRoutes } from '../builder';
import type { CrudConfig } from '../types';

let MemoryAdapters: unknown;
let metaFn: ((opts: { model: unknown }) => unknown) | undefined;
let modelFn: ((opts: unknown) => unknown) | undefined;
let z: typeof import('zod') | undefined;
let honoCrudAvailable = false;

beforeAll(async () => {
  try {
    const [honoCrudBase, zod, memMod, authMod, eventsMod] = await Promise.all([import('hono-crud'), import('zod'), import('@hono-crud/memory'), import('hono-crud/auth'), import('hono-crud/events')]);
    const honoCrud = { ...honoCrudBase, ...memMod, ...authMod, ...eventsMod };
    metaFn = honoCrud.defineMeta as typeof metaFn;
    modelFn = honoCrud.defineModel as typeof modelFn;
    MemoryAdapters = honoCrud.MemoryAdapters;
    z = zod;
    honoCrudAvailable = true;
  } catch {
    honoCrudAvailable = false;
  }
});

function makeMeta(): unknown {
  const schema = z!.object({ id: z!.string(), name: z!.string() });
  const model = modelFn!({ tableName: 't', schema, primaryKeys: ['id'] });
  return metaFn!({ model });
}

function ctx() {
  return {
    globalPrefix: '',
    globalGuards: [],
    joinPaths: (...parts: string[]) => parts.filter(Boolean).join(''),
  };
}

class StubController {}

describe('buildCrudRoutes config validation', () => {
  it('rejects an unknown name in only', async () => {
    if (!honoCrudAvailable) return;
    const config: CrudConfig = {
      meta: makeMeta() as never,
      adapters: MemoryAdapters as never,
      only: ['create', 'bogus' as never],
    };
    await expect(
      buildCrudRoutes(new Hono(), StubController as unknown as Type, '/x', config, ctx()),
    ).rejects.toThrow(/unknown endpoint name 'bogus' in 'only'/);
  });

  it('rejects an unknown name in except', async () => {
    if (!honoCrudAvailable) return;
    const config: CrudConfig = {
      meta: makeMeta() as never,
      adapters: MemoryAdapters as never,
      except: ['lol' as never],
    };
    await expect(
      buildCrudRoutes(new Hono(), StubController as unknown as Type, '/x', config, ctx()),
    ).rejects.toThrow(/unknown endpoint name 'lol'/);
  });

  it('rejects an unknown name in endpoints', async () => {
    if (!honoCrudAvailable) return;
    const config: CrudConfig = {
      meta: makeMeta() as never,
      adapters: MemoryAdapters as never,
      endpoints: { NOT_A_VERB: {} } as never,
    };
    await expect(
      buildCrudRoutes(new Hono(), StubController as unknown as Type, '/x', config, ctx()),
    ).rejects.toThrow(/unknown endpoint name 'NOT_A_VERB' in 'endpoints'/);
  });

  it('accepts a valid config without throwing', async () => {
    if (!honoCrudAvailable) return;
    const config: CrudConfig = {
      meta: makeMeta() as never,
      adapters: MemoryAdapters as never,
      only: ['create', 'list', 'read'],
    };
    await expect(
      buildCrudRoutes(new Hono(), StubController as unknown as Type, '/x', config, ctx()),
    ).resolves.toBeUndefined();
  });
});
