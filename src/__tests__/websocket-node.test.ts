import { describe, it, expect, beforeEach } from 'vitest';
import { VelaFactory, Module, MetadataRegistry } from '../index.js';
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
} from '../websocket/index.js';
import type { WsClient, WsServer, BroadcastCommand, OnGatewayConnection } from '../websocket/index.js';
import { NodeWsClient, registerWebSocketGateways, redis } from '../websocket-node/index.js';
import type { RedisPubSubClient } from '../websocket-node/index.js';
import type { WSContext, WSEvents, UpgradeWebSocket } from 'hono/ws';

beforeEach(() => MetadataRegistry.clear());

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
});

describe('registerWebSocketGateways', () => {
  function chatApp() {
    @WebSocketGateway({ path: '/rooms/:id/ws' })
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

  // Fake `upgradeWebSocket` that captures each route's `createEvents` so the
  // socket lifecycle can be driven directly (no real server needed).
  function capturingUpgrade() {
    const captured: Array<(c: unknown) => WSEvents> = [];
    const upgrade = ((createEvents: (c: unknown) => WSEvents) => {
      captured.push(createEvents);
      return async () => {};
    }) as unknown as UpgradeWebSocket;
    return { upgrade, captured };
  }

  const ctxWithRoom = (id: string) => ({ req: { param: (k: string) => (k === 'id' ? id : undefined) } });
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('dispatches messages to the gateway and replies on the socket', async () => {
    const app = await VelaFactory.create(chatApp());
    const { upgrade, captured } = capturingUpgrade();
    registerWebSocketGateways(app, upgrade);

    const events = captured[0](ctxWithRoom('room1'));
    const ws = new FakeWSContext();
    events.onOpen?.(new Event('open'), ws as unknown as WSContext);
    await tick();

    events.onMessage?.(
      { data: JSON.stringify({ id: '1', event: 'echo', data: { text: 'hi' } }) } as MessageEvent,
      ws as unknown as WSContext,
    );
    await tick();

    expect(ws.last()).toEqual({ id: '1', event: 'echo', data: 'HI' });
  });

  it('auto-joins the :id room so broadcasts reach every socket in it', async () => {
    const app = await VelaFactory.create(chatApp());
    const { upgrade, captured } = capturingUpgrade();
    registerWebSocketGateways(app, upgrade);
    const createEvents = captured[0];

    const wsA = new FakeWSContext();
    const wsB = new FakeWSContext();
    const evA = createEvents(ctxWithRoom('room1'));
    const evB = createEvents(ctxWithRoom('room1'));
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

  function sink(id: string) {
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

    @WebSocketGateway({ path: '/ordered' })
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
    const captured: Array<(c: unknown) => WSEvents> = [];
    const upgrade = ((createEvents: (c: unknown) => WSEvents) => {
      captured.push(createEvents);
      return async () => {};
    }) as unknown as UpgradeWebSocket;
    registerWebSocketGateways(app, upgrade);

    const events = captured[0]({ req: { param: () => undefined } });
    const ws = new FakeWSContext();
    events.onOpen?.(new Event('open'), ws as unknown as WSContext);
    events.onMessage?.(
      { data: JSON.stringify({ event: 'go', data: {} }) } as MessageEvent,
      ws as unknown as WSContext,
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(order).toEqual(['open', 'message']); // message waited for handleConnection
  });
});
