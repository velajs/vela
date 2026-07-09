import { describe, it, expect, beforeEach } from 'vitest';
import {
  Injectable,
  MetadataRegistry,
  Module,
  UseGuards,
  VelaFactory,
  WebSocketGateway,
  WebSocketModule,
  SubscribeMessage,
  WsDispatcher,
} from '../index.js';
import type { CanActivate, WsClient } from '../index.js';
import {
  LiveEngine,
  LiveInvalidation,
  LiveModule,
  LiveQuery,
  LiveResolver,
  PRESENCE_ROSTER_QUERY,
} from '../live/index.js';
import type { LiveQueryContext, ServerLiveFrame } from '../live/index.js';

interface RawFrame {
  event: string;
  data: ServerLiveFrame;
}

class FakeClient implements WsClient {
  readonly rooms = new Set<string>();
  data: Record<string, unknown> = {};
  readonly raw = null;
  readonly frames: RawFrame[] = [];
  failNextSend = false;
  closed?: { code?: number; reason?: string };
  constructor(public readonly id = 'c1') {}
  send(): void {}
  sendRaw(payload: string): void {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error('socket closed');
    }
    this.frames.push(JSON.parse(payload) as RawFrame);
  }
  join(): void {}
  leave(): void {}
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
): string => JSON.stringify({ event: '$live', data: { t: 'sub', sub, query, args, ...extra } });

describe('LiveModule (tag-based live queries)', () => {
  beforeEach(() => MetadataRegistry.clear());

  async function makeTodoApp() {
    const todos: Array<{ id: string; text: string; done?: boolean }> = [
      { id: 't1', text: 'first' },
    ];

    @LiveResolver()
    @Injectable()
    class TodoLive {
      @LiveQuery('todos.list', { tags: (a: { listId: string }) => [`todos:${a.listId}`] })
      list(args: { listId: string }, _ctx: LiveQueryContext) {
        return todos;
      }

      @LiveQuery('todos.count', { tags: ['todos:l1'] })
      count() {
        return { count: todos.length };
      }
    }

    @WebSocketGateway({ path: '/rooms/:id/ws' })
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

    expect(client.live()).toEqual([{ t: 'settled', sub: 's1', cursor: 1, epoch: expect.any(String) }]);
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
  });

  it('validates args once at subscribe via options.parse', async () => {
    MetadataRegistry.clear();

    @LiveResolver()
    @Injectable()
    class Strict {
      @LiveQuery('strict.q', {
        tags: ['t'],
        parse: (args: unknown) => {
          if (typeof (args as { n?: unknown })?.n !== 'number') throw new Error('n must be a number');
          return args as { n: number };
        },
      })
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
    MetadataRegistry.clear();

    @Injectable()
    class DenyGuard implements CanActivate {
      canActivate() {
        return false;
      }
    }

    @LiveResolver()
    @Injectable()
    class Secret {
      @UseGuards(DenyGuard)
      @LiveQuery('secret.q', { tags: ['secret'] })
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
      subFrame('r1', 'todos.list', { listId: 'l1' }, { sinceCursor: initial.cursor, sinceEpoch: initial.epoch }),
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
      subFrame('r2', 'todos.list', { listId: 'l1' }, { sinceCursor: initial.cursor, sinceEpoch: initial.epoch }),
    );
    expect(second.live()[1]).toMatchObject({ t: 'data', sub: 'r2', cursor: 2 });

    // A foreign epoch always snapshots.
    const third = new FakeClient('c4');
    await dispatcher.handleOpen('/rooms/:id/ws', third);
    await dispatcher.dispatchMessage(
      '/rooms/:id/ws',
      third,
      subFrame('r3', 'todos.list', { listId: 'l1' }, { sinceCursor: 1, sinceEpoch: 'forked-timeline' }),
    );
    expect(third.live()[1]).toMatchObject({ t: 'data', sub: 'r3' });
  });

  it('keeps the diff baseline on a failed send so the next flush re-sends the change', async () => {
    const { client, dispatch, engine, invalidation, todos } = await makeTodoApp();
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

  it('captures identity at subscribe and enforces expiry on the outbound path', async () => {
    const { client, dispatch, engine, invalidation, todos } = await makeTodoApp();
    client.data = { userId: 'u1', expiresAt: Date.now() - 1 };
    await dispatch(subFrame('s1', 'todos.list', { listId: 'l1' }));
    client.clear();

    todos.push({ id: 't2', text: 'second' });
    await invalidation.invalidate({ tags: ['todos:l1'] });
    await engine.whenIdle();

    expect(client.live()).toEqual([]); // no scoped data after expiry…
    expect(client.closed).toEqual({ code: 1008, reason: 'identity expired' }); // …the socket is dropped
  });

  it('ships presence: heartbeat updates the roster, close departs immediately', async () => {
    const { client, dispatch, dispatcher, engine } = await makeTodoApp();

    const watcher = new FakeClient('watcher');
    await dispatcher.handleOpen('/rooms/:id/ws', watcher);
    await dispatcher.dispatchMessage(
      '/rooms/:id/ws',
      watcher,
      subFrame('p1', PRESENCE_ROSTER_QUERY, { room: 'lobby' }),
    );
    expect(watcher.live()[1]).toMatchObject({ t: 'data', snapshot: [] });
    watcher.clear();

    await dispatch(
      JSON.stringify({ event: '$live', data: { t: 'presence', room: 'lobby', meta: { name: 'kauan' } } }),
    );
    await engine.whenIdle();
    const joined = watcher.live();
    expect(joined[0]).toMatchObject({ t: 'delta', ops: [{ op: 'insert', key: 'c1' }] });
    watcher.clear();

    await dispatcher.handleClose('/rooms/:id/ws', client, 1000, '');
    await engine.whenIdle();
    // Clearing the last member empties the list — the rule-5 codec bail sends
    // a snapshot rather than a delete-only delta (delta count > next length).
    expect(watcher.live()[0]).toMatchObject({ t: 'data', snapshot: [] });
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
    MetadataRegistry.clear();

    @WebSocketGateway({ path: '/ws' })
    class Sneaky {
      @SubscribeMessage('$live')
      steal() {}
    }

    @Module({ imports: [WebSocketModule.forRoot()], providers: [Sneaky] })
    class AppModule {}

    await expect(VelaFactory.create(AppModule, { diagnostics: 'throw' })).rejects.toThrow(/reserved/);
  });
});

describe('perAppLiveDriver (shared driver across app instances)', () => {
  it('keeps local mode and sinks per app: the DO flipping local must not poison the worker', async () => {
    const { perAppLiveDriver } = await import('../live/index.js');
    const dispatched: unknown[] = [];
    const shared = {
      kind: 'durable-object',
      bind: () => {},
      dispatch: (cmd: unknown) => {
        dispatched.push(cmd);
        return { cursor: 7, epoch: 'remote' };
      },
      _setLocalMode: () => {
        throw new Error('underlying _setLocalMode must never be reached');
      },
    };

    const makeSink = () => {
      const applied: unknown[] = [];
      return {
        applied,
        applyInvalidation: (cmd: unknown) => {
          applied.push(cmd);
          return { cursor: 1, epoch: 'local' };
        },
      };
    };

    const workerDriver = perAppLiveDriver(shared as never);
    const doDriver = perAppLiveDriver(shared as never);
    const workerSink = makeSink();
    const doSink = makeSink();
    workerDriver.bind(workerSink as never);
    doDriver.bind(doSink as never);

    (doDriver as unknown as { _setLocalMode(): void })._setLocalMode();

    // DO app: applies to ITS OWN engine, no remote hop.
    expect(await doDriver.dispatch({ tags: ['t'] })).toEqual({ cursor: 1, epoch: 'local' });
    expect(doSink.applied).toHaveLength(1);

    // Worker app: still routes through the underlying (remote) driver.
    expect(await workerDriver.dispatch({ tags: ['t'] })).toEqual({ cursor: 7, epoch: 'remote' });
    expect(workerSink.applied).toHaveLength(0);
    expect(dispatched).toHaveLength(1);
  });
});
