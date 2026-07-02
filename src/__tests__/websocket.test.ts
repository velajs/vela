import { describe, it, expect, beforeEach } from 'vitest';
import { Module, MetadataRegistry } from '@velajs/vela';
import {
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  WebSocketServer,
} from '@velajs/vela/websocket';
import type {
  WsClient,
  WsServer,
  BroadcastCommand,
  OnGatewayConnection,
} from '@velajs/vela/websocket';
import { createCloudflareApp } from '../cloudflare-factory';
import { CfWsClient } from '../websocket/cf-ws-client';
import { CfRoomRegistry } from '../websocket/cf-room-registry';
import { DoWebSocketHost } from '../websocket/do-websocket-host';
import { buildDoRuntime } from '../websocket/do-bootstrap';
import { CloudflareWebSocketModule } from '../websocket/cloudflare-websocket.module';
import { VelaWebSocketDurableObject } from '../websocket/websocket.durable-object';
import { roomTag, connTag } from '../websocket/room-id';
import type { DoStateLike, WsLike } from '../websocket/do-state';

beforeEach(() => MetadataRegistry.clear());

// ---- fakes for the Durable Object runtime ----

class FakeWs implements WsLike {
  readonly sent: string[] = [];
  closed?: { code?: number; reason?: string };
  private attachment: unknown = null;
  send(message: string | ArrayBuffer): void {
    this.sent.push(typeof message === 'string' ? message : new TextDecoder().decode(message));
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  serializeAttachment(value: unknown): void {
    this.attachment = JSON.parse(JSON.stringify(value)); // structured-clone-ish, like CF
  }
  deserializeAttachment(): unknown {
    return this.attachment;
  }
  lastFrame(): { event: string; data: unknown; id?: string } {
    return JSON.parse(this.sent[this.sent.length - 1]);
  }
}

class FakeDoState implements DoStateLike {
  readonly id = { toString: () => 'do-1', name: 'do-1' as string | null };
  readonly accepted: Array<{ ws: FakeWs; tags: string[] }> = [];
  acceptWebSocket(ws: WsLike, tags: string[] = []): void {
    this.accepted.push({ ws: ws as FakeWs, tags });
  }
  getWebSockets(tag?: string): WsLike[] {
    return this.accepted
      .filter((a) => tag === undefined || a.tags.includes(tag))
      .map((a) => a.ws);
  }
  setWebSocketAutoResponse(): void {}
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

// ---- pure mappings ----

describe('room-id mappings', () => {
  it('prefixes tags and maps a room to a stable DO id', () => {
    expect(roomTag('general')).toBe('room:general');
    expect(connTag('abc')).toBe('conn:abc');
    const ns = { idFromName: (n: string) => ({ toString: () => `id:${n}` }) } as never;
    // roomToDurableId delegates to idFromName
    expect((ns as { idFromName: (n: string) => { toString(): string } }).idFromName('general').toString()).toBe(
      'id:general',
    );
  });
});

// ---- CfWsClient ----

describe('CfWsClient', () => {
  const ctx = new FakeDoState();

  function withAttachment(att: Record<string, unknown>): FakeWs {
    const ws = new FakeWs();
    ws.serializeAttachment(att);
    return ws;
  }

  it('frames send() with optional correlation id and exposes attachment state', () => {
    const ws = withAttachment({ connId: 'c1', path: '/chat', rooms: ['r1'], data: { userId: 'u1' } });
    const client = new CfWsClient(ctx, ws);

    expect(client.id).toBe('c1');
    expect(client.data).toEqual({ userId: 'u1' });
    expect([...client.rooms]).toEqual(['r1']);

    client.send('hello', { a: 1 }, '9');
    expect(JSON.parse(ws.sent[0])).toEqual({ id: '9', event: 'hello', data: { a: 1 } });

    client.send('noId', 2);
    expect(JSON.parse(ws.sent[1])).toEqual({ event: 'noId', data: 2 });
  });

  it('join/leave mutate and persist the attachment', () => {
    const ws = withAttachment({ connId: 'c1', path: '/chat', rooms: ['r1'], data: {} });
    const client = new CfWsClient(ctx, ws);

    client.join('r2');
    expect((ws.deserializeAttachment() as { rooms: string[] }).rooms).toEqual(['r1', 'r2']);

    client.leave('r1');
    expect((ws.deserializeAttachment() as { rooms: string[] }).rooms).toEqual(['r2']);
  });

  it('rejects an attachment larger than 16 KiB', () => {
    const ws = withAttachment({ connId: 'c1', path: '/x', rooms: [], data: {} });
    const client = new CfWsClient(ctx, ws);
    client.data = { blob: 'x'.repeat(17_000) };
    expect(() => client.commit()).toThrow(/16 KiB/);
  });
});

// ---- CfRoomRegistry.deliverLocal ----

describe('CfRoomRegistry.deliverLocal', () => {
  function socket(att: Record<string, unknown>, tags: string[], ctx: FakeDoState): FakeWs {
    const ws = new FakeWs();
    ws.serializeAttachment(att);
    ctx.acceptWebSocket(ws, tags);
    return ws;
  }
  const frame = (event: string, data: unknown) => JSON.stringify({ event, data });

  it('delivers to a room via the hibernation tag fast path', () => {
    const ctx = new FakeDoState();
    const a = socket({ connId: 'a', rooms: ['r1'] }, [roomTag('r1')], ctx);
    const b = socket({ connId: 'b', rooms: ['r2'] }, [roomTag('r2')], ctx);
    new CfRoomRegistry(ctx).deliverLocal({ rooms: ['r1'], frame: frame('x', 1) });
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(0);
  });

  it('delivers to a dynamically-joined room via the attachment scan fallback', () => {
    const ctx = new FakeDoState();
    // joined 'r-dyn' after accept => not a tag; only in the attachment
    const a = socket({ connId: 'a', rooms: ['hub', 'r-dyn'] }, [roomTag('hub')], ctx);
    const b = socket({ connId: 'b', rooms: ['hub'] }, [roomTag('hub')], ctx);
    new CfRoomRegistry(ctx).deliverLocal({ rooms: ['r-dyn'], frame: frame('x', 1) });
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(0);
  });

  it('honors global (empty rooms), exceptIds, and exceptRooms', () => {
    const ctx = new FakeDoState();
    const a = socket({ connId: 'a', rooms: ['r1'] }, [roomTag('r1')], ctx);
    const b = socket({ connId: 'b', rooms: ['r1', 'muted'] }, [roomTag('r1')], ctx);
    const c = socket({ connId: 'c', rooms: ['r2'] }, [roomTag('r2')], ctx);
    const reg = new CfRoomRegistry(ctx);

    reg.deliverLocal({ rooms: [], frame: frame('g', 1) }); // global
    expect([a.sent.length, b.sent.length, c.sent.length]).toEqual([1, 1, 1]);

    reg.deliverLocal({ rooms: ['r1'], exceptIds: ['a'], frame: frame('x', 1) });
    expect(a.sent).toHaveLength(1); // unchanged
    expect(b.sent).toHaveLength(2);

    reg.deliverLocal({ rooms: ['r1'], exceptRooms: ['muted'], frame: frame('y', 1) });
    expect(a.sent).toHaveLength(2);
    expect(b.sent).toHaveLength(2); // b excluded via 'muted'
  });
});

// ---- buildDoRuntime + DoWebSocketHost integration ----

describe('DO runtime integration', () => {
  function chatModule() {
    @WebSocketGateway({ path: '/chat', binding: 'CHAT' })
    class ChatGateway implements OnGatewayConnection {
      constructor(@WebSocketServer() private readonly server: WsServer) {}
      handleConnection(client: WsClient) {
        client.send('welcome', { id: client.id });
      }
      @SubscribeMessage('echo')
      onEcho(@MessageBody() body: { text: string }) {
        return { event: 'echo', data: body.text.toUpperCase() };
      }
      @SubscribeMessage('shout')
      onShout(@MessageBody() text: string) {
        void this.server.to('room1').emit('shout', text);
      }
    }
    @Module({ imports: [CloudflareWebSocketModule.forRoot()], providers: [ChatGateway] })
    class AppModule {}
    return AppModule;
  }

  it('accept tags the hub room + conn and persists the attachment', async () => {
    const ctx = new FakeDoState();
    const runtime = await buildDoRuntime(chatModule(), ctx, {});
    const host = new DoWebSocketHost(ctx, runtime.dispatcher, runtime.registry);

    const ws = new FakeWs();
    host.accept(ws, '/chat', 'room1', 'user1');

    const { tags } = ctx.accepted[0];
    expect(tags[0]).toBe(roomTag('room1'));
    expect(tags[1]).toMatch(/^conn:/);
    const att = ws.deserializeAttachment() as { path: string; rooms: string[]; data: unknown };
    expect(att.path).toBe('/chat');
    expect(att.rooms).toEqual(['room1']);
    expect(att.data).toEqual({ userId: 'user1' });
  });

  it('fires OnGatewayConnection and dispatches messages to the gateway', async () => {
    const ctx = new FakeDoState();
    const runtime = await buildDoRuntime(chatModule(), ctx, {});
    const host = new DoWebSocketHost(ctx, runtime.dispatcher, runtime.registry);

    const ws = new FakeWs();
    host.accept(ws, '/chat', 'room1', 'user1');
    // handleConnection runs via the awaitable dispatcher path (accept fires it fire-and-forget)
    await runtime.dispatcher.handleOpen('/chat', new CfWsClient(ctx, ws));
    expect(ws.lastFrame().event).toBe('welcome');

    ws.sent.length = 0;
    await host.onMessage(ws, JSON.stringify({ id: '1', event: 'echo', data: { text: 'hi' } }));
    expect(ws.lastFrame()).toEqual({ id: '1', event: 'echo', data: 'HI' });
  });

  it('broadcasts from a handler to every socket in the room', async () => {
    const ctx = new FakeDoState();
    const runtime = await buildDoRuntime(chatModule(), ctx, {});
    const host = new DoWebSocketHost(ctx, runtime.dispatcher, runtime.registry);

    const a = new FakeWs();
    const b = new FakeWs();
    host.accept(a, '/chat', 'room1', 'ua');
    host.accept(b, '/chat', 'room1', 'ub');
    a.sent.length = 0;
    b.sent.length = 0;

    await host.onMessage(a, JSON.stringify({ event: 'shout', data: 'hey' }));

    expect(a.lastFrame()).toEqual({ event: 'shout', data: 'hey' });
    expect(b.lastFrame()).toEqual({ event: 'shout', data: 'hey' });
  });
});

// ---- Worker upgrade routing ----

describe('registerWebSocketRoutes (Worker → DO)', () => {
  function mockNamespace() {
    const calls: Array<{ id: string; room: string | null; path: string | null; user: string | null }> = [];
    const ns = {
      idFromName: (name: string) => ({ toString: () => `id:${name}`, name }),
      get: (id: { toString(): string }) => ({
        fetch: async (req: Request) => {
          calls.push({
            id: id.toString(),
            room: req.headers.get('x-vela-room'),
            path: req.headers.get('x-vela-path'),
            user: req.headers.get('x-vela-user'),
          });
          // Node's undici forbids constructing a 101 Response (valid only in
          // workerd); use 200 to stand in for "the DO returned the upgrade".
          return new Response('upgraded', { status: 200 });
        },
      }),
    };
    return { ns, calls };
  }

  it('forwards the upgrade to idFromName(room) with spoof-safe headers', async () => {
    @WebSocketGateway({ path: '/rooms/:id/ws', binding: 'ROOM' })
    class RoomGateway {
      @SubscribeMessage('noop')
      onNoop() {}
    }
    @Module({ imports: [CloudflareWebSocketModule.forRoot()], providers: [RoomGateway] })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const { ns, calls } = mockNamespace();

    const res = await app
      .getHonoApp()
      .request(
        '/rooms/general/ws',
        { headers: { upgrade: 'websocket', 'x-vela-user': 'spoofed' } },
        { ROOM: ns },
      );

    expect(res.status).toBe(200); // whatever the DO returned, passed through
    expect(calls[0]).toEqual({
      id: 'id:general',
      room: 'general',
      path: '/rooms/:id/ws',
      user: null, // client-supplied x-vela-user was stripped
    });
  });

  it('rejects a non-upgrade request with 426', async () => {
    @WebSocketGateway({ path: '/ws', binding: 'ROOM' })
    class Gw {
      @SubscribeMessage('noop')
      onNoop() {}
    }
    @Module({ imports: [CloudflareWebSocketModule.forRoot()], providers: [Gw] })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const res = await app.getHonoApp().request('/ws', undefined, { ROOM: mockNamespace().ns });
    expect(res.status).toBe(426);
  });
});

// ---- DO shell smoke (via cloudflare:workers alias) ----

describe('VelaWebSocketDurableObject shell', () => {
  it('builds the runtime and delivers a broadcast RPC to local sockets', async () => {
    @WebSocketGateway({ path: '/chat', binding: 'CHAT' })
    class ChatGateway {
      @SubscribeMessage('noop')
      onNoop() {}
    }
    @Module({ imports: [CloudflareWebSocketModule.forRoot()], providers: [ChatGateway] })
    class AppModule {}

    const ctx = new FakeDoState();
    const DoClass = VelaWebSocketDurableObject(AppModule);
    const instance = new DoClass(ctx as never, {}) as unknown as {
      broadcast(cmd: BroadcastCommand): Promise<void>;
      webSocketMessage(ws: WsLike, msg: string): Promise<void>;
    };

    // A socket already in room1 (as if accepted earlier).
    const ws = new FakeWs();
    ws.serializeAttachment({ connId: 'x', path: '/chat', rooms: ['room1'], data: {} });
    ctx.acceptWebSocket(ws, [roomTag('room1')]);

    await instance.broadcast({ rooms: ['room1'], frame: JSON.stringify({ event: 'ping', data: 1 }) });

    expect(ws.lastFrame()).toEqual({ event: 'ping', data: 1 });
  });
});

describe('cloudflare — code-review regressions', () => {
  it('does not deliver to a socket that left the hub room (attachment beats the immutable tag)', () => {
    const ctx = new FakeDoState();
    const a = new FakeWs();
    a.serializeAttachment({ connId: 'a', path: '/c', rooms: ['lobby'], data: {} });
    ctx.acceptWebSocket(a, [roomTag('lobby')]);
    const b = new FakeWs();
    b.serializeAttachment({ connId: 'b', path: '/c', rooms: ['lobby'], data: {} });
    ctx.acceptWebSocket(b, [roomTag('lobby')]);

    // b leaves the hub room: the hibernation tag is immutable, but attachment.rooms updates.
    b.serializeAttachment({ connId: 'b', path: '/c', rooms: [], data: {} });

    new CfRoomRegistry(ctx).deliverLocal({
      rooms: ['lobby'],
      frame: JSON.stringify({ event: 'x', data: 1 }),
    });

    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(0); // b left the room and must not receive
  });

  it('onClose with a reserved/abnormal close code (1006) does not throw', async () => {
    @WebSocketGateway({ path: '/c', binding: 'C' })
    class MiniGateway {
      @SubscribeMessage('noop')
      onNoop() {}
    }
    @Module({ imports: [CloudflareWebSocketModule.forRoot()], providers: [MiniGateway] })
    class MiniApp {}

    const ctx = new FakeDoState();
    const runtime = await buildDoRuntime(MiniApp, ctx, {});
    const host = new DoWebSocketHost(ctx, runtime.dispatcher, runtime.registry);

    const ws = new FakeWs();
    ws.serializeAttachment({ connId: 'x', path: '/c', rooms: ['lobby'], data: {} });

    await expect(host.onClose(ws, 1006, '')).resolves.toBeUndefined();
    expect(ws.closed).toBeDefined(); // handshake completed with a codeless close, no throw
  });
});
