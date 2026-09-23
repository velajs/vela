import { describe, expect, it } from 'vitest';
import { Module, VelaFactory } from '@velajs/vela';
import { WebSocketGateway, WebSocketModule, WsDispatcher } from '@velajs/vela/websocket';
import type { WsClient } from '@velajs/vela/websocket';
import {
  COMMIT_CURSOR_HEADER,
  COMMIT_EPOCH_HEADER,
  LiveEngine,
  LiveInvalidation,
  LiveModule,
  LiveQuery,
  LiveResolver,
} from '@velajs/vela/live';
import { createLiveClient } from '../src/live-client';
import { defineLiveQuery } from '@velajs/live-protocol';
import { emptyArgs } from './schema-fixtures';
import type { WebSocketLike } from '../src/types';

/**
 * True cross-package e2e: the REAL @velajs/client speaking to the REAL
 * @velajs/vela/live engine through an in-memory socket pair (no network) —
 * subscribe → data → invalidate → delta → settled, optimistic gating on the
 * commit headers a mutation route stamps, and reconnect resume/snapshot.
 * Both sides also run the shared golden fixtures in their own suites, so this
 * focuses on the LIVE loop, not frame encoding.
 */

const PATH = '/rooms/:id/ws';

/** The server side of one in-memory connection. */
class ServerSocket implements WsClient {
  data: Record<string, unknown> = {
    principal: {
      issuer: 'https://in-memory.test',
      subject: 'integration-user',
      principalType: 'user',
    },
    tenantId: 'integration-tenant',
    expiresAtMs: Date.now() + 60_000,
  };
  readonly rooms = new Set<string>(['default']);
  readonly raw = null;
  onFrame?: (raw: string) => void;
  dead = false;
  constructor(public readonly id: string) {}
  send(event: string, data?: unknown, id?: string): void {
    this.sendRaw(JSON.stringify({ id, event, data }));
  }
  sendRaw(payload: string): void {
    if (this.dead) throw new Error('socket closed');
    this.onFrame?.(payload);
  }
  join(): void {}
  leave(): void {}
  commit(): void {}
  close(): void {
    this.dead = true;
  }
}

describe('client ↔ vela live e2e (in-memory transport)', () => {
  async function makeStack() {
    const todos: Array<{ id: string; text: string }> = [{ id: 't1', text: 'first' }];

    const todoList = defineLiveQuery({
      args: { parse: emptyArgs },
      result: {
        parse(value: unknown) {
          if (!Array.isArray(value)) throw new Error('Expected todos');
          return value.map((row: unknown) => {
            if (
              typeof row !== 'object' ||
              row === null ||
              !('id' in row) ||
              typeof row.id !== 'string' ||
              !('text' in row) ||
              typeof row.text !== 'string'
            )
              throw new Error('Invalid todo');
            return { id: row.id, text: row.text };
          });
        },
      },
    });

    @LiveResolver()
    class TodoLive {
      @LiveQuery('todos.list', todoList, { tags: ['crud:todos'] })
      list() {
        return todos;
      }
    }

    @WebSocketGateway({ path: PATH, roomParam: 'id' })
    class RoomsGateway {}

    @Module({
      imports: [WebSocketModule.forRoot({}), LiveModule.forRoot({})],
      providers: [RoomsGateway, TodoLive],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const dispatcher = app.get(WsDispatcher);
    const engine = app.get(LiveEngine);
    const invalidation = app.get(LiveInvalidation);

    let connSeq = 0;
    const received: string[] = [];
    let latest: { socket: WebSocketLike; server: ServerSocket } | undefined;
    // The client's injected WebSocket: opens an in-memory pipe into the
    // dispatcher, exactly what a node transport does with a real socket.
    const makeSocket = (): WebSocketLike => {
      connSeq += 1;
      const server = new ServerSocket(`conn-${connSeq}`);
      const socket: WebSocketLike = {
        readyState: 0,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send(raw: string) {
          void dispatcher.dispatchMessage(PATH, server, raw);
        },
        close() {
          socket.readyState = 3;
          server.dead = true;
          void dispatcher.handleClose(PATH, server, 1000, '');
          socket.onclose?.();
        },
      };
      server.onFrame = (raw) => {
        received.push(raw);
        socket.onmessage?.({ data: raw });
      };
      latest = { socket, server };
      queueMicrotask(() => {
        void Promise.resolve(dispatcher.handleOpen(PATH, server)).then(() => {
          socket.readyState = 1;
          socket.onopen?.();
        });
      });
      return socket;
    };

    /** Server-side drop (network blip): the client's reconnect logic takes over. */
    const dropFromServer = async (): Promise<void> => {
      if (!latest) return;
      const { socket, server } = latest;
      server.dead = true;
      await dispatcher.handleClose(PATH, server, 1006, 'dropped');
      socket.readyState = 3;
      socket.onclose?.();
    };

    const lastLiveFrame = (): { t: string } | undefined => {
      for (let index = received.length - 1; index >= 0; index -= 1) {
        const raw = received[index];
        if (raw === undefined) continue;
        const envelope = JSON.parse(raw) as { event: string; data: { t: string } };
        if (envelope.event === '$live') return envelope.data;
      }
      return undefined;
    };

    // A "mutation route": mutates, invalidates, stamps commit headers —
    // what the CRUD bridge / stampCommitHeaders do in a real app.
    const serverFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { text?: string };
      todos.push({ id: `t${todos.length + 1}`, text: body.text ?? '' });
      const stamp = await invalidation.invalidate({ tags: ['crud:todos'] });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          [COMMIT_CURSOR_HEADER]: String(stamp?.cursor),
          [COMMIT_EPOCH_HEADER]: stamp?.epoch ?? '',
        },
      });
    }) as typeof fetch;

    const client = createLiveClient({
      queries: { 'todos.list': todoList },
      url: 'http://in-memory.test',
      WebSocket: makeSocket,
      fetch: serverFetch,
      reconnect: { baseMs: 1, capMs: 2 },
    });

    return { client, engine, invalidation, todos, dropFromServer, lastLiveFrame };
  }

  const settle = async (engine: { whenIdle(): Promise<void> }, rounds = 3) => {
    for (let i = 0; i < rounds; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await engine.whenIdle();
    }
  };

  it('runs the full live loop: subscribe → snapshot → invalidate → delta → settled', async () => {
    const { client, engine, invalidation, todos } = await makeStack();
    const seen: unknown[] = [];
    client.subscribe('todos.list', {}, (value) => seen.push(value));
    await settle(engine);
    expect(seen.at(-1)).toEqual([{ id: 't1', text: 'first' }]);

    todos.push({ id: 't2', text: 'second' });
    await invalidation.invalidate({ tags: ['crud:todos'] });
    await settle(engine);
    expect(seen.at(-1)).toEqual([
      { id: 't1', text: 'first' },
      { id: 't2', text: 'second' },
    ]);

    // No actual change → settled → no new notification.
    const count = seen.length;
    await invalidation.invalidate({ tags: ['crud:todos'] });
    await settle(engine);
    expect(seen.length).toBe(count);
  });

  it('gates optimistic drops on the commit cursor stamped by the mutation', async () => {
    const { client, engine } = await makeStack();
    const seen: unknown[][] = [];
    client.subscribe('todos.list', {}, (value) => seen.push(value as unknown[]));
    await settle(engine);

    await client.mutate(
      '/todos',
      { text: 'optimistic' },
      {
        optimistic: {
          query: 'todos.list',
          args: {},
          apply: (current) => [
            ...((current as unknown[]) ?? []),
            { id: 'temp', text: 'optimistic' },
          ],
        },
      },
    );
    // Painted immediately (before/while the server processes).
    expect(seen.some((value) => value.some((row) => (row as { id: string }).id === 'temp'))).toBe(
      true,
    );

    await settle(engine);
    const final = seen.at(-1) as Array<{ id: string; text: string }>;
    // The authoritative row replaced the overlay; the temp row is gone.
    expect(final.map((row) => row.id)).toEqual(['t1', 't2']);
    expect(final.at(-1)?.text).toBe('optimistic');
  });

  it('resumes an untouched subscription across a reconnect and re-snapshots a touched one', async () => {
    const { client, engine, invalidation, todos, dropFromServer, lastLiveFrame } =
      await makeStack();
    const seen: unknown[] = [];
    client.subscribe('todos.list', {}, (value) => seen.push(value));
    await settle(engine);
    expect(seen.at(-1)).toEqual([{ id: 't1', text: 'first' }]);

    // Blip with NOTHING relevant changed → the server answers the cursor-carrying
    // resubscribe with a tiny `resume`; the cached value is kept, no re-run.
    await dropFromServer();
    await settle(engine, 6); // jittered reconnect (1–2 ms) + resubscribe
    expect(lastLiveFrame()?.t).toBe('resume');
    expect(client.peek('todos.list', {})).toEqual([{ id: 't1', text: 'first' }]);

    // Blip with a RELEVANT change while offline → full re-snapshot.
    await dropFromServer();
    todos.push({ id: 't2', text: 'while away' });
    await invalidation.invalidate({ tags: ['crud:todos'] });
    await settle(engine, 6);
    expect(lastLiveFrame()?.t).toBe('data');
    expect(seen.at(-1)).toEqual([
      { id: 't1', text: 'first' },
      { id: 't2', text: 'while away' },
    ]);
  });
});
