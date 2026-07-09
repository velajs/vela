import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Type } from '@velajs/vela';
import { HttpException } from '@velajs/vela';
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
  const model = modelFn!({ tableName: 'rethrow_t', schema, primaryKeys: ['id'] });
  return metaFn!({ model });
}

const ctx = () => ({
  globalPrefix: '',
  globalGuards: [],
  joinPaths: (...p: string[]) => p.filter(Boolean).join(''),
});

class MyDomainError extends Error {
  override readonly name = 'MyDomainError';
  constructor(public readonly detail: string) {
    super(`my-domain: ${detail}`);
  }
}

describe('buildCrudRoutes sub-app onError', () => {
  it('rethrows non-HttpException errors so the parent app can render them', async () => {
    if (!honoCrudAvailable) return;

    class C {}

    const config: CrudConfig = {
      meta: makeMeta() as never,
      adapters: MemoryAdapters as never,
      only: ['create'],
      hooks: {
        beforeCreate: () => {
          // Plain Error subclass — NOT an HttpException.
          throw new MyDomainError('hook explodes');
        },
      },
    };

    const app = new Hono();
    // Parent app wires its own onError. The sub-app's onError must rethrow
    // domain errors so they reach this handler.
    app.onError((err, c) => {
      if (err instanceof MyDomainError) {
        return c.json(
          { handledBy: 'parent', name: err.name, detail: err.detail },
          418,
        );
      }
      return c.json({ handledBy: 'parent', fallthrough: true }, 500);
    });

    await buildCrudRoutes(app, C as unknown as Type, '/r', config, ctx());

    const res = await app.request('/r', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'x', name: 'a' }),
    });
    expect(res.status).toBe(418);
    const body = (await res.json()) as {
      handledBy: string;
      name: string;
      detail: string;
    };
    expect(body.handledBy).toBe('parent');
    expect(body.name).toBe('MyDomainError');
    expect(body.detail).toBe('hook explodes');
  });

  it('still renders HttpException locally (preserves 1.1.0 behaviour for that branch)', async () => {
    if (!honoCrudAvailable) return;

    class C {}

    const config: CrudConfig = {
      meta: makeMeta() as never,
      adapters: MemoryAdapters as never,
      only: ['create'],
      hooks: {
        beforeCreate: () => {
          throw new HttpException('forbidden', 403);
        },
      },
    };

    const app = new Hono();
    let parentSawIt = false;
    app.onError((_err, c) => {
      parentSawIt = true;
      return c.json({ handledBy: 'parent' }, 500);
    });

    await buildCrudRoutes(app, C as unknown as Type, '/r2', config, ctx());

    const res = await app.request('/r2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'x', name: 'a' }),
    });
    expect(res.status).toBe(403);
    // Parent's onError should NOT have been invoked — the sub-app rendered
    // the HttpException locally, as in 1.1.0.
    expect(parentSawIt).toBe(false);
  });
});
