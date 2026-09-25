import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { VelaError } from '@velajs/errors';
import { MAX_LIVE_FRAME_BYTES, encodeLiveFrame } from '@velajs/live-protocol';
import {
  Injectable,
  InjectionToken,
  Module,
  UseGuards,
  VelaFactory,
  defineProvider,
} from '../index.js';
import {
  WebSocketGateway,
  WebSocketModule,
  SubscribeMessage,
  WsDispatcher,
} from '../websocket/index.js';
import type { CanActivate } from '../index.js';
import type { WsClient } from '../websocket/index.js';
import {
  LiveEngine,
  LiveInvalidation,
  LiveModule,
  LIVE_CURSOR_LOG,
  LIVE_DRIVER,
  LIVE_PROTOCOL,
  LiveQuery,
  LiveResolver,
  PRESENCE_ROSTER_QUERY,
  PresenceService,
  InMemoryCursorLog,
  localLive,
  LIVE_SUBS_DATA_KEY,
  readPersistedLiveSubscriptions,
  defineLiveQuery,
} from '../live/index.js';
import type { LiveDriver, LiveQueryContext, ServerLiveFrame } from '../live/index.js';

const numberQuery = <Name extends string>(name: Name) =>
  defineLiveQuery({ name, args: z.unknown(), result: z.number() });
const strictNumberQuery = defineLiveQuery({
  name: 'strict.q',
  args: {
    parse(value: unknown): { n: number } {
      if (
        typeof value !== 'object' ||
        value === null ||
        !('n' in value) ||
        typeof value.n !== 'number'
      ) {
        throw new Error('n must be a number');
      }
      return { n: value.n };
    },
  },
  result: z.number(),
});
const todoListQuery = defineLiveQuery({
  name: 'todos.list',
  args: z.object({ listId: z.string() }),
  result: z.array(z.object({ id: z.string(), text: z.string(), done: z.boolean().optional() })),
});
const todoCountQuery = defineLiveQuery({
  name: 'todos.count',
  args: z.unknown(),
  result: z.object({ count: z.number() }),
});

interface RawFrame {
  event: string;
  data: ServerLiveFrame;
}

const trustedSocketData = (): Record<string, unknown> => ({
  principal: { issuer: 'test', subject: 'u1', principalType: 'user' },
  tenantId: 't1',
  expiresAtMs: Date.now() + 60_000,
});

class FakeClient implements WsClient {
  readonly rooms = new Set<string>();
  data: Record<string, unknown> = trustedSocketData();
  readonly raw = null;
  readonly frames: RawFrame[] = [];
  failNextSend = false;
  closed?: { code?: number; reason?: string };
  constructor(public readonly id = 'c1') {}
  send(): void {}
  trySendRaw(payload: string): 'accepted' {
    this.sendRaw(payload);
    return 'accepted';
  }

  sendRaw(payload: string): void {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error('socket closed');
    }
    this.frames.push(JSON.parse(payload) as RawFrame);
  }
  join(room: string): void {
    this.rooms.add(room);
  }
  leave(room: string): void {
    this.rooms.delete(room);
  }
  commit(): void {}
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  live(): ServerLiveFrame[] {
    return this.frames.filter((f) => f.event === '$live').map((f) => f.data);
  }
  clear(): void {
    this.frames.length = 0;
  }
}

const subFrame = (
  sub: string,
  query: string,
  args?: unknown,
  extra?: Record<string, unknown>,
): string =>
  JSON.stringify({
    event: '$live',
    data: { t: 'sub', sub, query, args, v: LIVE_PROTOCOL, ...extra },
  });

describe('LiveModule (tag-based live queries)', () => {
  async function makeTodoApp() {
    const todos: Array<{ id: string; text: string; done?: boolean }> = [
      { id: 't1', text: 'first' },
    ];

    @LiveResolver()
    class TodoLive {
      @LiveQuery(todoListQuery, { tags: (args) => [`todos:${args.listId}`] })
      list(args: { listId: string }, _ctx: LiveQueryContext) {
        return todos;
      }

      @LiveQuery(todoCountQuery, { tags: ['todos:l1'] })
      count() {
        return { count: todos.length };
      }
    }

    @WebSocketGateway({ path: '/rooms/:id/ws', roomParam: 'id' })
    class RoomsGateway {}

    @Module({
      imports: [WebSocketModule.forRoot(), LiveModule.forRoot()],
      providers: [RoomsGateway, TodoLive],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const dispatcher = app.get(WsDispatcher);
    const engine = app.get(LiveEngine);
    const invalidation = app.get(LiveInvalidation);
    const client = new FakeClient();
    await dispatcher.handleOpen('/rooms/:id/ws', client);
    const dispatch = (raw: string) => dispatcher.dispatchMessage('/rooms/:id/ws', client, raw);
    return { app, dispatcher, engine, invalidation, client, dispatch, todos };
  }

  it('does not advance a baseline when the connection rejects a smaller gateway frame limit', async () => {
    const { app, dispatcher, engine, invalidation } = await makeTodoApp();
    class LimitedClient extends FakeClient {
      maxFrameBytes = 48;
      override sendRaw(payload: string): void {
        if (new TextEncoder().encode(payload).byteLength > this.maxFrameBytes) return;
        super.sendRaw(payload);
      }
    }
    const client = new LimitedClient();
    try {
      await dispatcher.dispatchMessage(
        '/rooms/:id/ws',
        client,
        subFrame('s1', 'todos.list', { listId: 'l1' }),
      );
      expect(client.live().filter((frame) => frame.t === 'data')).toEqual([]);
      client.maxFrameBytes = 65536;
      client.clear();
      await invalidation.invalidate({ tags: ['todos:l1'] });
      await engine.whenIdle();
      expect(client.live()).toEqual([expect.objectContaining({ t: 'data' })]);
    } finally {
      await app.close();
    }
  });

  it('inspects isolated subscription metadata without exposing arguments, values or claims', async () => {
    const { app, engine, client, dispatch } = await makeTodoApp();
    client.join('l1');
    await dispatch(subFrame('s1', 'todos.list', { listId: 'l1' }));
    const snapshot = engine.inspect();
    expect(snapshot.subscriptions).toEqual([
      expect.objectContaining({
        query: 'todos.list',
        room: 'l1',
        clientId: 'c1',
        tags: ['todos:l1'],
        connectedAt: expect.any(Number),
      }),
    ]);
    expect(snapshot.subscriptions[0]).not.toHaveProperty('args');
    expect(snapshot.subscriptions[0]).not.toHaveProperty('identity');
    snapshot.subscriptions[0]!.tags.push('outside');
    expect(engine.inspect().subscriptions[0]!.tags).toEqual(['todos:l1']);
    const presence = app.get(PresenceService);
    presence.beat('/rooms/:id/ws', 'l1', client.id, { secret: 'private metadata' });
    expect(engine.inspect().rooms).toEqual([{ room: 'l1', count: 1, members: ['c1'] }]);
    presence.reap(client.id);
    await dispatch(JSON.stringify({ event: '$live', data: { t: 'unsub', sub: 's1' } }));
    expect(engine.inspect()).toEqual({ subscriptions: [], rooms: [] });
    await app.close();
  });

  it('reports distinct security callbacks instead of collapsing them into one instance', async () => {
    const first = LiveModule.forRoot({ authorizeDelivery: () => true });
    const second = LiveModule.forRoot({ authorizeDelivery: () => true });
    const shared = () => true;
    const sameA = LiveModule.forRoot({ authorizeDelivery: shared });
    const sameB = LiveModule.forRoot({ authorizeDelivery: shared });

    // One engine per application: every configuration shares the instance key,
    // and the loader compares the callbacks by reference.
    expect(first.key).toBe(second.key);
    expect(sameA.key).toBe(sameB.key);

    @Module({ imports: [WebSocketModule.forRoot({}), first, second] })
    class Conflicting {}
    await expect(VelaFactory.create(Conflicting, { diagnostics: 'throw' })).rejects.toThrow(
      /LiveModule#\w+ was imported again with different options/,
    );

    @Module({ imports: [WebSocketModule.forRoot({}), sameA, sameB] })
    class Shared {}
    const app = await VelaFactory.create(Shared, { diagnostics: 'throw' });
    await app.close();
  });

  it('keys equivalent presence settings as one engine', async () => {
    const equivalent = [
      LiveModule.forRoot(),
      LiveModule.forRoot({ presence: {} }),
      LiveModule.forRoot({ presence: { ttlMs: undefined } }),
    ];
    expect(new Set(equivalent.map((definition) => definition.key)).size).toBe(1);
    expect(LiveModule.forRoot({ presence: { ttlMs: 5_000 } }).key).not.toBe(equivalent[0]?.key);

    @Module({ imports: [WebSocketModule.forRoot(), ...equivalent] })
    class Equivalent {}
    const app = await VelaFactory.create(Equivalent, { diagnostics: 'throw' });
    expect(app.getContainer().getOwnerModuleIds(LiveEngine)).toHaveLength(1);
    await app.close();
  });

  it('restores attachment records with a fresh snapshot and no cached result baseline', async () => {
    const { dispatcher, engine, invalidation, client, dispatch, todos } = await makeTodoApp();
    await dispatch(subFrame('s1', 'todos.list', { listId: 'l1' }));
    const resumed = new FakeClient('resumed');
    resumed.data[LIVE_SUBS_DATA_KEY] = readPersistedLiveSubscriptions(client).map((record) => ({
      ...record,
      lastJson: JSON.stringify(todos),
      lastCursor: Number.MAX_SAFE_INTEGER,
    }));
    await dispatcher.handleOpen('/rooms/:id/ws', resumed);
    for (const record of readPersistedLiveSubscriptions(resumed)) {
      engine.restoreSubscription('/rooms/:id/ws', resumed, record);
    }
    await invalidation.invalidate({ tags: ['todos:l1'] });
    await engine.whenIdle();
    expect(resumed.live()).toEqual([
      expect.objectContaining({ t: 'data', sub: 's1', snapshot: todos }),
    ]);
  });

  it('enforces a persisted identity expiry before delivering after restore', async () => {
    const { dispatcher, engine, invalidation, client, dispatch } = await makeTodoApp();
    await dispatch(subFrame('s1', 'todos.list', { listId: 'l1' }));
    const resumed = new FakeClient('expired-subscription');
    resumed.data[LIVE_SUBS_DATA_KEY] = readPersistedLiveSubscriptions(client).map((record) => ({
      ...record,
      identity: { ...record.identity, expiresAtMs: 0 },
    }));
    await dispatcher.handleOpen('/rooms/:id/ws', resumed);
    for (const record of readPersistedLiveSubscriptions(resumed)) {
      engine.restoreSubscription('/rooms/:id/ws', resumed, record);
    }
    await invalidation.invalidate({ tags: ['todos:l1'] });
    await engine.whenIdle();
    expect(resumed.live()).toEqual([]);
    expect(resumed.closed).toEqual({ code: 1008, reason: 'identity expired' });
  });

  it('acks a subscription and pushes the initial snapshot with cursor+epoch', async () => {
    const { client, dispatch } = await makeTodoApp();
    await dispatch(subFrame('s1', 'todos.list', { listId: 'l1' }));

    const frames = client.live();
    expect(frames[0]).toEqual({ t: 'ack', sub: 's1' });
    expect(frames[1]).toMatchObject({
      t: 'data',
      sub: 's1',
      snapshot: [{ id: 't1', text: 'first' }],
      cursor: 0,
    });
    expect((frames[1] as { epoch?: string }).epoch).toBeTypeOf('string');
  });

  it('re-runs on a matching tag and pushes a keyed delta; unrelated tags do nothing', async () => {
    const { client, dispatch, engine, invalidation, todos } = await makeTodoApp();
    // Keep a large unchanged row in the snapshot so the inserted-row delta is
    // the smaller canonical wire encoding.
    todos[0]!.text = 'first'.repeat(500);
    await dispatch(subFrame('s1', 'todos.list', { listId: 'l1' }));
    client.clear();

    await invalidation.invalidate({ tags: ['unrelated'] });
    await engine.whenIdle();
    expect(client.live()).toEqual([]);

    todos.push({ id: 't2', text: 'second' });
    const stamp = await invalidation.invalidate({ tags: ['todos:l1'] });
    await engine.whenIdle();

    expect(stamp?.cursor).toBe(2);
    const frames = client.live();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      t: 'delta',
      sub: 's1',
      ops: [{ op: 'insert', key: 't2', row: { id: 't2', text: 'second' }, before: null }],
      cursor: 2,
    });
  });

  it('suppresses byte-identical re-runs with a settled frame (cursor still advances)', async () => {
    const { client, dispatch, engine, invalidation } = await makeTodoApp();
    await dispatch(subFrame('s1', 'todos.list', { listId: 'l1' }));
    client.clear();

    await invalidation.invalidate({ tags: ['todos:l1'] }); // nothing actually changed
    await engine.whenIdle();

    expect(client.live()).toEqual([
      { t: 'settled', sub: 's1', cursor: 1, epoch: expect.any(String) },
    ]);
  });

  it('falls back to a snapshot when the result is not a keyable list', async () => {
    const { client, dispatch, engine, invalidation, todos } = await makeTodoApp();
    await dispatch(subFrame('s1', 'todos.count'));
    client.clear();

    todos.push({ id: 't2', text: 'second' });
    await invalidation.invalidate({ tags: ['todos:l1'] });
    await engine.whenIdle();

    expect(client.live()).toEqual([
      { t: 'data', sub: 's1', snapshot: { count: 2 }, cursor: 1, epoch: expect.any(String) },
    ]);
  });

  it('rejects duplicate sub ids, unknown queries, and future protocol versions', async () => {
    const { client, dispatch } = await makeTodoApp();
    await dispatch(subFrame('s1', 'todos.list', { listId: 'l1' }));
    client.clear();

    await dispatch(subFrame('s1', 'todos.list', { listId: 'l1' }));
    await dispatch(subFrame('s2', 'nope'));
    await dispatch(subFrame('s3', 'todos.list', { listId: 'l1' }, { v: 999 }));

    const codes = client.live().map((f) => (f.t === 'error' ? [f.code, f.fatal] : f.t));
    expect(codes).toEqual([
      ['duplicate_sub', false],
      ['unknown_query', true],
      ['unsupported_protocol', true],
    ]);
    expect(client.live()[1]).toMatchObject({ message: "no live query named 'nope' is registered" });
  });

  it('names both declarations when two live query definitions share a name', async () => {
    const duplicate = defineLiveQuery({
      name: 'todos.list',
      args: z.unknown(),
      result: z.number(),
    });
    @LiveResolver()
    class FirstLive {
      @LiveQuery(todoListQuery, { tags: ['todos'] })
      list() {
        return [];
      }
    }
    @LiveResolver()
    class SecondLive {
      @LiveQuery(duplicate, { tags: ['todos'] })
      count() {
        return 0;
      }
    }
    @WebSocketGateway({ path: '/ws' })
    class Gw {}
    @Module({
      imports: [WebSocketModule.forRoot(), LiveModule.forRoot()],
      providers: [Gw, FirstLive, SecondLive],
    })
    class AppModule {}

    const created = VelaFactory.create(AppModule);
    await expect(created).rejects.toThrow(
      /two live query definitions are named 'todos\.list' \(FirstLive\.list and SecondLive\.count/,
    );
    await expect(created).rejects.not.toThrow(/@LiveQuery\('/);
  });

  it('validates args at subscribe through the shared definition', async () => {
    @LiveResolver()
    class Strict {
      @LiveQuery(strictNumberQuery, { tags: ['t'] })
      q(args: { n: number }) {
        return args.n;
      }
    }

    @WebSocketGateway({ path: '/ws' })
    class Gw {}

    @Module({ imports: [WebSocketModule.forRoot(), LiveModule.forRoot()], providers: [Gw, Strict] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const dispatcher = app.get(WsDispatcher);
    const client = new FakeClient();
    await dispatcher.handleOpen('/ws', client);
    await dispatcher.dispatchMessage('/ws', client, subFrame('s1', 'strict.q', { n: 'NaN' }));

    expect(client.live()[0]).toMatchObject({ t: 'error', code: 'bad_args', fatal: true });
  });

  it('runs resolver-tier guards at subscribe and rejects with a forbidden error frame', async () => {
    @Injectable()
    class DenyGuard implements CanActivate {
      canActivate() {
        return false;
      }
    }

    @LiveResolver()
    class Secret {
      @UseGuards(DenyGuard)
      @LiveQuery(numberQuery('secret.q'), { tags: ['secret'] })
      q() {
        return 42;
      }
    }

    @WebSocketGateway({ path: '/ws' })
    class Gw {}

    @Module({
      imports: [WebSocketModule.forRoot(), LiveModule.forRoot()],
      providers: [Gw, Secret, DenyGuard],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const dispatcher = app.get(WsDispatcher);
    const client = new FakeClient();
    await dispatcher.handleOpen('/ws', client);
    await dispatcher.dispatchMessage('/ws', client, subFrame('s1', 'secret.q'));

    expect(client.live()).toEqual([
      { t: 'error', sub: 's1', code: 'forbidden', message: expect.any(String), fatal: true },
    ]);
  });

  it('caps active subscriptions per socket', async () => {
    @LiveResolver()
    class Limited {
      @LiveQuery(numberQuery('limited.q'), { tags: ['limited'] })
      q() {
        return 1;
      }
    }
    @WebSocketGateway({ path: '/ws' })
    class Gw {}
    @Module({
      imports: [WebSocketModule.forRoot(), LiveModule.forRoot({ maxSubscriptionsPerSocket: 1 })],
      providers: [Gw, Limited],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const dispatcher = app.get(WsDispatcher);
    const client = new FakeClient();
    await dispatcher.dispatchMessage('/ws', client, subFrame('s1', 'limited.q'));
    await dispatcher.dispatchMessage('/ws', client, subFrame('s2', 'limited.q'));

    expect(client.live().at(-1)).toMatchObject({
      t: 'error',
      sub: 's2',
      code: 'limit_exceeded',
      fatal: true,
    });
  });

  it('re-authorizes before invalidation delivery and purges a revoked socket', async () => {
    let authorized = true;
    @LiveResolver()
    class Revocable {
      @LiveQuery(numberQuery('revocable.q'), { tags: ['revocable'] })
      q() {
        return 1;
      }
    }
    @WebSocketGateway({ path: '/ws' })
    class Gw {}
    @Module({
      imports: [
        WebSocketModule.forRoot(),
        LiveModule.forRoot({ authorizeDelivery: () => authorized }),
      ],
      providers: [Gw, Revocable],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const dispatcher = app.get(WsDispatcher);
    const engine = app.get(LiveEngine);
    const invalidation = app.get(LiveInvalidation);
    const client = new FakeClient();
    await dispatcher.dispatchMessage('/ws', client, subFrame('s1', 'revocable.q'));
    client.clear();

    authorized = false;
    await invalidation.invalidate({ tags: ['revocable'] });
    await engine.whenIdle();

    expect(client.live()).toEqual([]);
    expect(client.closed?.code).toBe(1008);
    expect(client.data.__velaLiveSubs).toEqual([]);
  });

  it('re-runs resolver guards before invalidation delivery', async () => {
    let allowed = true;
    @Injectable()
    class MutableGuard implements CanActivate {
      canActivate() {
        return allowed;
      }
    }
    @LiveResolver()
    class Guarded {
      @UseGuards(MutableGuard)
      @LiveQuery(numberQuery('guarded.q'), { tags: ['guarded'] })
      q() {
        return 1;
      }
    }
    @WebSocketGateway({ path: '/ws' })
    class Gw {}
    @Module({
      imports: [WebSocketModule.forRoot(), LiveModule.forRoot()],
      providers: [Gw, Guarded, MutableGuard],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const dispatcher = app.get(WsDispatcher);
    const engine = app.get(LiveEngine);
    const invalidation = app.get(LiveInvalidation);
    const client = new FakeClient();
    await dispatcher.dispatchMessage('/ws', client, subFrame('s1', 'guarded.q'));

    allowed = false;
    await invalidation.invalidate({ tags: ['guarded'] });
    await engine.whenIdle();
    expect(client.closed?.code).toBe(1008);
  });

  it('resumes a reconnecting subscription whose tags were untouched, snapshots otherwise', async () => {
    const { client, dispatch, dispatcher, engine, invalidation } = await makeTodoApp();
    await dispatch(subFrame('s1', 'todos.list', { listId: 'l1' }));
    const initial = client.live()[1] as Extract<ServerLiveFrame, { t: 'data' }>;

    // Advance the log with an UNRELATED invalidation while "offline".
    await invalidation.invalidate({ tags: ['other'] });
    await engine.whenIdle();

    const returning = new FakeClient('c2');
    await dispatcher.handleOpen('/rooms/:id/ws', returning);
    await dispatcher.dispatchMessage(
      '/rooms/:id/ws',
      returning,
      subFrame(
        'r1',
        'todos.list',
        { listId: 'l1' },
        { sinceCursor: initial.cursor, sinceEpoch: initial.epoch },
      ),
    );
    expect(returning.live()).toEqual([
      { t: 'ack', sub: 'r1' },
      { t: 'resume', sub: 'r1', cursor: 1, epoch: initial.epoch },
    ]);

    // A RELATED invalidation in the gap forces a re-run + snapshot.
    await invalidation.invalidate({ tags: ['todos:l1'] });
    await engine.whenIdle();
    const second = new FakeClient('c3');
    await dispatcher.handleOpen('/rooms/:id/ws', second);
    await dispatcher.dispatchMessage(
      '/rooms/:id/ws',
      second,
      subFrame(
        'r2',
        'todos.list',
        { listId: 'l1' },
        { sinceCursor: initial.cursor, sinceEpoch: initial.epoch },
      ),
    );
    expect(second.live()[1]).toMatchObject({ t: 'data', sub: 'r2', cursor: 2 });

    // A foreign epoch always snapshots.
    const third = new FakeClient('c4');
    await dispatcher.handleOpen('/rooms/:id/ws', third);
    await dispatcher.dispatchMessage(
      '/rooms/:id/ws',
      third,
      subFrame(
        'r3',
        'todos.list',
        { listId: 'l1' },
        { sinceCursor: 1, sinceEpoch: 'forked-timeline' },
      ),
    );
    expect(third.live()[1]).toMatchObject({ t: 'data', sub: 'r3' });
  });

  it('keeps the diff baseline on a failed send so the next flush re-sends the change', async () => {
    const { client, dispatch, engine, invalidation, todos } = await makeTodoApp();
    // Keep the exercised frames on the delta side of the wire-size crossover.
    todos[0]!.text = 'first'.repeat(500);
    await dispatch(subFrame('s1', 'todos.list', { listId: 'l1' }));
    client.clear();

    todos.push({ id: 't2', text: 'second' });
    client.failNextSend = true;
    await invalidation.invalidate({ tags: ['todos:l1'] });
    await engine.whenIdle();
    expect(client.live()).toEqual([]); // the delta never left the socket

    todos.push({ id: 't3', text: 'third' });
    await invalidation.invalidate({ tags: ['todos:l1'] });
    await engine.whenIdle();

    // Diffed against the ORIGINAL baseline: both missed rows arrive.
    const frames = client.live();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      t: 'delta',
      ops: [
        { op: 'insert', key: 't2', before: null },
        { op: 'insert', key: 't3', before: null },
      ],
    });
  });

  it('does not send a bare-valid frame whose complete live envelope exceeds 64 KiB', async () => {
    const { client, engine } = await makeTodoApp();
    const emptyFrame = {
      t: 'data',
      sub: 's1',
      snapshot: '',
      cursor: 1,
      epoch: 'e',
    } as const;
    const emptyFrameBytes = new TextEncoder().encode(encodeLiveFrame(emptyFrame)).byteLength;
    const frame = {
      ...emptyFrame,
      snapshot: 'x'.repeat(MAX_LIVE_FRAME_BYTES - emptyFrameBytes),
    };
    expect(new TextEncoder().encode(encodeLiveFrame(frame)).byteLength).toBe(MAX_LIVE_FRAME_BYTES);

    const sendFrame = engine as unknown as {
      sendFrame(target: WsClient, value: ServerLiveFrame): boolean;
    };
    expect(sendFrame.sendFrame(client, frame)).toBe(false);
    expect(client.frames).toEqual([]);
  });

  it('captures identity at subscribe and enforces expiry on the outbound path', async () => {
    const { client, dispatch, engine, invalidation, todos } = await makeTodoApp();
    client.data = { userId: 'u1', expiresAtMs: Date.now() - 1 };
    await dispatch(subFrame('s1', 'todos.list', { listId: 'l1' }));
    client.clear();

    todos.push({ id: 't2', text: 'second' });
    await invalidation.invalidate({ tags: ['todos:l1'] });
    await engine.whenIdle();

    expect(client.live()).toEqual([]); // no scoped data after expiry…
    expect(client.closed).toEqual({ code: 1008, reason: 'identity invalid or expired' }); // …the socket is dropped
  });

  it('ships presence: heartbeat updates the roster, close departs immediately', async () => {
    const { client, dispatch, dispatcher, engine } = await makeTodoApp();
    client.rooms.add('lobby');

    const watcher = new FakeClient('watcher');
    watcher.rooms.add('lobby');
    await dispatcher.handleOpen('/rooms/:id/ws', watcher);
    await dispatcher.dispatchMessage(
      '/rooms/:id/ws',
      watcher,
      subFrame('p1', PRESENCE_ROSTER_QUERY, { room: 'lobby' }),
    );
    expect(watcher.live()[1]).toMatchObject({ t: 'data', snapshot: [] });
    watcher.clear();

    await dispatch(
      JSON.stringify({
        event: '$live',
        data: { t: 'presence', room: 'lobby', meta: { name: 'kauan' } },
      }),
    );
    await engine.whenIdle();
    const joined = watcher.live();
    expect(joined[0]).toMatchObject({ t: 'data', snapshot: [{ id: 'c1' }] });
    watcher.clear();

    await dispatcher.handleClose('/rooms/:id/ws', client, 1000, '');
    await engine.whenIdle();
    // For a one-row roster, both the insert and delete delta envelopes cost
    // more than replacing the tiny snapshot.
    expect(watcher.live()[0]).toMatchObject({ t: 'data', snapshot: [] });
  });

  it('rejects presence metadata above 4 KiB on the server', async () => {
    const { app, client, dispatch } = await makeTodoApp();
    client.rooms.add('lobby');

    await dispatch(
      JSON.stringify({
        event: '$live',
        data: { t: 'presence', room: 'lobby', meta: { value: 'x'.repeat(5_000) } },
      }),
    );

    expect(app.get(PresenceService).roster('/rooms/:id/ws', 'lobby')).toEqual([]);
  });

  it('rejects presence heartbeats and roster reads outside joined rooms', async () => {
    const { app, client, dispatch, dispatcher } = await makeTodoApp();

    await dispatch(
      JSON.stringify({
        event: '$live',
        data: { t: 'presence', room: 'foreign', meta: { injected: true } },
      }),
    );

    expect(client.closed).toEqual({ code: 1008, reason: 'presence room not joined' });
    expect(app.get(PresenceService).roster('/rooms/:id/ws', 'foreign')).toEqual([]);

    const watcher = new FakeClient('foreign-watcher');
    watcher.rooms.add('lobby');
    await dispatcher.handleOpen('/rooms/:id/ws', watcher);
    await dispatcher.dispatchMessage(
      '/rooms/:id/ws',
      watcher,
      subFrame('p-foreign', PRESENCE_ROSTER_QUERY, { room: 'foreign' }),
    );
    expect(watcher.live()).toContainEqual(
      expect.objectContaining({ t: 'error', sub: 'p-foreign', fatal: true }),
    );
  });

  it('keeps presence rosters per gateway when gateways share a room id', async () => {
    @WebSocketGateway({ path: '/admin' })
    class AdminGateway {}
    @WebSocketGateway({ path: '/chat' })
    class ChatGateway {}
    @Module({
      imports: [WebSocketModule.forRoot(), LiveModule.forRoot()],
      providers: [AdminGateway, ChatGateway],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    try {
      const dispatcher = app.get(WsDispatcher);
      const engine = app.get(LiveEngine);
      const presence = app.get(PresenceService);
      const beat = (name: string) =>
        JSON.stringify({ event: '$live', data: { t: 'presence', room: 'org-1', meta: { name } } });
      const admin = new FakeClient('admin');
      const chat = new FakeClient('chat');
      admin.rooms.add('org-1');
      chat.rooms.add('org-1');
      await dispatcher.handleOpen('/admin', admin);
      await dispatcher.handleOpen('/chat', chat);
      await dispatcher.dispatchMessage(
        '/chat',
        chat,
        subFrame('roster', PRESENCE_ROSTER_QUERY, { room: 'org-1' }),
      );
      expect(chat.live()[1]).toMatchObject({ t: 'data', snapshot: [] });
      chat.clear();

      // Another gateway's heartbeat in a room with the same id is not this roster's concern.
      await dispatcher.dispatchMessage('/admin', admin, beat('admin'));
      await engine.whenIdle();
      expect(chat.live()).toEqual([]);
      expect(presence.roster('/chat', 'org-1')).toEqual([]);
      expect(presence.roster('/admin', 'org-1')).toEqual([
        expect.objectContaining({ id: 'admin', meta: { name: 'admin' } }),
      ]);

      await dispatcher.dispatchMessage('/chat', chat, beat('chat'));
      await engine.whenIdle();
      expect(chat.live()).toEqual([
        expect.objectContaining({ t: 'data', snapshot: [expect.objectContaining({ id: 'chat' })] }),
      ]);
      expect(engine.inspect().rooms).toEqual([
        { room: 'org-1', count: 2, members: ['admin', 'chat'] },
      ]);
    } finally {
      await app.close();
    }
  });

  it('serves the presence of a 512-byte room on a long gateway path', async () => {
    const path = '/workspaces/:workspace/realtime/ws';
    @WebSocketGateway({ path, roomParam: 'workspace' })
    class WorkspaceGateway {}
    @Module({
      imports: [WebSocketModule.forRoot(), LiveModule.forRoot()],
      providers: [WorkspaceGateway],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    try {
      const dispatcher = app.get(WsDispatcher);
      const engine = app.get(LiveEngine);
      const room = 'w'.repeat(512);
      const member = new FakeClient('member');
      const watcher = new FakeClient('watcher');
      member.rooms.add(room);
      watcher.rooms.add(room);
      await dispatcher.handleOpen(path, member);
      await dispatcher.handleOpen(path, watcher);
      await dispatcher.dispatchMessage(
        path,
        watcher,
        subFrame('roster', PRESENCE_ROSTER_QUERY, { room }),
      );
      expect(watcher.live()).toEqual([
        { t: 'ack', sub: 'roster' },
        expect.objectContaining({ t: 'data', sub: 'roster', snapshot: [] }),
      ]);
      watcher.clear();

      await dispatcher.dispatchMessage(
        path,
        member,
        JSON.stringify({ event: '$live', data: { t: 'presence', room, meta: { name: 'm' } } }),
      );
      await engine.whenIdle();
      expect(watcher.live()).toEqual([
        expect.objectContaining({
          t: 'data',
          snapshot: [expect.objectContaining({ id: 'member', meta: { name: 'm' } })],
        }),
      ]);
    } finally {
      await app.close();
    }
  });

  it('reports a presence invalidation the driver rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('invalidation log unavailable');
    const driver: LiveDriver = {
      kind: 'failing',
      bind() {},
      dispatch: () => Promise.reject(failure),
    };
    @WebSocketGateway({ path: '/ws' })
    class Gateway {}
    @Module({
      imports: [WebSocketModule.forRoot(), LiveModule.forRoot({ driver: () => driver })],
      providers: [Gateway],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    try {
      const client = new FakeClient();
      client.rooms.add('lobby');
      await app.get(WsDispatcher).handleOpen('/ws', client);
      await app
        .get(WsDispatcher)
        .dispatchMessage(
          '/ws',
          client,
          JSON.stringify({ event: '$live', data: { t: 'presence', room: 'lobby' } }),
        );
      await vi.waitFor(() =>
        expect(errorSpy.mock.calls.some((call) => call.includes(failure))).toBe(true),
      );
      expect(app.get(PresenceService).roster('/ws', 'lobby')).toEqual([
        expect.objectContaining({ id: 'c1' }),
      ]);
    } finally {
      errorSpy.mockRestore();
      await app.close();
    }
  });

  it('drops live subscriptions when the socket closes', async () => {
    const { client, dispatch, dispatcher, engine, invalidation, todos } = await makeTodoApp();
    await dispatch(subFrame('s1', 'todos.list', { listId: 'l1' }));
    await dispatcher.handleClose('/rooms/:id/ws', client, 1000, '');
    client.clear();

    todos.push({ id: 't2', text: 'second' });
    await invalidation.invalidate({ tags: ['todos:l1'] });
    await engine.whenIdle();
    expect(client.live()).toEqual([]);
  });

  it('rejects app gateways subscribing to the reserved $ namespace', async () => {
    @WebSocketGateway({ path: '/ws' })
    class Sneaky {
      @SubscribeMessage('$live')
      steal() {}
    }

    @Module({ imports: [WebSocketModule.forRoot()], providers: [Sneaky] })
    class AppModule {}

    await expect(VelaFactory.create(AppModule, { diagnostics: 'throw' })).rejects.toThrow(
      /reserved/,
    );
  });
});

// =============================================================================
// Task 10 — Live engine: an INITIAL-SUBSCRIBE resolver error is REDACTED through
// `toErrorBody` (the single wire-redaction seam). A raw resolver failure must
// never echo its message to the browser — it surfaces ONLY through the reporter.
// Branded VelaErrors keep their client-facing message and map to a live frame
// code (403 → forbidden, 400/422 → bad_args, else internal). The subscribe-arg
// PARSE path is client-facing by convention (crud's fromZodError) and untouched.
//
// The initial `ack` is sent BEFORE the resolver runs, so a resolver-execution
// error yields `[ack, error]`; the pre-ack parse path yields `[error]` only.
// =============================================================================
describe('LiveEngine — initial-subscribe resolver errors are redacted (Task 10)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => errorSpy.mockRestore());

  async function subscribeThrowing(makeError: () => unknown): Promise<FakeClient> {
    @LiveResolver()
    class Boom {
      @LiveQuery(numberQuery('boom.q'), { tags: ['boom'] })
      q() {
        throw makeError();
      }
    }

    @WebSocketGateway({ path: '/ws' })
    class Gw {}

    @Module({ imports: [WebSocketModule.forRoot(), LiveModule.forRoot()], providers: [Gw, Boom] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const dispatcher = app.get(WsDispatcher);
    const client = new FakeClient();
    await dispatcher.handleOpen('/ws', client);
    await dispatcher.dispatchMessage('/ws', client, subFrame('s1', 'boom.q'));
    return client;
  }

  it('unbranded resolver Error → redacted internal frame; raw text only via report', async () => {
    const client = await subscribeThrowing(() => new Error('SELECT * FROM secrets failed'));

    expect(client.live()).toEqual([
      { t: 'ack', sub: 's1' },
      { t: 'error', sub: 's1', code: 'internal', message: 'Internal Server Error', fatal: true },
    ]);
    // The leak is closed: the raw resolver message never rides the wire…
    expect(JSON.stringify(client.frames)).not.toContain('SELECT * FROM secrets failed');
    // …it surfaces ONLY through the reporter (default reporter → console.error).
    const reported = errorSpy.mock.calls
      .map((c) => c[1])
      .find((a): a is Error => a instanceof Error);
    expect(reported?.message).toBe('SELECT * FROM secrets failed');
  });

  it('branded VelaError(403) → forbidden frame keeps its client-facing message', async () => {
    const client = await subscribeThrowing(
      () => new VelaError('forbidden', { message: 'not your list' }),
    );

    expect(client.live()).toEqual([
      { t: 'ack', sub: 's1' },
      { t: 'error', sub: 's1', code: 'forbidden', message: 'not your list', fatal: true },
    ]);
  });

  it('branded VelaError(422) → bad_args frame keeps its client-facing message', async () => {
    const client = await subscribeThrowing(
      () => new VelaError('unprocessable', { message: 'bad cursor' }),
    );

    expect(client.live()).toEqual([
      { t: 'ack', sub: 's1' },
      { t: 'error', sub: 's1', code: 'bad_args', message: 'bad cursor', fatal: true },
    ]);
  });

  it('leaves the subscribe-arg parse path untouched (validation message still echoed)', async () => {
    @LiveResolver()
    class Strict {
      @LiveQuery(strictNumberQuery, { tags: ['t'] })
      q(args: { n: number }) {
        return args.n;
      }
    }

    @WebSocketGateway({ path: '/ws' })
    class Gw {}

    @Module({ imports: [WebSocketModule.forRoot(), LiveModule.forRoot()], providers: [Gw, Strict] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const dispatcher = app.get(WsDispatcher);
    const client = new FakeClient();
    await dispatcher.handleOpen('/ws', client);
    await dispatcher.dispatchMessage('/ws', client, subFrame('s1', 'strict.q', { n: 'NaN' }));

    // Pre-ack path: the validation message IS client-facing (unlike resolver errors).
    expect(client.live()).toEqual([
      { t: 'error', sub: 's1', code: 'bad_args', message: 'n must be a number', fatal: true },
    ]);
  });
});

describe('LiveModule application resource factories', () => {
  it('keeps driver sinks and cursor logs separate when the same module starts twice', async () => {
    const createDriver = vi.fn(localLive);
    const createLog = vi.fn(() => new InMemoryCursorLog());
    const live = LiveModule.forRoot({ driver: createDriver, log: createLog });

    @Module({ imports: [WebSocketModule.forRoot(), live] })
    class AppModule {}

    const first = await VelaFactory.create(AppModule);
    const second = await VelaFactory.create(AppModule);
    try {
      const firstLog = first.get(LIVE_CURSOR_LOG);
      const secondLog = second.get(LIVE_CURSOR_LOG);
      expect(first.get(LIVE_DRIVER)).not.toBe(second.get(LIVE_DRIVER));
      expect(firstLog).not.toBe(secondLog);
      expect(createDriver).toHaveBeenCalledTimes(2);
      expect(createLog).toHaveBeenCalledTimes(2);

      const firstStamp = await first.get(LiveInvalidation).invalidate({ tags: ['first'] });
      expect(firstStamp).toEqual(await firstLog.current());
      expect((await firstLog.current()).cursor).toBe(1);
      expect((await secondLog.current()).cursor).toBe(0);

      await second.get(LiveInvalidation).invalidate({ tags: ['second'] });
      expect((await firstLog.current()).cursor).toBe(1);
      expect((await secondLog.current()).cursor).toBe(1);
      expect((await firstLog.current()).epoch).not.toBe((await secondLog.current()).epoch);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });

  it('resolves async driver/log factories using app-local injected configuration', async () => {
    const APP_BINDING = new InjectionToken<{ scope: string }>('live-test-binding');
    let sequence = 0;

    @Module({
      providers: [
        defineProvider(APP_BINDING, { useFactory: () => ({ scope: `app-${++sequence}` }) }),
      ],
      exports: [APP_BINDING],
    })
    class BindingModule {}

    @Module({
      imports: [
        WebSocketModule.forRoot(),
        LiveModule.forRootAsync({
          imports: [BindingModule],
          inject: [APP_BINDING],
          useFactory: (binding) => ({
            driver: async (): Promise<LiveDriver> => ({
              ...localLive(),
              dispatch: () => ({ cursor: 1, epoch: binding.scope }),
            }),
            log: async () => new InMemoryCursorLog(),
          }),
        }),
      ],
    })
    class AppModule {}

    const first = await VelaFactory.create(AppModule);
    const second = await VelaFactory.create(AppModule);
    try {
      expect(await first.get(LiveInvalidation).invalidate({ tags: ['t'] })).toEqual({
        cursor: 1,
        epoch: 'app-1',
      });
      expect(await second.get(LiveInvalidation).invalidate({ tags: ['t'] })).toEqual({
        cursor: 1,
        epoch: 'app-2',
      });
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });
});
