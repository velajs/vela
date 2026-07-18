import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Injectable, MetadataRegistry, Module, WebSocketModule } from '@velajs/vela';
import { WebSocketGateway } from '@velajs/vela/websocket';
import { LIVE_PROTOCOL, LiveModule, LiveQuery, LiveResolver } from '@velajs/vela/live';
import type { CommitStamp, InvalidationCommand, LiveInvalidationSink } from '@velajs/vela/live';
import { buildDoRuntime } from '../websocket/do-bootstrap';
import { DoCursorLog, durableObjectCursorLog, durableObjectLive } from '../websocket/do-live';
import { DoWebSocketHost } from '../websocket/do-websocket-host';
import type { DoStateLike, SqlStorageLike, WsLike } from '../websocket/do-state';

beforeEach(() => MetadataRegistry.clear());

// Real SQLite (node:sqlite) behind the structural SqlStorageLike — faithful
// AUTOINCREMENT + sqlite_sequence + trim semantics, unlike a hand-rolled fake.
function sqlStorage(): SqlStorageLike {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query: string, ...bindings: unknown[]) {
      if (query.trimStart().toUpperCase().startsWith('SELECT')) {
        const rows = db.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[];
        return { toArray: () => rows };
      }
      if (bindings.length > 0) db.prepare(query).run(...(bindings as never[]));
      else db.exec(query);
      return { toArray: () => [] };
    },
  };
}

class FakeWs implements WsLike {
  readonly sent: string[] = [];
  private attachment: unknown = null;
  send(message: string | ArrayBuffer): void {
    this.sent.push(typeof message === 'string' ? message : new TextDecoder().decode(message));
  }
  close(): void {}
  serializeAttachment(value: unknown): void {
    this.attachment = JSON.parse(JSON.stringify(value));
  }
  deserializeAttachment(): unknown {
    return this.attachment;
  }
  liveFrames(): Array<{
    t: string;
    sub: string;
    cursor?: number;
    epoch?: string;
    snapshot?: unknown;
  }> {
    return this.sent
      .map((raw) => JSON.parse(raw) as { event: string; data: never })
      .filter((envelope) => envelope.event === '$live')
      .map((envelope) => envelope.data);
  }
}

class FakeDoState implements DoStateLike {
  readonly id = { toString: () => 'do-1', name: 'room-1' as string | null };
  readonly accepted: Array<{ ws: FakeWs; tags: string[] }> = [];
  constructor(readonly storage: { sql: SqlStorageLike }) {}
  acceptWebSocket(ws: WsLike, tags: string[] = []): void {
    this.accepted.push({ ws: ws as FakeWs, tags });
  }
  getWebSockets(tag?: string): WsLike[] {
    return this.accepted.filter((a) => tag === undefined || a.tags.includes(tag)).map((a) => a.ws);
  }
  setWebSocketAutoResponse(): void {}
}

function acceptTrusted(host: DoWebSocketHost, ws: WsLike): Promise<boolean> {
  return host.accept(ws, '/rooms/:id/ws', 'room-1', 'user-1', Date.now() + 60_000, {
    issuer: 'https://issuer.test',
    subject: 'user-1',
    principalType: 'user',
    tenantId: 'tenant-1',
  });
}

describe('DoCursorLog (SQLite)', () => {
  it('is monotonic, epoch-stable across instances, and cursor-stable across trims', () => {
    const storage = sqlStorage();
    const log = new DoCursorLog(3);
    log._initialize(storage);

    expect(log.current().cursor).toBe(0);
    const first = log.append(['a']);
    expect(first.cursor).toBe(1);
    log.append(['b']);
    log.append(['c']);
    log.append(['d']); // trims seq 1 (maxRows 3)
    expect(log.current().cursor).toBe(4);

    // A fresh instance over the SAME storage (hibernation wake) keeps both.
    const woken = new DoCursorLog(3);
    woken._initialize(storage);
    expect(woken.current()).toEqual({ cursor: 4, epoch: first.epoch });
  });

  it('resolves resume verdicts: resume / rerun / snapshot (epoch, rollback, trimmed gap)', () => {
    const log = new DoCursorLog(100);
    log._initialize(sqlStorage());
    const { epoch } = log.append(['todos']); // seq 1
    log.append(['other']); // seq 2

    expect(log.evaluateResume(2, epoch, ['todos'])).toBe('resume'); // up to date
    expect(log.evaluateResume(1, epoch, ['nope'])).toBe('resume'); // untouched gap
    expect(log.evaluateResume(1, epoch, ['other'])).toBe('rerun'); // touched gap
    expect(log.evaluateResume(1, 'forked', ['other'])).toBe('snapshot'); // epoch fork
    expect(log.evaluateResume(99, epoch, ['other'])).toBe('snapshot'); // rollback guard

    const trimmed = new DoCursorLog(1);
    trimmed._initialize(sqlStorage());
    const stamp = trimmed.append(['a']);
    trimmed.append(['b']);
    trimmed.append(['c']); // only seq 3 retained
    expect(trimmed.evaluateResume(1, stamp.epoch, ['nope'])).toBe('snapshot'); // gap trimmed
  });

  it('throws a descriptive error when used un-initialized (Worker isolate misuse)', () => {
    expect(() => new DoCursorLog().current()).toThrow(/new_sqlite_classes|durableObjectLive/);
  });
});

describe('durableObjectLive driver', () => {
  it('routes Worker-side dispatches to the room DO and returns its stamp', async () => {
    const calls: Array<{ id: string; cmd: InvalidationCommand }> = [];
    const ns = {
      idFromName: (name: string) => ({ toString: () => `id:${name}` }),
      get: (id: { toString(): string }) => ({
        invalidate: async (cmd: InvalidationCommand): Promise<CommitStamp> => {
          calls.push({ id: id.toString(), cmd });
          return { cursor: 7, epoch: 'do-epoch' };
        },
      }),
    } as never;

    const driver = durableObjectLive({
      binding: 'ROOM',
      gatewayPath: '/rooms/:id/ws',
      defaultRoom: 'lobby',
    });
    driver._initializeEnv({ ROOM: ns });

    const stamp = await driver.dispatch({ tags: ['crud:todos'] });
    expect(stamp).toEqual({ cursor: 7, epoch: 'do-epoch' });
    expect(calls[0]).toEqual({
      id: 'id:vela:ws:v2:%2Frooms%2F%3Aid%2Fws:lobby',
      cmd: { tags: ['crud:todos'], room: 'lobby' },
    });

    await driver.dispatch({ tags: ['x'], room: 'org:1' });
    expect(calls[1].id).toBe('id:vela:ws:v2:%2Frooms%2F%3Aid%2Fws:org%3A1');
  });

  it('applies locally inside the DO (local mode) and fails loudly without env', async () => {
    const applied: InvalidationCommand[] = [];
    const sink: LiveInvalidationSink = {
      applyInvalidation: async (cmd) => {
        applied.push(cmd);
        return { cursor: 1, epoch: 'e' };
      },
    };
    const driver = durableObjectLive({ binding: 'ROOM', gatewayPath: '/rooms/:id/ws' });
    driver.bind(sink);
    driver._setLocalMode();
    await driver.dispatch({ tags: ['t'] });
    expect(applied).toEqual([{ tags: ['t'] }]);

    const cold = durableObjectLive({ binding: 'ROOM', gatewayPath: '/rooms/:id/ws' });
    expect(() => cold.dispatch({ tags: ['t'] })).toThrow(/binding 'ROOM'/);
  });
});

describe('live queries inside the Durable Object', () => {
  const PATH = '/rooms/:id/ws';

  function makeModule(todos: Array<{ id: string; text: string }>) {
    @LiveResolver()
    @Injectable()
    class TodoLive {
      @LiveQuery('todos.list', { tags: ['crud:todos'] })
      list() {
        return todos;
      }
    }

    @WebSocketGateway({ path: PATH, roomParam: 'id' })
    class RoomsGateway {}

    @Module({
      imports: [
        WebSocketModule.forRoot(),
        LiveModule.forRoot({
          log: durableObjectCursorLog(),
          driver: durableObjectLive({ binding: 'ROOM', gatewayPath: PATH }),
        }),
      ],
      providers: [RoomsGateway, TodoLive],
    })
    class AppModule {}
    return { AppModule, TodoLive };
  }

  const subEnvelope = (sub: string, query: string, extra?: Record<string, unknown>): string =>
    JSON.stringify({
      event: '$live',
      data: { t: 'sub', sub, query, args: {}, v: LIVE_PROTOCOL, ...extra },
    });

  it('subscribes over the hibernation socket, pushes with SQLite-backed stamps, survives eviction', async () => {
    const todos = [{ id: 't1', text: 'first' }];
    const storage = { sql: sqlStorage() };
    const ctx = new FakeDoState(storage);
    const { AppModule } = makeModule(todos);

    // --- first DO lifetime -------------------------------------------------
    const runtime = await buildDoRuntime(AppModule, ctx, {});
    expect(runtime.live).toBeDefined();
    const host = new DoWebSocketHost(
      ctx,
      runtime.dispatcher,
      runtime.registry,
      runtime.gatewayPaths,
    );

    const ws = new FakeWs();
    await expect(acceptTrusted(host, ws)).resolves.toBe(true);
    await host.onMessage(ws, subEnvelope('s1', 'todos.list'));

    const frames = ws.liveFrames();
    expect(frames[0]).toEqual({ t: 'ack', sub: 's1' });
    expect(frames[1]).toMatchObject({ t: 'data', sub: 's1', cursor: 0 });
    const epoch = frames[1].epoch as string;

    const stamp = await runtime.live!.applyInvalidation({ tags: ['crud:todos'] });
    expect(stamp).toEqual({ cursor: 1, epoch });
    await runtime.live!.whenIdle();
    expect(ws.liveFrames().at(-1)).toMatchObject({ t: 'settled', cursor: 1, epoch }); // unchanged result

    // --- eviction: fresh runtime over the same ctx/storage ------------------
    MetadataRegistry.clear();
    const { AppModule: AppModule2 } = makeModule(todos);
    const woken = await buildDoRuntime(AppModule2, ctx, {});

    todos.push({ id: 't2', text: 'second' });
    const stamp2 = await woken.live!.applyInvalidation({ tags: ['crud:todos'] });
    expect(stamp2).toEqual({ cursor: 2, epoch }); // same timeline, monotonic cursor
    await woken.live!.whenIdle();

    // The subscription was replayed from the hibernation attachment: the
    // socket gets the new result — as a snapshot (baseline dropped on wake).
    const afterWake = ws.liveFrames().at(-1)!;
    expect(afterWake).toMatchObject({ t: 'data', sub: 's1', cursor: 2, epoch });
    expect(afterWake.snapshot).toEqual([
      { id: 't1', text: 'first' },
      { id: 't2', text: 'second' },
    ]);
  });

  it('answers cursor-carrying resubscribes with resume (untouched) or data (touched)', async () => {
    const todos = [{ id: 't1', text: 'first' }];
    const storage = { sql: sqlStorage() };
    const ctx = new FakeDoState(storage);
    const { AppModule } = makeModule(todos);
    const runtime = await buildDoRuntime(AppModule, ctx, {});
    const host = new DoWebSocketHost(
      ctx,
      runtime.dispatcher,
      runtime.registry,
      runtime.gatewayPaths,
    );

    const first = new FakeWs();
    await expect(acceptTrusted(host, first)).resolves.toBe(true);
    await host.onMessage(first, subEnvelope('s1', 'todos.list'));
    const epoch = first.liveFrames()[1].epoch as string;

    await runtime.live!.applyInvalidation({ tags: ['unrelated'] }); // cursor 1
    await runtime.live!.whenIdle();

    // Reconnect with cursor 0: untouched tags → tiny resume at cursor 1.
    const second = new FakeWs();
    await expect(acceptTrusted(host, second)).resolves.toBe(true);
    await host.onMessage(
      second,
      subEnvelope('r1', 'todos.list', { sinceCursor: 0, sinceEpoch: epoch }),
    );
    expect(second.liveFrames()).toEqual([
      { t: 'ack', sub: 'r1' },
      { t: 'resume', sub: 'r1', cursor: 1, epoch },
    ]);

    await runtime.live!.applyInvalidation({ tags: ['crud:todos'] }); // cursor 2, touches the query
    await runtime.live!.whenIdle();
    const third = new FakeWs();
    await expect(acceptTrusted(host, third)).resolves.toBe(true);
    await host.onMessage(
      third,
      subEnvelope('r2', 'todos.list', { sinceCursor: 0, sinceEpoch: epoch }),
    );
    expect(third.liveFrames()[1]).toMatchObject({ t: 'data', sub: 'r2', cursor: 2 });
  });
});
