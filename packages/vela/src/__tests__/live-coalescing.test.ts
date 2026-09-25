import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Module, VelaFactory } from '../index.js';
import { WebSocketGateway, WebSocketModule, WsDispatcher } from '../websocket/index.js';
import type { WsClient } from '../websocket/index.js';
import {
  LIVE_PROTOCOL,
  LiveEngine,
  LiveInvalidation,
  LiveModule,
  LiveQuery,
  LiveResolver,
  defineLiveQuery,
} from '../live/index.js';
import type { LiveQueryContext, ServerLiveFrame } from '../live/index.js';

const versionQuery = defineLiveQuery({
  name: 'shared.list',
  args: z.unknown(),
  result: z.object({ version: z.number() }),
});
const rowsQuery = defineLiveQuery({
  name: 'shared.list',
  args: z.unknown(),
  result: z.array(z.object({ id: z.string(), uuid: z.string(), text: z.string() })),
});
const tenantQuery = defineLiveQuery({
  name: 'shared.list',
  args: z.unknown(),
  result: z.object({ tenantId: z.unknown(), version: z.number() }),
});
const executionsQuery = defineLiveQuery({
  name: 'shared.list',
  args: z.unknown(),
  result: z.object({ executions: z.number() }),
});
const idQuery = defineLiveQuery({
  name: 'shared.list',
  args: z.object({ id: z.number() }),
  result: z.object({ id: z.number() }),
});
const pathQuery = defineLiveQuery({
  name: 'gateway.list',
  args: z.object({ listId: z.string() }),
  result: z.object({ path: z.string(), version: z.number() }),
});

interface RawFrame {
  event: string;
  data: ServerLiveFrame;
}

class CoalescingClient implements WsClient {
  readonly rooms = new Set<string>();
  readonly raw = null;
  readonly frames: RawFrame[] = [];
  data: Record<string, unknown>;
  closed?: { code?: number; reason?: string };

  constructor(
    public readonly id: string,
    identity: Record<string, unknown>,
  ) {
    this.data = {
      principal: { issuer: 'test', subject: id, principalType: 'user' },
      expiresAtMs: Date.now() + 60_000,
      ...identity,
    };
  }

  send(): void {}

  trySendRaw(payload: string): 'accepted' {
    this.sendRaw(payload);
    return 'accepted';
  }

  sendRaw(payload: string): void {
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
    return this.frames.filter((frame) => frame.event === '$live').map((frame) => frame.data);
  }

  clear(): void {
    this.frames.length = 0;
  }
}

function subscribeFrame(sub: string, args: unknown, extra?: Record<string, unknown>): string {
  return JSON.stringify({
    event: '$live',
    data: { t: 'sub', sub, query: 'shared.list', args, v: LIVE_PROTOCOL, ...extra },
  });
}

function pathSubscribeFrame(sub: string): string {
  return JSON.stringify({
    event: '$live',
    data: { t: 'sub', sub, query: pathQuery.name, args: { listId: 'l1' }, v: LIVE_PROTOCOL },
  });
}

function tenantPartition(_args: unknown, context: LiveQueryContext): string | undefined {
  const tenantId = context.identity?.tenantId;
  return typeof tenantId === 'string' ? tenantId : undefined;
}

describe('LiveEngine refresh execution coalescing', () => {
  it('keeps resolver execution per subscription unless coalesceBy opts in', async () => {
    let version = 1;
    let executions = 0;

    @LiveResolver()
    class SharedList {
      @LiveQuery(versionQuery, { tags: ['rows'] })
      list() {
        executions += 1;
        return { version };
      }
    }

    @WebSocketGateway({ path: '/ws' })
    class Gateway {}

    @Module({
      imports: [WebSocketModule.forRoot(), LiveModule.forRoot()],
      providers: [Gateway, SharedList],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const dispatcher = app.get(WsDispatcher);
    const engine = app.get(LiveEngine);
    const invalidation = app.get(LiveInvalidation);
    const first = new CoalescingClient('c1', { tenantId: 'tenant-a' });
    const second = new CoalescingClient('c2', { tenantId: 'tenant-a' });

    await dispatcher.dispatchMessage('/ws', first, subscribeFrame('s1', { listId: 'l1' }));
    await dispatcher.dispatchMessage('/ws', second, subscribeFrame('s2', { listId: 'l1' }));
    version = 2;
    await invalidation.invalidate({ tags: ['rows'] });
    await engine.whenIdle();

    expect(executions).toBe(4); // two initial executions + two unshared refreshes
  });

  it('runs canonical identical args once per pass and fans out against each baseline', async () => {
    const rows: Array<{ id: string; uuid: string; text: string }> = [
      { id: 'r1', uuid: 'u1', text: 'unchanged '.repeat(200) },
    ];
    let executions = 0;
    let authorizationChecks = 0;

    @LiveResolver()
    class SharedList {
      @LiveQuery(rowsQuery, {
        tags: ['rows'],
        coalesceBy: tenantPartition,
      })
      list() {
        executions += 1;
        return rows;
      }
    }

    @WebSocketGateway({ path: '/ws' })
    class Gateway {}

    @Module({
      imports: [
        WebSocketModule.forRoot(),
        LiveModule.forRoot({
          authorizeDelivery: () => {
            authorizationChecks += 1;
            return true;
          },
        }),
      ],
      providers: [Gateway, SharedList],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const dispatcher = app.get(WsDispatcher);
    const engine = app.get(LiveEngine);
    const invalidation = app.get(LiveInvalidation);
    const first = new CoalescingClient('c1', { tenantId: 'tenant-a' });
    const second = new CoalescingClient('c2', { tenantId: 'tenant-a' });

    await dispatcher.dispatchMessage(
      '/ws',
      first,
      subscribeFrame('s1', { listId: 'l1', filter: { done: false, owner: 'all' } }),
    );
    rows.push({ id: 'r2', uuid: 'u2', text: 'second' });
    await dispatcher.dispatchMessage(
      '/ws',
      second,
      subscribeFrame(
        's2',
        { filter: { owner: 'all', done: false }, listId: 'l1' },
        { key: 'uuid' },
      ),
    );
    expect(executions).toBe(2); // initial subscriptions deliberately execute independently

    first.clear();
    second.clear();
    authorizationChecks = 0;
    await invalidation.invalidate({ tags: ['unrelated'] });
    await engine.whenIdle();
    expect(executions).toBe(2); // BYO-DB tags remain the refresh gate

    rows.push({ id: 'r3', uuid: 'u3', text: 'third' });
    await invalidation.invalidate({ tags: ['rows'] });
    await engine.whenIdle();

    expect(executions).toBe(3);
    expect(authorizationChecks).toBe(2); // delivery authorization remains per subscription
    expect(first.live()).toEqual([
      expect.objectContaining({
        t: 'delta',
        sub: 's1',
        ops: [
          expect.objectContaining({ op: 'insert', key: 'r2' }),
          expect.objectContaining({ op: 'insert', key: 'r3' }),
        ],
        cursor: 2,
      }),
    ]);
    expect(second.live()).toEqual([
      expect.objectContaining({
        t: 'delta',
        sub: 's2',
        ops: [expect.objectContaining({ op: 'insert', key: 'u3' })],
        cursor: 2,
      }),
    ]);

    first.clear();
    second.clear();
    await invalidation.invalidate({ tags: ['rows'] });
    await engine.whenIdle();
    expect(executions).toBe(4); // the Promise cache never survives into the next pass
  });

  it('never shares executions across distinct authorization partitions', async () => {
    let version = 1;
    let executions = 0;

    @LiveResolver()
    class SharedList {
      @LiveQuery(tenantQuery, { tags: ['rows'], coalesceBy: tenantPartition })
      list(_args: unknown, context: LiveQueryContext) {
        executions += 1;
        return { tenantId: context.identity?.tenantId, version };
      }
    }

    @WebSocketGateway({ path: '/ws' })
    class Gateway {}

    @Module({
      imports: [WebSocketModule.forRoot(), LiveModule.forRoot()],
      providers: [Gateway, SharedList],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const dispatcher = app.get(WsDispatcher);
    const engine = app.get(LiveEngine);
    const invalidation = app.get(LiveInvalidation);
    const first = new CoalescingClient('c1', { tenantId: 'tenant-a' });
    const second = new CoalescingClient('c2', { tenantId: 'tenant-b' });

    await dispatcher.dispatchMessage('/ws', first, subscribeFrame('s1', { listId: 'l1' }));
    await dispatcher.dispatchMessage('/ws', second, subscribeFrame('s2', { listId: 'l1' }));
    first.clear();
    second.clear();

    version = 2;
    await invalidation.invalidate({ tags: ['rows'] });
    await engine.whenIdle();

    expect(executions).toBe(4); // two initial runs + one refresh per tenant partition
    expect(first.live()[0]).toMatchObject({
      t: 'data',
      snapshot: { tenantId: 'tenant-a', version: 2 },
    });
    expect(second.live()[0]).toMatchObject({
      t: 'data',
      snapshot: { tenantId: 'tenant-b', version: 2 },
    });
  });

  it('authorizes each record before its coalescing callback or shared execution', async () => {
    let version = 1;
    let executions = 0;
    let deniedClientId: string | undefined;
    const partitionedClients: string[] = [];

    @LiveResolver()
    class SharedList {
      @LiveQuery(versionQuery, {
        tags: ['rows'],
        coalesceBy: (_args, context) => {
          partitionedClients.push(context.clientId);
          return 'all-authorized-subscribers';
        },
      })
      list() {
        executions += 1;
        return { version };
      }
    }

    @WebSocketGateway({ path: '/ws' })
    class Gateway {}

    @Module({
      imports: [
        WebSocketModule.forRoot(),
        LiveModule.forRoot({ authorizeDelivery: ({ client }) => client.id !== deniedClientId }),
      ],
      providers: [Gateway, SharedList],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const dispatcher = app.get(WsDispatcher);
    const engine = app.get(LiveEngine);
    const invalidation = app.get(LiveInvalidation);
    const denied = new CoalescingClient('denied', { tenantId: 'tenant-a' });
    const allowed = new CoalescingClient('allowed', { tenantId: 'tenant-a' });

    await dispatcher.dispatchMessage('/ws', denied, subscribeFrame('s1', {}));
    await dispatcher.dispatchMessage('/ws', allowed, subscribeFrame('s2', {}));
    partitionedClients.length = 0;
    denied.clear();
    allowed.clear();

    deniedClientId = denied.id;
    version = 2;
    await invalidation.invalidate({ tags: ['rows'] });
    await engine.whenIdle();

    expect(partitionedClients).toEqual(['allowed']);
    expect(executions).toBe(3); // two seeds + only the authorized refresh
    expect(denied.live()).toEqual([]);
    expect(denied.closed?.code).toBe(1008);
    expect(allowed.live()[0]).toMatchObject({ t: 'data', snapshot: { version: 2 } });
  });

  it('fails closed to independent runs when partition keys throw or exceed their bound', async () => {
    let executions = 0;

    @LiveResolver()
    class SharedList {
      @LiveQuery(executionsQuery, {
        tags: ['rows'],
        coalesceBy: (_args, context) => {
          const tenantId = context.identity?.tenantId;
          if (tenantId === 'throw') throw new Error('bad partition');
          return tenantId === 'large-key' ? 'x'.repeat(257) : 'valid';
        },
      })
      list() {
        executions += 1;
        return { executions };
      }
    }

    @WebSocketGateway({ path: '/ws' })
    class Gateway {}

    @Module({
      imports: [WebSocketModule.forRoot(), LiveModule.forRoot()],
      providers: [Gateway, SharedList],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const dispatcher = app.get(WsDispatcher);
    const engine = app.get(LiveEngine);
    const invalidation = app.get(LiveInvalidation);
    const clients = [
      new CoalescingClient('throw-1', { tenantId: 'throw' }),
      new CoalescingClient('throw-2', { tenantId: 'throw' }),
      new CoalescingClient('large-1', { tenantId: 'large-key' }),
      new CoalescingClient('large-2', { tenantId: 'large-key' }),
      new CoalescingClient('args-1', { tenantId: 'valid' }),
      new CoalescingClient('args-2', { tenantId: 'valid' }),
    ];

    for (const [index, client] of clients.entries()) {
      // Subscription setup is intentionally ordered; refresh execution remains bounded separately.
      // eslint-disable-next-line no-await-in-loop
      await dispatcher.dispatchMessage(
        '/ws',
        client,
        subscribeFrame(
          `s${String(index)}`,
          client.id.startsWith('args-') ? { blob: 'x'.repeat(4_097) } : {},
        ),
      );
      client.clear();
    }

    await invalidation.invalidate({ tags: ['rows'] });
    await engine.whenIdle();

    expect(executions).toBe(12); // six initial + six independent refresh executions
    expect(clients.every((client) => client.live().length === 1)).toBe(true);
  });

  it('bounds fulfilled groups instead of retaining every high-cardinality key for the pass', async () => {
    let executions = 0;

    @LiveResolver()
    class SharedList {
      @LiveQuery(idQuery, {
        tags: ['rows'],
        coalesceBy: () => 'same-result-partition',
      })
      list(args: { id: number }) {
        executions += 1;
        return { id: args.id };
      }
    }

    @WebSocketGateway({ path: '/ws' })
    class Gateway {}

    @Module({
      imports: [WebSocketModule.forRoot(), LiveModule.forRoot()],
      providers: [Gateway, SharedList],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const dispatcher = app.get(WsDispatcher);
    const engine = app.get(LiveEngine);
    const invalidation = app.get(LiveInvalidation);
    // 257 unique keys exceed the 256-group pass cap; repeat the oldest key at
    // the end so an unbounded cache would save one execution (and fail this).
    const clients = Array.from(
      { length: 258 },
      (_, index) => new CoalescingClient(`c${String(index)}`, { tenantId: 'tenant-a' }),
    );

    for (const [index, client] of clients.entries()) {
      // Subscription setup is deliberately serialized; initial runs never share.
      // eslint-disable-next-line no-await-in-loop
      await dispatcher.dispatchMessage(
        '/ws',
        client,
        subscribeFrame(`s${String(index)}`, { id: index === clients.length - 1 ? 0 : index }),
      );
    }
    expect(executions).toBe(258);

    await invalidation.invalidate({ tags: ['rows'] });
    await engine.whenIdle();

    expect(executions).toBe(516);
  });

  it("never shares a run across gateways, so each subscriber sees its own gateway's result", async () => {
    let version = 1;
    let executions = 0;

    @LiveResolver()
    class SharedList {
      @LiveQuery(pathQuery, { tags: ['rows'], coalesceBy: () => 'all-subscribers' })
      list(_args: unknown, context: LiveQueryContext) {
        executions += 1;
        return { path: context.path, version };
      }
    }

    @WebSocketGateway({ path: '/alpha' })
    class AlphaGateway {}

    @WebSocketGateway({ path: '/beta' })
    class BetaGateway {}

    @Module({
      imports: [WebSocketModule.forRoot(), LiveModule.forRoot()],
      providers: [AlphaGateway, BetaGateway, SharedList],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const dispatcher = app.get(WsDispatcher);
    const engine = app.get(LiveEngine);
    const invalidation = app.get(LiveInvalidation);
    const alpha = new CoalescingClient('alpha-1', { tenantId: 'tenant-a' });
    const alphaPeer = new CoalescingClient('alpha-2', { tenantId: 'tenant-a' });
    const beta = new CoalescingClient('beta-1', { tenantId: 'tenant-a' });

    await dispatcher.dispatchMessage('/alpha', alpha, pathSubscribeFrame('s1'));
    await dispatcher.dispatchMessage('/alpha', alphaPeer, pathSubscribeFrame('s2'));
    await dispatcher.dispatchMessage('/beta', beta, pathSubscribeFrame('s3'));
    for (const client of [alpha, alphaPeer, beta]) client.clear();

    version = 2;
    await invalidation.invalidate({ tags: ['rows'] });
    await engine.whenIdle();

    // Three initial runs, then one refresh per gateway: the two /alpha
    // subscribers still share theirs.
    expect(executions).toBe(5);
    expect(alpha.live()[0]).toMatchObject({ t: 'data', snapshot: { path: '/alpha', version: 2 } });
    expect(alphaPeer.live()[0]).toMatchObject({
      t: 'data',
      snapshot: { path: '/alpha', version: 2 },
    });
    expect(beta.live()[0]).toMatchObject({ t: 'data', snapshot: { path: '/beta', version: 2 } });
  });
});
