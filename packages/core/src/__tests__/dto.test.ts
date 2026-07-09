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
  const schema = z!.object({
    id: z!.string(),
    title: z!.string().min(1),
    body: z!.string().min(1),
    authorId: z!.string(),
  });
  const model = modelFn!({ tableName: 'dto_t', schema, primaryKeys: ['id'] });
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

describe('@Crud dto', () => {
  it('dto.create overrides the body schema for POST', async () => {
    if (!honoCrudAvailable) return;

    // Stricter than the model — requires title.length >= 5 and a slug.
    const CreateInput = z!.object({
      title: z!.string().min(5),
      body: z!.string(),
      authorId: z!.string(),
      slug: z!.string().regex(/^[a-z0-9-]+$/),
    });

    const config: CrudConfig = {
      meta: makeMeta() as never,
      adapters: MemoryAdapters as never,
      only: ['create'],
      dto: { create: CreateInput as never },
    };

    const app = new Hono();
    await buildCrudRoutes(app, StubController as unknown as Type, '/d', config, ctx());

    // Title too short → 400
    const r1 = await app.request('/d', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Hi', body: 'b', authorId: 'u', slug: 'hi' }),
    });
    expect(r1.status).toBe(400);

    // Missing slug → 400
    const r2 = await app.request('/d', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Hello world', body: 'b', authorId: 'u' }),
    });
    expect(r2.status).toBe(400);

    // All required → 201
    const r3 = await app.request('/d', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Hello world',
        body: 'b',
        authorId: 'u',
        slug: 'hello-world',
      }),
    });
    expect(r3.status).toBe(201);
  });

  it('dto.update overrides the PATCH body schema and is not auto-partialed', async () => {
    if (!honoCrudAvailable) return;

    // Seed an item via the default create.
    const seed = await (async () => {
      const config: CrudConfig = {
        meta: makeMeta() as never,
        adapters: MemoryAdapters as never,
        only: ['create'],
      };
      const app = new Hono();
      await buildCrudRoutes(app, StubController as unknown as Type, '/d2', config, ctx());
      const r = await app.request('/d2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Original', body: 'b', authorId: 'u' }),
      });
      return ((await r.json()) as { result: { id: string } }).result.id;
    })();

    // Update DTO requires BOTH title and body — no .partial() applied.
    const UpdateInput = z!.object({
      title: z!.string().min(1),
      body: z!.string().min(1),
    });

    const config: CrudConfig = {
      meta: makeMeta() as never,
      adapters: MemoryAdapters as never,
      only: ['update'],
      dto: { update: UpdateInput as never },
    };
    const app = new Hono();
    await buildCrudRoutes(app, StubController as unknown as Type, '/d2', config, ctx());

    // Only title → 400 because update DTO demands body too.
    const r1 = await app.request(`/d2/${seed}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New' }),
    });
    expect(r1.status).toBe(400);

    // Both fields → 200
    const r2 = await app.request(`/d2/${seed}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New title', body: 'New body' }),
    });
    expect(r2.status).toBe(200);
  });

  it('explicit endpoints.create.bodySchema wins over dto.create sugar', async () => {
    if (!honoCrudAvailable) return;

    const flatDto = z!.object({
      title: z!.string(),
      body: z!.string(),
      authorId: z!.string(),
      flatField: z!.string(), // demanded only by the dto sugar
    });

    const explicit = z!.object({
      title: z!.string(),
      body: z!.string(),
      authorId: z!.string(),
      explicitField: z!.string(), // demanded only by explicit override
    });

    const config: CrudConfig = {
      meta: makeMeta() as never,
      adapters: MemoryAdapters as never,
      only: ['create'],
      dto: { create: flatDto as never },
      endpoints: { create: { bodySchema: explicit } as never },
    };

    const app = new Hono();
    await buildCrudRoutes(app, StubController as unknown as Type, '/d3', config, ctx());

    // Has explicitField but missing flatField → 201 (explicit wins).
    const r = await app.request('/d3', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'T',
        body: 'b',
        authorId: 'u',
        explicitField: 'x',
      }),
    });
    expect(r.status).toBe(201);
  });
});
