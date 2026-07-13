import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Controller, MetadataRegistry, Module, VelaFactory } from '@velajs/vela';
import { LiveInvalidation } from '@velajs/vela/live';
import type { InvalidationCommand } from '@velajs/vela/live';
import { Crud } from '../crud.decorator';
import { crudLiveTag } from '../live-bridge';
import { defineModel } from '../model/define-model';
import { testAdapter } from './test-adapter';

type Row = Record<string, unknown>;

const itemSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  deletedAt: z.number().nullable().optional(),
});

/** Duck-typed LiveInvalidation stand-in (the bridge deliberately avoids instanceof). */
function fakeInvalidation() {
  const calls: InvalidationCommand[] = [];
  return {
    calls,
    invalidate: vi.fn(async (cmd: InvalidationCommand) => {
      calls.push(cmd);
      return { cursor: 42, epoch: 'epoch-1' };
    }),
  };
}

async function makeApp(live: boolean | object, withProvider = true) {
  const store = new Map<string, Row>();
  const invalidation = fakeInvalidation();

  @Controller('/live-items')
  @Crud({
    model: defineModel({
      name: 'liveItem',
      tableName: 'live_items',
      schema: itemSchema,
      softDelete: true,
    }),
    adapter: testAdapter(store, 'deletedAt'),
    live: live as never,
  })
  class LiveItemsController {}

  @Module({
    controllers: [LiveItemsController],
    providers: withProvider ? [{ provide: LiveInvalidation, useValue: invalidation }] : [],
  })
  class AppModule {}

  const app = await VelaFactory.create(AppModule);
  return { hono: app.getHonoApp(), invalidation, store };
}

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

beforeEach(() => {
  MetadataRegistry.clear();
  vi.restoreAllMocks();
});

describe('live bridge', () => {
  it('invalidates crud:<table> and stamps commit headers on a 2xx write', async () => {
    const { hono, invalidation } = await makeApp(true);

    const res = await hono.request('/live-items', json('POST', { name: 'Anchor' }));
    expect(res.status).toBe(201);
    expect(invalidation.invalidate).toHaveBeenCalledTimes(1);
    expect(invalidation.calls[0]).toMatchObject({ tags: [crudLiveTag('live_items')] });
    expect(res.headers.get('Vela-Commit-Cursor')).toBe('42');
    expect(res.headers.get('Vela-Commit-Epoch')).toBe('epoch-1');
  });

  it('does not invalidate on reads or on failed writes', async () => {
    const { hono, invalidation } = await makeApp(true);

    await hono.request('/live-items'); // GET list
    expect(invalidation.invalidate).not.toHaveBeenCalled();

    const bad = await hono.request('/live-items', json('POST', { name: '' })); // 400
    expect(bad.status).toBe(400);
    expect(invalidation.invalidate).not.toHaveBeenCalled();

    const missing = await hono.request('/live-items/zzz', { method: 'DELETE' }); // 404
    expect(missing.status).toBe(404);
    expect(invalidation.invalidate).not.toHaveBeenCalled();
  });

  it('appends configured extra tags and the room', async () => {
    const { hono, invalidation } = await makeApp({
      tags: () => ['custom:tag'],
      room: () => 'room-7',
    });

    await hono.request('/live-items', json('POST', { name: 'Tagged' }));
    expect(invalidation.calls[0]).toMatchObject({
      tags: [crudLiveTag('live_items'), 'custom:tag'],
      room: 'room-7',
    });
  });

  it('degrades to a one-time warning when LiveInvalidation is not resolvable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { hono, invalidation } = await makeApp(true, false);

    const first = await hono.request('/live-items', json('POST', { name: 'NoLive' }));
    expect(first.status).toBe(201);
    expect(first.headers.get('Vela-Commit-Cursor')).toBeNull();
    await hono.request('/live-items', json('POST', { name: 'NoLive2' }));

    expect(invalidation.invalidate).not.toHaveBeenCalled();
    const liveWarnings = warn.mock.calls.filter((call) => String(call[0]).includes('live: true'));
    expect(liveWarnings).toHaveLength(1);
  });

  it('does nothing for non-live resources', async () => {
    const { hono, invalidation } = await makeApp(false);
    const res = await hono.request('/live-items', json('POST', { name: 'Plain' }));
    expect(res.status).toBe(201);
    expect(invalidation.invalidate).not.toHaveBeenCalled();
    expect(res.headers.get('Vela-Commit-Cursor')).toBeNull();
  });
});
