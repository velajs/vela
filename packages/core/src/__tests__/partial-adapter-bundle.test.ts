import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
  adapterProvidesEndpoint,
  buildCrudRoutes,
  crudEndpointSlot,
} from '../index';
import type { CrudConfig } from '../index';

let MemoryAdapters: any;
let defineMeta: any;
let defineModel: any;
let z: any;
let clearStorage: (() => void) | undefined;
let honoCrudAvailable = false;

beforeAll(async () => {
  try {
    const honoCrud = { ...(await import('hono-crud')), ...(await import('@hono-crud/memory')) };
    const memory = await import('@hono-crud/memory');
    const zod = await import('zod');
    MemoryAdapters = honoCrud.MemoryAdapters;
    defineMeta = honoCrud.defineMeta;
    defineModel = honoCrud.defineModel;
    clearStorage = memory.clearStorage as () => void;
    z = zod.z;
    honoCrudAvailable = true;
  } catch {
    honoCrudAvailable = false;
  }
});

beforeEach(() => {
  if (honoCrudAvailable && clearStorage) clearStorage();
});

const ctx = () => ({ globalPrefix: '', globalGuards: [], joinPaths: (...p: string[]) => p.filter(Boolean).join('/') });

const makeMeta = () =>
  defineMeta({
    model: defineModel({
      tableName: 'widgets',
      schema: z.object({ id: z.string(), name: z.string() }),
      primaryKeys: ['id'],
    }),
  });

// A "partial" bundle: only the five required base verbs + search. Lacks
// AggregateEndpoint / Batch*Endpoint / CloneEndpoint / etc.
const partialBundle = () => ({
  CreateEndpoint: MemoryAdapters.CreateEndpoint,
  ListEndpoint: MemoryAdapters.ListEndpoint,
  ReadEndpoint: MemoryAdapters.ReadEndpoint,
  UpdateEndpoint: MemoryAdapters.UpdateEndpoint,
  DeleteEndpoint: MemoryAdapters.DeleteEndpoint,
  SearchEndpoint: MemoryAdapters.SearchEndpoint,
});

describe('adapter-slot helpers', () => {
  it('crudEndpointSlot maps verbs to PascalCase ${Verb}Endpoint', () => {
    expect(crudEndpointSlot('create')).toBe('CreateEndpoint');
    expect(crudEndpointSlot('batchCreate')).toBe('BatchCreateEndpoint');
    expect(crudEndpointSlot('bulkPatch')).toBe('BulkPatchEndpoint');
    expect(crudEndpointSlot('clone')).toBe('CloneEndpoint');
  });

  it('adapterProvidesEndpoint is false for non-objects / missing slots', () => {
    expect(adapterProvidesEndpoint(null, 'create')).toBe(false);
    expect(adapterProvidesEndpoint(undefined, 'create')).toBe(false);
    expect(adapterProvidesEndpoint({}, 'create')).toBe(false);
  });

  it('adapterProvidesEndpoint reflects the bundle key set', () => {
    if (!honoCrudAvailable) return;
    expect(adapterProvidesEndpoint(MemoryAdapters, 'aggregate')).toBe(true);
    expect(adapterProvidesEndpoint(MemoryAdapters, 'bulkPatch')).toBe(true);
    expect(adapterProvidesEndpoint(partialBundle(), 'search')).toBe(true);
    expect(adapterProvidesEndpoint(partialBundle(), 'aggregate')).toBe(false);
    expect(adapterProvidesEndpoint(partialBundle(), 'clone')).toBe(false);
  });
});

describe('partial adapter bundle hardening (hono-crud 0.13 loud-config-failure)', () => {
  it('default mount (no only/except) on a partial bundle does NOT throw', async () => {
    if (!honoCrudAvailable) return;
    const app = new Hono();
    class Stub {}
    await expect(
      buildCrudRoutes(app, Stub as any, '/widgets', { meta: makeMeta(), adapters: partialBundle() }, ctx()),
    ).resolves.not.toThrow();
  });

  it('default mount on a partial bundle exposes supported verbs, omits unsupported', async () => {
    if (!honoCrudAvailable) return;
    const app = new Hono();
    class Stub {}
    await buildCrudRoutes(app, Stub as any, '/widgets', { meta: makeMeta(), adapters: partialBundle() }, ctx());

    const created = await app.request('/widgets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '1', name: 'wrench' }),
    });
    expect(created.status).toBeLessThan(500);
    const search = await app.request('/widgets/search?q=wrench');
    expect(search.status).toBeLessThan(500);

    // Unsupported (batchCreate → POST /widgets/batch) was never mounted → 404.
    const batch = await app.request('/widgets/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ id: '2', name: 'x' }] }),
    });
    expect(batch.status).toBe(404);
  });

  it('explicit only:[unsupported] loud-fails with a clear @Crud: message', async () => {
    if (!honoCrudAvailable) return;
    const app = new Hono();
    class Stub {}
    await expect(
      buildCrudRoutes(app, Stub as any, '/widgets', { meta: makeMeta(), adapters: partialBundle(), only: ['aggregate'] } as CrudConfig, ctx()),
    ).rejects.toThrow(/AggregateEndpoint/);
  });

  it('explicit endpoints.{unsupported} loud-fails with a clear @Crud: message', async () => {
    if (!honoCrudAvailable) return;
    const app = new Hono();
    class Stub {}
    await expect(
      buildCrudRoutes(app, Stub as any, '/widgets', { meta: makeMeta(), adapters: partialBundle(), endpoints: { clone: {} } } as CrudConfig, ctx()),
    ).rejects.toThrow(/CloneEndpoint/);
  });
});
