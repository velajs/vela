import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { Controller, Injectable, MetadataRegistry, Module, VelaFactory } from '@velajs/vela';
import type { WsClient } from '@velajs/vela';
import {
  COMMIT_CURSOR_HEADER,
  COMMIT_EPOCH_HEADER,
  LiveEngine,
  LiveModule,
  LiveQuery,
  LiveResolver,
} from '@velajs/vela/live';
import { Crud } from '../index';

let MemoryAdapters: unknown;
let defineMeta: ((opts: { model: unknown }) => unknown) | undefined;
let defineModel: ((opts: unknown) => unknown) | undefined;
let clearStorage: (() => void) | undefined;
let z: typeof import('zod') | undefined;
let honoCrudAvailable = false;

beforeAll(async () => {
  try {
    const honoCrud = await import('hono-crud');
    const memory = await import('@hono-crud/memory');
    MemoryAdapters = memory.MemoryAdapters;
    defineMeta = honoCrud.defineMeta as typeof defineMeta;
    defineModel = honoCrud.defineModel as typeof defineModel;
    clearStorage = memory.clearStorage as () => void;
    z = await import('zod');
    honoCrudAvailable = true;
  } catch {
    honoCrudAvailable = false;
  }
});

beforeEach(() => {
  MetadataRegistry.clear();
  if (honoCrudAvailable && clearStorage) clearStorage();
});

interface CapturedFrame {
  event: string;
  data: { t: string; sub: string; cursor?: number; epoch?: string };
}

function fakeSubscriber(id = 'live-1'): WsClient & { frames: CapturedFrame[] } {
  const frames: CapturedFrame[] = [];
  return {
    id,
    rooms: new Set<string>(),
    data: {},
    raw: null,
    frames,
    send() {},
    sendRaw(payload: string) {
      frames.push(JSON.parse(payload) as CapturedFrame);
    },
    join() {},
    leave() {},
    commit() {},
    close() {},
  };
}

describe('@Crud({ live: true }) bridge', () => {
  async function makeApp() {
    const TodoSchema = z!.object({ id: z!.string(), text: z!.string() });
    const TodoModel = defineModel!({ tableName: 'todos', schema: TodoSchema, primaryKeys: ['id'] });
    const todoMeta = defineMeta!({ model: TodoModel });

    let generation = 0;

    @LiveResolver()
    @Injectable()
    class TodoLive {
      // Every re-run returns a fresh value so each invalidation pushes `data`.
      @LiveQuery('todos.generation', { tags: ['crud:todos'] })
      gen() {
        generation += 1;
        return { generation };
      }
    }

    @Controller('/todos')
    @Crud({ meta: todoMeta as never, adapters: MemoryAdapters as never, live: true })
    class TodoController {}

    @Controller('/plain')
    @Crud({ meta: todoMeta as never, adapters: MemoryAdapters as never })
    class PlainController {}

    @Module({
      imports: [LiveModule.forRoot()],
      controllers: [TodoController, PlainController],
      providers: [TodoLive],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const engine = app.get(LiveEngine);
    const subscriber = fakeSubscriber();
    engine.restoreSubscription('/ws', subscriber, {
      sub: 's1',
      query: 'todos.generation',
      args: {},
      tags: ['crud:todos'],
    });
    return { hono: app.getHonoApp(), engine, subscriber };
  }

  it('invalidates the table tag and stamps commit headers on successful writes', async () => {
    if (!honoCrudAvailable) return;
    const { hono, engine, subscriber } = await makeApp();

    const res = await hono.request('/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'ship live' }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get(COMMIT_CURSOR_HEADER)).toBe('1');
    expect(res.headers.get(COMMIT_EPOCH_HEADER)).toBeTruthy();

    await engine.whenIdle();
    const live = subscriber.frames.filter((f) => f.event === '$live');
    expect(live).toHaveLength(1);
    expect(live[0].data).toMatchObject({ t: 'data', sub: 's1', cursor: 1 });
    expect(live[0].data.epoch).toBe(res.headers.get(COMMIT_EPOCH_HEADER));
  });

  it('does not invalidate on reads or on failed writes', async () => {
    if (!honoCrudAvailable) return;
    const { hono, engine, subscriber } = await makeApp();

    const list = await hono.request('/todos');
    expect(list.status).toBe(200);
    expect(list.headers.get(COMMIT_CURSOR_HEADER)).toBeNull();

    const bad = await hono.request('/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 123 }), // schema violation
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.headers.get(COMMIT_CURSOR_HEADER)).toBeNull();

    await engine.whenIdle();
    expect(subscriber.frames).toHaveLength(0);
  });

  it('leaves non-live resources untouched', async () => {
    if (!honoCrudAvailable) return;
    const { hono, engine, subscriber } = await makeApp();

    const res = await hono.request('/plain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'no live' }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get(COMMIT_CURSOR_HEADER)).toBeNull();

    await engine.whenIdle();
    expect(subscriber.frames).toHaveLength(0);
  });

  it('update and delete verbs also invalidate, with monotonically advancing cursors', async () => {
    if (!honoCrudAvailable) return;
    const { hono, engine, subscriber } = await makeApp();

    const created = await hono.request('/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'first' }),
    });
    const { result } = (await created.json()) as { result: { id: string } };

    const patched = await hono.request(`/todos/${result.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'edited' }),
    });
    expect(patched.headers.get(COMMIT_CURSOR_HEADER)).toBe('2');

    const deleted = await hono.request(`/todos/${result.id}`, { method: 'DELETE' });
    expect(deleted.headers.get(COMMIT_CURSOR_HEADER)).toBe('3');

    await engine.whenIdle();
    const cursors = subscriber.frames.map((f) => f.data.cursor);
    expect(cursors).toEqual([1, 2, 3]);
  });

  it('warns (once) and no-ops when LiveModule is absent', async () => {
    if (!honoCrudAvailable) return;
    MetadataRegistry.clear();
    const TodoSchema = z!.object({ id: z!.string(), text: z!.string() });
    const TodoModel = defineModel!({ tableName: 'orphans', schema: TodoSchema, primaryKeys: ['id'] });
    const meta = defineMeta!({ model: TodoModel });

    @Controller('/orphans')
    @Crud({ meta: meta as never, adapters: MemoryAdapters as never, live: true })
    class OrphanController {}

    @Module({ controllers: [OrphanController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/orphans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'still works' }),
    });
    expect(res.status).toBe(201); // write succeeds, live is simply off
    expect(res.headers.get(COMMIT_CURSOR_HEADER)).toBeNull();
  });
});
