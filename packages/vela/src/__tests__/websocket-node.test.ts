import { describe, it, expect } from 'vitest';
import { VelaFactory, Module } from '../index.js';
import {
  WebSocketModule,
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  WebSocketServer,
  WsDispatcher,
  WS_ROOM_REGISTRY,
  InMemoryRoomRegistry,
  Gateways,
} from '../websocket/index.js';
import type {
  WsClient,
  WsServer,
  BroadcastCommand,
  OnGatewayConnection,
  UpgradeAuthenticator,
  WebSocketUpgradeAuthenticationContext,
  WebSocketUpgradeIdentity,
} from '../websocket/index.js';
import { NodeWsClient, registerWebSocketGateways, redis } from '../websocket-node/index.js';
import type { RedisPubSubClient } from '../websocket-node/index.js';
import type { WSContext, WSEvents, UpgradeWebSocket } from 'hono/ws';

class FakeWSContext {
  readonly sent: string[] = [];
  closed?: { code?: number; reason?: string };
  send(data: string | ArrayBuffer | Uint8Array): void {
    this.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  last(): { event: string; data: unknown; id?: string } {
    return JSON.parse(this.sent[this.sent.length - 1]);
  }
}

// Fake `upgradeWebSocket` that captures each route's `createEvents` so the
// socket lifecycle can be driven directly (no real server needed).
function capturingUpgrade() {
  const captured: Array<(c: unknown) => WSEvents | Promise<WSEvents>> = [];
  const upgrade = ((createEvents: (c: unknown) => WSEvents | Promise<WSEvents>) => {
    captured.push(createEvents);
    return async () => {};
  }) as unknown as UpgradeWebSocket;
  return { upgrade, captured };
}

class TestUpgradeAuthenticator implements UpgradeAuthenticator {
  authenticate(): WebSocketUpgradeIdentity {
    return {
      principal: { issuer: 'test', subject: 'u1', principalType: 'user' },
      tenantId: 't1',
      expiresAtMs: Date.now() + 60_000,
    };
  }
}

describe('NodeWsClient', () => {
  it('frames messages and mirrors room membership into the registry', () => {
    const registry = new InMemoryRoomRegistry();
    const ws = new FakeWSContext();
    const client = new NodeWsClient(ws as unknown as WSContext, registry, '/chat');

    client.send('hi', { n: 1 }, '7');
    expect(JSON.parse(ws.sent[0])).toEqual({ id: '7', event: 'hi', data: { n: 1 } });

    client.join('r1');
    expect([...client.rooms]).toEqual(['r1']);
    expect(registry.localIdsInRoom('r1')).toEqual([client.id]);

    client.leave('r1');
    expect([...client.rooms]).toEqual([]);
    expect(registry.localIdsInRoom('r1')).toEqual([]);
  });

  it('caps Node socket membership at 32 rooms', () => {
    const registry = new InMemoryRoomRegistry();
    const ws = new FakeWSContext();
    const client = new NodeWsClient(ws as unknown as WSContext, registry, '/chat');

    for (let index = 0; index < 32; index += 1) client.join(`room-${index}`);

    expect(client.rooms.size).toBe(32);
    expect(() => client.join('room-overflow')).toThrow(/at most 32 rooms/);
    expect(registry.localIdsInRoom('room-overflow')).toEqual([]);
  });

  it('closes with 1009 and never writes direct oversized outbound frames', () => {
    const registry = new InMemoryRoomRegistry();
    const ws = new FakeWSContext();
    const client = new NodeWsClient(ws as unknown as WSContext, registry, '/chat', 32);

    client.sendRaw('x'.repeat(33));
    expect(ws.sent).toEqual([]);
    expect(ws.closed).toEqual({ code: 1009, reason: 'Message too large' });

    const framed = new FakeWSContext();
    const framedClient = new NodeWsClient(framed as unknown as WSContext, registry, '/chat', 32);
    framedClient.send('large', 'x'.repeat(32));
    expect(framed.sent).toEqual([]);
    expect(framed.closed?.code).toBe(1009);
  });
});

describe('registerWebSocketGateways', () => {
  function chatApp() {
    @WebSocketGateway({
      path: '/rooms/:id/ws',
      roomParam: 'id',
      authenticator: TestUpgradeAuthenticator,
    })
    class RoomGateway {
      constructor(@WebSocketServer() private readonly server: WsServer) {}
      @SubscribeMessage('echo')
      onEcho(@MessageBody() body: { text: string }) {
        return { event: 'echo', data: body.text.toUpperCase() };
      }
      @SubscribeMessage('shout')
      onShout(@MessageBody() text: string, @ConnectedSocket() c: WsClient) {
        void this.server.to([...c.rooms][0]).emit('shout', text);
      }
    }
    @Module({ imports: [WebSocketModule.forRoot()], providers: [RoomGateway] })
    class AppModule {}
    return AppModule;
  }

  const ctxWithRoom = (id: string) => ({
    req: {
      raw: new Request(`http://localhost/rooms/${id}/ws`),
      param: (k: string) => (k === 'id' ? id : undefined),
    },
  });
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('dispatches messages to the gateway and replies on the socket', async () => {
    const app = await VelaFactory.create(chatApp());
    const { upgrade, captured } = capturingUpgrade();
    registerWebSocketGateways(app, upgrade);

    const events = await captured[0](ctxWithRoom('room1'));
    const ws = new FakeWSContext();
    events.onOpen?.(new Event('open'), ws as unknown as WSContext);
    await new Promise((resolve) => setTimeout(resolve, 0));

    events.onMessage?.(
      { data: JSON.stringify({ id: '1', event: 'echo', data: { text: 'hi' } }) } as MessageEvent,
      ws as unknown as WSContext,
    );
    await tick();

    expect(ws.last()).toEqual({ id: '1', event: 'echo', data: 'HI' });
  });

  it('applies the gateway ceiling to dispatcher replies before writing', async () => {
    @WebSocketGateway({
      path: '/limited-reply',
      maxFrameBytes: 48,
      authenticator: TestUpgradeAuthenticator,
    })
    class LimitedReplyGateway {
      @SubscribeMessage('large')
      onLarge() {
        return 'x'.repeat(100);
      }
    }
    @Module({ imports: [WebSocketModule.forRoot()], providers: [LimitedReplyGateway] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const { upgrade, captured } = capturingUpgrade();
    registerWebSocketGateways(app, upgrade);
    const events = await captured[0]({
      req: { raw: new Request('http://localhost/limited-reply'), param: () => undefined },
    });
    const ws = new FakeWSContext();
    events.onOpen?.(new Event('open'), ws as unknown as WSContext);
    await tick();

    events.onMessage?.(
      { data: JSON.stringify({ event: 'large' }) } as MessageEvent,
      ws as unknown as WSContext,
    );
    await tick();

    expect(ws.sent).toEqual([]);
    expect(ws.closed?.code).toBe(1009);
  });

  it('auto-joins the :id room so broadcasts reach every socket in it', async () => {
    const app = await VelaFactory.create(chatApp());
    const { upgrade, captured } = capturingUpgrade();
    registerWebSocketGateways(app, upgrade);
    const createEvents = captured[0];

    const wsA = new FakeWSContext();
    const wsB = new FakeWSContext();
    const evA = await createEvents(ctxWithRoom('room1'));
    const evB = await createEvents(ctxWithRoom('room1'));
    evA.onOpen?.(new Event('open'), wsA as unknown as WSContext);
    evB.onOpen?.(new Event('open'), wsB as unknown as WSContext);
    await tick();

    evA.onMessage?.(
      { data: JSON.stringify({ event: 'shout', data: 'hey' }) } as MessageEvent,
      wsA as unknown as WSContext,
    );
    await tick();

    expect(wsA.last()).toEqual({ event: 'shout', data: 'hey' });
    expect(wsB.last()).toEqual({ event: 'shout', data: 'hey' });
  });

  it('uses the declared non-id room parameter instead of collapsing the route', async () => {
    @WebSocketGateway({
      path: '/rooms/:roomId/ws',
      roomParam: 'roomId',
      authenticator: TestUpgradeAuthenticator,
    })
    class NamedRoomGateway {}
    @Module({ imports: [WebSocketModule.forRoot()], providers: [NamedRoomGateway] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const { upgrade, captured } = capturingUpgrade();
    registerWebSocketGateways(app, upgrade);
    const events = await captured[0]({
      req: {
        raw: new Request('http://localhost/rooms/alpha/ws'),
        param: (name: string) => (name === 'roomId' ? 'alpha' : undefined),
      },
    });
    const ws = new FakeWSContext();
    events.onOpen?.(new Event('open'), ws as unknown as WSContext);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const registry = app.get(WS_ROOM_REGISTRY) as InMemoryRoomRegistry;
    expect(registry.localIdsInRoom('alpha')).toHaveLength(1);
    expect(registry.localIdsInRoom('/rooms/:roomId/ws')).toHaveLength(0);
  });

  it("scopes a Gateways push to the named gateway's sockets when gateways share a room id", async () => {
    @WebSocketGateway({
      path: '/admin/:org/ws',
      roomParam: 'org',
      authenticator: TestUpgradeAuthenticator,
    })
    class AdminGateway {}
    @WebSocketGateway({
      path: '/chat/:org/ws',
      roomParam: 'org',
      authenticator: TestUpgradeAuthenticator,
    })
    class ChatGateway {}
    @Module({ imports: [WebSocketModule.forRoot()], providers: [AdminGateway, ChatGateway] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const { upgrade, captured } = capturingUpgrade();
    registerWebSocketGateways(app, upgrade);
    const orgContext = (path: string) => ({
      req: {
        raw: new Request(`http://localhost${path}`),
        param: (name: string) => (name === 'org' ? 'org-1' : undefined),
      },
    });
    const adminWs = new FakeWSContext();
    const chatWs = new FakeWSContext();
    const adminEvents = await captured[0](orgContext('/admin/org-1/ws'));
    const chatEvents = await captured[1](orgContext('/chat/org-1/ws'));
    adminEvents.onOpen?.(new Event('open'), adminWs as unknown as WSContext);
    chatEvents.onOpen?.(new Event('open'), chatWs as unknown as WSContext);
    await tick();

    const registry = app.get(WS_ROOM_REGISTRY);
    expect(registry.localIdsInRoom('org-1')).toHaveLength(2);

    await app.get(Gateways).of(AdminGateway).to('org-1').emit('audit', { action: 'granted' });
    expect(adminWs.sent.map((frame) => JSON.parse(frame))).toEqual([
      { event: 'audit', data: { action: 'granted' } },
    ]);
    expect(chatWs.sent).toEqual([]);

    await app.get(Gateways).of(ChatGateway).to('org-1').emit('message', 'hi');
    expect(chatWs.sent.map((frame) => JSON.parse(frame))).toEqual([
      { event: 'message', data: 'hi' },
    ]);
    expect(adminWs.sent).toHaveLength(1);
    await app.close();
  });

  it('rejects every parameterized room route unless roomParam is explicit', async () => {
    @WebSocketGateway({ path: '/tenants/:tenant/rooms/:room/ws' })
    class AmbiguousGateway {}
    @Module({ imports: [WebSocketModule.forRoot()], providers: [AmbiguousGateway] })
    class AppModule {}

    await expect(VelaFactory.create(AppModule)).rejects.toThrow(/roomParam explicitly/);
  });

  it('rejects a single parameter route without roomParam', async () => {
    @WebSocketGateway({ path: '/rooms/:id/ws' })
    class ImplicitGateway {}
    @Module({ imports: [WebSocketModule.forRoot()], providers: [ImplicitGateway] })
    class AppModule {}

    await expect(VelaFactory.create(AppModule)).rejects.toThrow(/roomParam explicitly/);
  });
});

describe('redis() sync driver', () => {
  // Shared in-memory pub/sub bus standing in for Redis.
  class Bus {
    private subs: Array<{ chans: Set<string>; cb: (ch: string, m: string) => void }> = [];
    client(): RedisPubSubClient {
      const chans = new Set<string>();
      const subs = this.subs;
      return {
        publish(channel, message) {
          for (const s of subs) if (s.chans.has(channel)) s.cb(channel, message);
        },
        subscribe(channel) {
          chans.add(channel);
        },
        on(_event, listener) {
          subs.push({ chans, cb: listener });
        },
      };
    }
  }

  function sink(id: string, path?: string) {
    const received: Array<{ event: string; data: unknown }> = [];
    const client: WsClient = {
      id,
      ...(path === undefined ? {} : { path }),
      rooms: new Set(),
      data: {},
      raw: null,
      send() {},
      sendRaw: (p: string) => received.push(JSON.parse(p)),
      join() {},
      leave() {},
      commit() {},
      close() {},
    };
    return Object.assign(client, { received });
  }

  it('delivers locally and fans out to peers, dropping its own echo', () => {
    const bus = new Bus();
    const regA = new InMemoryRoomRegistry();
    const driverA = redis({ pub: bus.client(), sub: bus.client() });
    driverA.bind(regA);
    const regB = new InMemoryRoomRegistry();
    const driverB = redis({ pub: bus.client(), sub: bus.client() });
    driverB.bind(regB);

    const a = sink('a');
    regA.join(a, 'room1');
    const b = sink('b');
    regB.join(b, 'room1');
    const c = sink('c');
    regB.join(c, 'other'); // not in room1

    driverA.dispatch({ rooms: ['room1'], frame: JSON.stringify({ event: 'x', data: 1 }) });

    expect(a.received).toEqual([{ event: 'x', data: 1 }]); // local, once (no echo dupe)
    expect(b.received).toEqual([{ event: 'x', data: 1 }]); // via redis fan-out
    expect(c.received).toEqual([]); // filtered out — not in room1
  });

  it("fans a gateway-scoped command out to that gateway's sockets on every instance", () => {
    const bus = new Bus();
    const regA = new InMemoryRoomRegistry();
    const driverA = redis({ pub: bus.client(), sub: bus.client() });
    driverA.bind(regA);
    const regB = new InMemoryRoomRegistry();
    const driverB = redis({ pub: bus.client(), sub: bus.client() });
    driverB.bind(regB);

    const localAdmin = sink('a', '/admin/:org/ws');
    regA.join(localAdmin, 'org-1');
    const localChat = sink('b', '/chat/:org/ws');
    regA.join(localChat, 'org-1');
    const peerAdmin = sink('c', '/admin/:org/ws');
    regB.join(peerAdmin, 'org-1');
    const peerChat = sink('d', '/chat/:org/ws');
    regB.join(peerChat, 'org-1');
    const unscoped = sink('e');
    regB.join(unscoped, 'org-1');

    driverA.dispatch({
      rooms: ['org-1'],
      gatewayPath: '/admin/:org/ws',
      frame: JSON.stringify({ event: 'audit', data: 1 }),
    });

    expect(localAdmin.received).toEqual([{ event: 'audit', data: 1 }]);
    expect(peerAdmin.received).toEqual([{ event: 'audit', data: 1 }]);
    expect(localChat.received).toEqual([]);
    expect(peerChat.received).toEqual([]);
    // A socket that names no gateway belongs to none: a scoped push skips it.
    expect(unscoped.received).toEqual([]);
  });

  it('drops a synchronized command whose gateway path is malformed', () => {
    let listener: ((channel: string, message: string) => void) | undefined;
    const sub: RedisPubSubClient = {
      publish() {},
      subscribe() {},
      on(_event, next) {
        listener = next;
      },
    };
    const driver = redis({ pub: { publish() {}, subscribe() {}, on() {} }, sub });
    const registry = new InMemoryRoomRegistry();
    driver.bind(registry);
    const member = sink('a', '/chat');
    registry.join(member, 'r1');
    const frame = JSON.stringify({ event: 'x', data: 1 });

    for (const gatewayPath of [42, 'x'.repeat(600)]) {
      listener?.('vela:ws:broadcast', JSON.stringify({ rooms: ['r1'], gatewayPath, frame }));
    }
    expect(member.received).toEqual([]);
    listener?.('vela:ws:broadcast', JSON.stringify({ rooms: ['r1'], gatewayPath: '/chat', frame }));
    expect(member.received).toEqual([{ event: 'x', data: 1 }]);
  });

  it('never publishes an oversized command and allows only an explicit raised ceiling', () => {
    let publishes = 0;
    const pub: RedisPubSubClient = {
      publish() {
        publishes += 1;
      },
      subscribe() {},
      on() {},
    };
    const sub: RedisPubSubClient = { publish() {}, subscribe() {}, on() {} };
    const driver = redis({ pub, sub });
    driver.bind(new InMemoryRoomRegistry());
    const command: BroadcastCommand = {
      rooms: ['r1'],
      frame: JSON.stringify({ event: 'large', data: 'x'.repeat(70 * 1024) }),
    };

    expect(() => driver.dispatch(command)).toThrow(/exceeds 65536/);
    expect(publishes).toBe(0);

    driver.setMaxFrameBytes?.(96 * 1024);
    expect(() => driver.dispatch(command)).not.toThrow();
    expect(publishes).toBe(1);
  });
});

describe('websocket-node — code-review regressions', () => {
  function regressionSink(id: string) {
    const received: Array<{ event: string; data: unknown }> = [];
    const client: WsClient = {
      id,
      rooms: new Set(),
      data: {},
      raw: null,
      send() {},
      sendRaw: (p: string) => received.push(JSON.parse(p)),
      join() {},
      leave() {},
      commit() {},
      close() {},
    };
    return Object.assign(client, { received });
  }

  it('redis dispatch swallows a failing publish and still delivers locally', () => {
    const registry = new InMemoryRoomRegistry();
    const failingPub: RedisPubSubClient = {
      publish: () => Promise.reject(new Error('redis down')),
      subscribe() {},
      on() {},
    };
    const noopSub: RedisPubSubClient = { publish() {}, subscribe() {}, on() {} };
    const driver = redis({ pub: failingPub, sub: noopSub });
    driver.bind(registry);

    const a = regressionSink('a');
    registry.join(a, 'r1');

    expect(() =>
      driver.dispatch({ rooms: ['r1'], frame: JSON.stringify({ event: 'x', data: 1 }) }),
    ).not.toThrow();
    expect(a.received).toEqual([{ event: 'x', data: 1 }]);
  });

  it('queues inbound messages until handleConnection resolves', async () => {
    const order: string[] = [];

    @WebSocketGateway({ path: '/ordered', authenticator: TestUpgradeAuthenticator })
    class OrderedGateway implements OnGatewayConnection {
      async handleConnection() {
        await new Promise((r) => setTimeout(r, 20));
        order.push('open');
      }
      @SubscribeMessage('go')
      onGo() {
        order.push('message');
      }
    }
    @Module({ imports: [WebSocketModule.forRoot()], providers: [OrderedGateway] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const captured: Array<(c: unknown) => WSEvents | Promise<WSEvents>> = [];
    const upgrade = ((createEvents: (c: unknown) => WSEvents | Promise<WSEvents>) => {
      captured.push(createEvents);
      return async () => {};
    }) as unknown as UpgradeWebSocket;
    registerWebSocketGateways(app, upgrade);

    const events = await captured[0]({
      req: { raw: new Request('http://localhost/ordered'), param: () => undefined },
    });
    const ws = new FakeWSContext();
    events.onOpen?.(new Event('open'), ws as unknown as WSContext);
    events.onMessage?.(
      { data: JSON.stringify({ event: 'go', data: {} }) } as MessageEvent,
      ws as unknown as WSContext,
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(order).toEqual(['open', 'message']); // message waited for handleConnection
  });

  it.each(['overflow', 'close'] as const)(
    'drops frames waiting for setup after %s',
    async (stop) => {
      let release!: () => void;
      const setup = new Promise<void>((resolve) => {
        release = resolve;
      });
      let hits = 0;
      @WebSocketGateway({
        path: '/setup-budget',
        authenticator: TestUpgradeAuthenticator,
        maxPendingMessages: 1,
      })
      class Gateway {
        async handleConnection() {
          await setup;
        }
        @SubscribeMessage('go') go() {
          hits++;
        }
      }
      @Module({ imports: [WebSocketModule.forRoot()], providers: [Gateway] })
      class App {}
      const app = await VelaFactory.create(App);
      try {
        const { upgrade, captured } = capturingUpgrade();
        registerWebSocketGateways(app, upgrade);
        const events = await captured[0]({
          req: { raw: new Request('http://localhost/setup-budget'), param: () => undefined },
        });
        const ws = new FakeWSContext();
        events.onOpen?.(new Event('open'), ws as unknown as WSContext);
        events.onMessage?.({ data: '{"event":"go"}' } as MessageEvent, ws as unknown as WSContext);
        await new Promise((resolve) => setTimeout(resolve, 0)); // The first frame is already waiting inside the setup barrier.
        if (stop === 'overflow') {
          events.onMessage?.(
            { data: '{"event":"go"}' } as MessageEvent,
            ws as unknown as WSContext,
          );
          expect(ws.closed?.code).toBe(1013);
        } else
          events.onClose?.(
            { code: 1000, reason: 'done' } as CloseEvent,
            ws as unknown as WSContext,
          );
        release();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(hits).toBe(0);
      } finally {
        release();
        await app.close();
      }
    },
  );

  it('closes fail-closed and never dispatches when handleConnection rejects', async () => {
    let hits = 0;

    @WebSocketGateway({ path: '/rejected', authenticator: TestUpgradeAuthenticator })
    class RejectedGateway implements OnGatewayConnection {
      handleConnection() {
        throw new Error('not authorized');
      }
      @SubscribeMessage('go')
      onGo() {
        hits++;
      }
    }
    @Module({ imports: [WebSocketModule.forRoot()], providers: [RejectedGateway] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, { diagnostics: 'silent' });
    const { upgrade, captured } = capturingUpgrade();
    registerWebSocketGateways(app, upgrade);
    const events = await captured[0]({
      req: { raw: new Request('http://localhost/rejected'), param: () => undefined },
    });
    const ws = new FakeWSContext();
    events.onOpen?.(new Event('open'), ws as unknown as WSContext);
    events.onMessage?.(
      { data: JSON.stringify({ event: 'go', data: {} }) } as MessageEvent,
      ws as unknown as WSContext,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ws.closed?.code).toBe(1008);
    expect(hits).toBe(0);
  });

  it('rejects a disallowed browser Origin before the upgrade', async () => {
    @WebSocketGateway({ path: '/origin', allowedOrigins: ['https://trusted.test'] })
    class OriginGateway {}
    @Module({ imports: [WebSocketModule.forRoot()], providers: [OriginGateway] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const { upgrade, captured } = capturingUpgrade();
    registerWebSocketGateways(app, upgrade);

    await expect(
      captured[0]({
        req: {
          raw: new Request('https://api.test/origin', {
            headers: { origin: 'https://evil.test' },
          }),
          param: () => undefined,
        },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects a gateway without upgrade authentication before socket allocation', async () => {
    @WebSocketGateway({ path: '/missing-auth' })
    class MissingAuthGateway {}
    @Module({ imports: [WebSocketModule.forRoot()], providers: [MissingAuthGateway] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const { upgrade, captured } = capturingUpgrade();
    registerWebSocketGateways(app, upgrade);

    await expect(
      captured[0]({
        req: {
          raw: new Request('https://api.test/missing-auth'),
          param: () => undefined,
        },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('authenticates a socket ticket before open and installs only trusted identity state', async () => {
    let callbackUrl = '';
    let callbackTicket: string | undefined;
    let connectedData: unknown;
    const expiresAtMs = Date.now() + 30_000;

    class TicketAuthenticator implements UpgradeAuthenticator {
      authenticate(
        request: Request,
        context: WebSocketUpgradeAuthenticationContext,
      ): WebSocketUpgradeIdentity | false {
        callbackUrl = request.url;
        callbackTicket = context.ticket;
        if (context.room !== 'alpha' || context.ticket !== 'opaque-once') return false;
        return {
          principal: { issuer: 'https://issuer.test', subject: 'u1', principalType: 'user' },
          tenantId: 't1',
          expiresAtMs,
        };
      }
    }

    @WebSocketGateway({
      path: '/rooms/:room/ws',
      roomParam: 'room',
      authenticator: TicketAuthenticator,
    })
    class TicketGateway implements OnGatewayConnection {
      handleConnection(client: WsClient) {
        connectedData = client.data;
      }
    }
    @Module({ imports: [WebSocketModule.forRoot()], providers: [TicketGateway] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const { upgrade, captured } = capturingUpgrade();
    registerWebSocketGateways(app, upgrade);
    const events = await captured[0]({
      req: {
        raw: new Request('https://api.test/rooms/alpha/ws?ticket=opaque-once'),
        param: (name: string) => (name === 'room' ? 'alpha' : undefined),
      },
    });
    const ws = new FakeWSContext();
    events.onOpen?.(new Event('open'), ws as unknown as WSContext);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(callbackUrl).toBe('https://api.test/rooms/alpha/ws');
    expect(callbackTicket).toBe('opaque-once');
    expect(connectedData).toEqual({
      principal: { issuer: 'https://issuer.test', subject: 'u1', principalType: 'user' },
      tenantId: 't1',
      expiresAtMs,
      userId: 'u1',
    });
  });

  it('rejects reusable or malformed WebSocket query credentials before authentication', async () => {
    let authCalls = 0;
    class CountingAuthenticator implements UpgradeAuthenticator {
      authenticate(): false {
        authCalls++;
        return false;
      }
    }
    @WebSocketGateway({ path: '/query-secret', authenticator: CountingAuthenticator })
    class SecretGateway {}
    @Module({ imports: [WebSocketModule.forRoot()], providers: [SecretGateway] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const { upgrade, captured } = capturingUpgrade();
    registerWebSocketGateways(app, upgrade);

    for (const suffix of [
      '?access_token=long-lived',
      '?Ticket=case-confusable',
      '?ticket=contains%20space',
      `?ticket=${'x'.repeat(8 * 1024 + 1)}`,
    ]) {
      await expect(
        captured[0]({
          req: {
            raw: new Request(`https://api.test/query-secret${suffix}`),
            param: () => undefined,
          },
        }),
      ).rejects.toMatchObject({ status: 403 });
    }
    expect(authCalls).toBe(0);
  });
});
