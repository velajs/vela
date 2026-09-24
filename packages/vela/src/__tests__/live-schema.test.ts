import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { isServerLiveFrame, readLiveEnvelope } from '@velajs/live-protocol';
import { Injectable, Module, UseInterceptors, VelaFactory } from '../index';
import { WebSocketGateway, WebSocketModule, WsDispatcher } from '../websocket/index';
import type { CallHandler, ExecutionContext, NestInterceptor } from '../index';
import type { WsClient } from '../websocket/index';
import {
  LIVE_PROTOCOL,
  LIVE_SUBS_DATA_KEY,
  LiveEngine,
  LiveInvalidation,
  LiveModule,
  LiveQuery,
  LiveResolver,
  defineLiveQuery,
  readPersistedLiveSubscriptions,
} from '../live';
import type { ServerLiveFrame } from '../live';

class SchemaClient implements WsClient {
  readonly raw = null;
  readonly rooms = new Set<string>();
  readonly frames: ServerLiveFrame[] = [];
  data: Record<string, unknown> = {
    principal: { issuer: 'test', subject: 'u1', principalType: 'user' },
    tenantId: 't1',
    expiresAtMs: Date.now() + 60_000,
  };

  constructor(readonly id = 'schema-client') {}
  send(): void {}
  sendRaw(payload: string): void {
    const envelope: unknown = JSON.parse(payload);
    const frame = readLiveEnvelope(envelope);
    if (!isServerLiveFrame(frame)) throw new Error('invalid live frame');
    this.frames.push(frame);
  }
  join(room: string): void {
    this.rooms.add(room);
  }
  leave(room: string): void {
    this.rooms.delete(room);
  }
  commit(): void {}
  close(): void {}
}

function subscribe(query: string, args?: unknown, sub = 's1'): string {
  return JSON.stringify({ event: '$live', data: { t: 'sub', sub, query, args, v: LIVE_PROTOCOL } });
}

describe('shared live query schemas', () => {
  it('binds transformed args once per subscription and reparses original input on restore', async () => {
    const parseArgs = vi.fn((input: unknown) => {
      const parsed = z.object({ n: z.string() }).parse(input);
      return { n: Number(parsed.n) };
    });
    const definition = defineLiveQuery({
      name: 'count',
      args: { parse: parseArgs },
      result: z.object({ count: z.number() }),
    });

    @LiveResolver()
    class Resolver {
      private readonly multiplier = 2;
      @LiveQuery(definition, { tags: (args) => [`n:${args.n}`] })
      count(args: { n: number }) {
        return { count: args.n * this.multiplier };
      }
    }
    @WebSocketGateway({ path: '/ws' })
    class Gateway {}
    @Module({
      imports: [WebSocketModule.forRoot({}), LiveModule.forRoot({})],
      providers: [Gateway, Resolver],
    })
    class App {}

    const app = await VelaFactory.create(App);
    try {
      const dispatcher = app.get(WsDispatcher);
      const engine = app.get(LiveEngine);
      const invalidation = app.get(LiveInvalidation);
      const first = new SchemaClient('first');
      await dispatcher.dispatchMessage('/ws', first, subscribe('count', { n: '3' }));
      expect(parseArgs).toHaveBeenCalledTimes(1);
      await invalidation.invalidate({ tags: ['n:3'] });
      await engine.whenIdle();
      expect(parseArgs).toHaveBeenCalledTimes(1);
      expect(first.frames).toContainEqual(
        expect.objectContaining({ t: 'data', snapshot: { count: 6 } }),
      );

      const stored = readPersistedLiveSubscriptions(first);
      expect(stored[0]?.args).toEqual({ n: '3' });
      const resumed = new SchemaClient('resumed');
      resumed.data[LIVE_SUBS_DATA_KEY] = stored;
      for (const record of readPersistedLiveSubscriptions(resumed))
        engine.restoreSubscription('/ws', resumed, record);
      expect(parseArgs).toHaveBeenCalledTimes(2);
      await invalidation.invalidate({ tags: ['n:3'] });
      await engine.whenIdle();
      expect(resumed.frames).toEqual([
        expect.objectContaining({ t: 'data', snapshot: { count: 6 } }),
      ]);
      expect(parseArgs).toHaveBeenCalledTimes(2);
    } finally {
      await app.dispose();
    }
  });

  it('validates after interceptors and never caches or delivers an invalid final result', async () => {
    let corrupt = false;
    let count = 1;
    const definition = defineLiveQuery({
      name: 'count',
      args: z.unknown(),
      result: z.object({ count: z.number() }),
    });

    @Injectable()
    class Rewrite implements NestInterceptor {
      async intercept(_context: ExecutionContext, next: CallHandler): Promise<unknown> {
        const result = await next.handle();
        return corrupt ? { count: 'invalid' } : result;
      }
    }
    @LiveResolver()
    class Resolver {
      @UseInterceptors(Rewrite)
      @LiveQuery(definition, { tags: ['count'] })
      count() {
        return { count, privateField: 'must be stripped by schema' };
      }
    }
    @WebSocketGateway({ path: '/ws' })
    class Gateway {}
    @Module({
      imports: [WebSocketModule.forRoot({}), LiveModule.forRoot({})],
      providers: [Gateway, Resolver, Rewrite],
    })
    class App {}

    const app = await VelaFactory.create(App);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const dispatcher = app.get(WsDispatcher);
      const engine = app.get(LiveEngine);
      const invalidation = app.get(LiveInvalidation);
      const client = new SchemaClient();
      await dispatcher.dispatchMessage('/ws', client, subscribe('count'));
      expect(client.frames[1]).toMatchObject({ t: 'data', snapshot: { count: 1 } });
      expect(client.frames[1]).not.toHaveProperty('snapshot.privateField');
      client.frames.length = 0;
      corrupt = true;
      count = 2;
      await invalidation.invalidate({ tags: ['count'] });
      await engine.whenIdle();
      expect(client.frames).toEqual([]);

      const rejected = new SchemaClient('rejected');
      await dispatcher.dispatchMessage('/ws', rejected, subscribe('count'));
      expect(rejected.frames).toEqual([
        { t: 'ack', sub: 's1' },
        expect.objectContaining({
          t: 'error',
          code: 'internal',
          message: 'Internal Server Error',
          fatal: true,
        }),
      ]);

      corrupt = false;
      await invalidation.invalidate({ tags: ['count'] });
      await engine.whenIdle();
      expect(client.frames).toEqual([
        expect.objectContaining({ t: 'data', snapshot: { count: 2 } }),
      ]);
    } finally {
      warning.mockRestore();
      error.mockRestore();
      await app.dispose();
    }
  });
});
