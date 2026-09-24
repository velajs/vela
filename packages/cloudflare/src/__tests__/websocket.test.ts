import { setTrustedRequestIdentity } from '@velajs/vela/module-kit';
import { describe, it, expect } from 'vitest';
import {
  Inject,
  InjectEnv,
  Injectable,
  InjectionToken,
  Module,
  REQUEST_CONTEXT,
  defineProvider,
  type MiddlewareConsumer,
  type NestMiddleware,
  type NestModule,
  type VelaContext,
  type VelaEnv,
} from '@velajs/vela';
import { MemoryNonceStore } from '@velajs/vela/security';
import type { RequestContext } from '@velajs/vela';
import {
  Gateways,
  WebSocketGateway,
  WebSocketModule,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  WebSocketServer,
  issueWebSocketTicket,
  verifyAndConsumeWebSocketTicket,
} from '@velajs/vela/websocket';
import type {
  WsClient,
  WsServer,
  BroadcastCommand,
  OnGatewayConnection,
  UpgradeAuthenticator,
  WebSocketUpgradeAuthenticationContext,
  WebSocketUpgradeIdentity,
} from '@velajs/vela/websocket';
import { createCloudflareApp } from '../cloudflare-factory';
import { CfWsClient } from '../websocket/cf-ws-client';
import { CfRoomRegistry } from '../websocket/cf-room-registry';
import { DoWebSocketHost } from '../websocket/do-websocket-host';
import { buildDoRuntime } from '../websocket/do-bootstrap';
import { VelaWebSocketDurableObject } from '../websocket/websocket.durable-object';
import { roomTag, connTag, durableObjectRoomName, roomToDurableId } from '../websocket/room-id';
import type { DoStateLike, WsLike } from '../websocket/do-state';

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
    return this.accepted.filter((a) => tag === undefined || a.tags.includes(tag)).map((a) => a.ws);
  }
  setWebSocketAutoResponse(): void {}
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

class TestUpgradeAuthenticator implements UpgradeAuthenticator {
  authenticate(): WebSocketUpgradeIdentity {
    return {
      principal: { issuer: 'https://issuer.test', subject: 'user-1', principalType: 'user' },
      tenantId: 'tenant-1',
      expiresAtMs: Date.now() + 60_000,
    };
  }
}

function acceptTrusted(
  host: DoWebSocketHost,
  ws: WsLike,
  path: string,
  room: string,
  subject = 'user-1',
): Promise<boolean> {
  return host.accept(ws, path, room, subject, Date.now() + 60_000, {
    issuer: 'https://issuer.test',
    subject,
    principalType: 'user',
    tenantId: 'tenant-1',
  });
}

// ---- pure mappings ----

describe('room-id mappings', () => {
  it('prefixes tags and namespaces equal rooms by gateway path', () => {
    expect(roomTag('general')).toBe('room:general');
    expect(connTag('abc')).toBe('conn:abc');
    const ns = { idFromName: (n: string) => ({ toString: () => `id:${n}` }) } as never;
    expect(roomToDurableId(ns, '/chat/:id', 'general').toString()).toBe(
      'id:vela:ws:v2:%2Fchat%2F%3Aid:general',
    );
    expect(durableObjectRoomName('/support/:id', 'general')).not.toBe(
      durableObjectRoomName('/chat/:id', 'general'),
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
    const ws = withAttachment({
      connId: 'c1',
      state: 'active',
      path: '/chat',
      rooms: ['r1'],
      data: { userId: 'u1' },
    });
    const client = new CfWsClient(ctx, ws);

    expect(client.id).toBe('c1');
    expect(client.data).toEqual({ userId: 'u1' });
    expect([...client.rooms]).toEqual(['r1']);

    client.send('hello', { a: 1 }, '9');
    expect(JSON.parse(ws.sent[0])).toEqual({ id: '9', event: 'hello', data: { a: 1 } });

    client.send('noId', 2);
    expect(JSON.parse(ws.sent[1])).toEqual({ event: 'noId', data: 2 });
  });

  it('closes with 1009 and never writes direct oversized outbound frames', () => {
    const ws = withAttachment({
      connId: 'c1',
      state: 'active',
      path: '/chat',
      maxFrameBytes: 32,
      rooms: ['r1'],
      data: {},
    });
    const client = new CfWsClient(ctx, ws);

    client.sendRaw('x'.repeat(33));
    expect(ws.sent).toEqual([]);
    expect(ws.closed).toEqual({ code: 1009, reason: 'Message too large' });

    const framedWs = withAttachment({
      connId: 'c2',
      state: 'active',
      path: '/chat',
      maxFrameBytes: 32,
      rooms: ['r1'],
      data: {},
    });
    new CfWsClient(ctx, framedWs).send('large', 'x'.repeat(32));
    expect(framedWs.sent).toEqual([]);
    expect(framedWs.closed?.code).toBe(1009);
  });

  it('join/leave mutate and persist the attachment', () => {
    const ws = withAttachment({
      connId: 'c1',
      state: 'active',
      path: '/chat',
      rooms: ['r1'],
      data: {},
    });
    const client = new CfWsClient(ctx, ws);

    client.join('r2');
    expect((ws.deserializeAttachment() as { rooms: string[] }).rooms).toEqual(['r1', 'r2']);

    client.leave('r1');
    expect((ws.deserializeAttachment() as { rooms: string[] }).rooms).toEqual(['r2']);
  });

  it('caps room membership at 32 and validates dynamic room ids', () => {
    const ws = withAttachment({
      connId: 'c1',
      state: 'active',
      path: '/chat',
      rooms: [],
      data: {},
    });
    const client = new CfWsClient(ctx, ws);
    for (let index = 0; index < 32; index += 1) client.join(`room-${index}`);

    expect(() => client.join('room-overflow')).toThrow(/at most 32 rooms/);
    expect(() => client.join('bad\nroom')).toThrow(/control-free/);
  });

  it('rejects an attachment larger than 16 KiB', () => {
    const ws = withAttachment({
      connId: 'c1',
      state: 'active',
      path: '/x',
      rooms: [],
      data: {},
    });
    const client = new CfWsClient(ctx, ws);
    client.data = { blob: 'x'.repeat(17_000) };
    expect(() => client.commit()).toThrow(/16 KiB/);
  });
});

// ---- CfRoomRegistry.deliverLocal ----

describe('CfRoomRegistry.deliverLocal', () => {
  function socket(att: Record<string, unknown>, tags: string[], ctx: FakeDoState): FakeWs {
    const ws = new FakeWs();
    ws.serializeAttachment({ path: '/chat', data: {}, ...att });
    ctx.acceptWebSocket(ws, tags);
    return ws;
  }
  const frame = (event: string, data: unknown) => JSON.stringify({ event, data });

  it('delivers to a room via the hibernation tag fast path', () => {
    const ctx = new FakeDoState();
    const a = socket({ connId: 'a', state: 'active', rooms: ['r1'] }, [roomTag('r1')], ctx);
    const b = socket({ connId: 'b', state: 'active', rooms: ['r2'] }, [roomTag('r2')], ctx);
    new CfRoomRegistry(ctx).deliverLocal({ rooms: ['r1'], frame: frame('x', 1) });
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(0);
  });

  it('enforces the persisted recipient ceiling during Durable Object fan-out', () => {
    const ctx = new FakeDoState();
    const limited = socket(
      {
        connId: 'limited',
        state: 'active',
        path: '/limited',
        rooms: ['r1'],
        data: {},
      },
      [roomTag('r1')],
      ctx,
    );

    const registry = new CfRoomRegistry(ctx);
    registry.setFrameLimitResolver((path) => (path === '/limited' ? 48 : undefined));
    registry.deliverLocal({ rooms: ['r1'], frame: frame('large', 'x'.repeat(100)) });

    expect(limited.sent).toEqual([]);
    expect(limited.closed?.code).toBe(1009);
    expect((limited.deserializeAttachment() as { maxFrameBytes?: number }).maxFrameBytes).toBe(48);
  });

  it('delivers to a dynamically-joined room via the attachment scan fallback', () => {
    const ctx = new FakeDoState();
    // joined 'r-dyn' after accept => not a tag; only in the attachment
    const a = socket(
      { connId: 'a', state: 'active', rooms: ['hub', 'r-dyn'] },
      [roomTag('hub')],
      ctx,
    );
    const b = socket({ connId: 'b', state: 'active', rooms: ['hub'] }, [roomTag('hub')], ctx);
    new CfRoomRegistry(ctx).deliverLocal({ rooms: ['r-dyn'], frame: frame('x', 1) });
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(0);
  });

  it('honors global (empty rooms), exceptIds, and exceptRooms', () => {
    const ctx = new FakeDoState();
    const a = socket({ connId: 'a', state: 'active', rooms: ['r1'] }, [roomTag('r1')], ctx);
    const b = socket(
      { connId: 'b', state: 'active', rooms: ['r1', 'muted'] },
      [roomTag('r1')],
      ctx,
    );
    const c = socket({ connId: 'c', state: 'active', rooms: ['r2'] }, [roomTag('r2')], ctx);
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

  it("delivers a gateway-scoped push only to that gateway's sockets", () => {
    const ctx = new FakeDoState();
    const chat = socket({ connId: 'a', state: 'active', rooms: ['r1'] }, [roomTag('r1')], ctx);
    const admin = socket(
      { connId: 'b', state: 'active', path: '/admin', rooms: ['r1'] },
      [roomTag('r1')],
      ctx,
    );
    const registry = new CfRoomRegistry(ctx);

    registry.deliverLocal({ rooms: ['r1'], gatewayPath: '/admin', frame: frame('audit', 1) });
    expect(chat.sent).toEqual([]);
    expect(admin.sent).toHaveLength(1);

    registry.deliverLocal({ rooms: ['r1'], gatewayPath: '/chat', frame: frame('x', 1) });
    expect(chat.sent).toHaveLength(1);
    expect(admin.sent).toHaveLength(1);
  });

  it('closes expired or rejected sockets instead of delivering a push', () => {
    const ctx = new FakeDoState();
    const expired = socket(
      {
        connId: 'expired',
        state: 'active',
        rooms: ['r1'],
        expiresAtMs: Date.now() - 1,
      },
      [roomTag('r1')],
      ctx,
    );
    const rejected = socket(
      { connId: 'rejected', state: 'rejected', rooms: ['r1'] },
      [roomTag('r1')],
      ctx,
    );

    new CfRoomRegistry(ctx).deliverLocal({ rooms: ['r1'], frame: frame('secret', 1) });

    expect(expired.sent).toEqual([]);
    expect(rejected.sent).toEqual([]);
    expect(expired.closed?.code).toBe(1008);
    expect(rejected.closed?.code).toBe(1008);
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
    @Module({ imports: [WebSocketModule.forRoot()], providers: [ChatGateway] })
    class AppModule {}
    return AppModule;
  }

  it('accept tags the hub room + conn and persists the attachment', async () => {
    const ctx = new FakeDoState();
    const runtime = await buildDoRuntime(chatModule(), ctx, { env: {} });
    const host = new DoWebSocketHost(ctx, runtime.dispatcher, runtime.registry);

    const ws = new FakeWs();
    await expect(acceptTrusted(host, ws, '/chat', 'room1', 'user1')).resolves.toBe(true);

    const { tags } = ctx.accepted[0];
    expect(tags[0]).toBe(roomTag('room1'));
    expect(tags[1]).toMatch(/^conn:/);
    const att = ws.deserializeAttachment() as { path: string; rooms: string[]; data: unknown };
    expect(att.path).toBe('/chat');
    expect(att.rooms).toEqual(['room1']);
    expect(att.data).toMatchObject({
      userId: 'user1',
      principal: {
        issuer: 'https://issuer.test',
        subject: 'user1',
        principalType: 'user',
      },
      tenantId: 'tenant-1',
    });
  });

  it('fires OnGatewayConnection and dispatches messages to the gateway', async () => {
    const ctx = new FakeDoState();
    const runtime = await buildDoRuntime(chatModule(), ctx, { env: {} });
    const host = new DoWebSocketHost(ctx, runtime.dispatcher, runtime.registry);

    const ws = new FakeWs();
    await expect(acceptTrusted(host, ws, '/chat', 'room1', 'user1')).resolves.toBe(true);
    expect(ws.closed).toBeUndefined();
    expect(ws.lastFrame().event).toBe('welcome');

    ws.sent.length = 0;
    await host.onMessage(ws, JSON.stringify({ id: '1', event: 'echo', data: { text: 'hi' } }));
    expect(ws.lastFrame()).toEqual({ id: '1', event: 'echo', data: 'HI' });
  });

  it('broadcasts from handleConnection without rejecting the connecting socket', async () => {
    @WebSocketGateway({ path: '/lobby', binding: 'CHAT' })
    class LobbyGateway implements OnGatewayConnection {
      constructor(@WebSocketServer() private readonly server: WsServer) {}
      handleConnection(client: WsClient) {
        void this.server.emit('joined', { id: client.id });
      }
    }
    @Module({ imports: [WebSocketModule.forRoot()], providers: [LobbyGateway] })
    class AppModule {}

    const ctx = new FakeDoState();
    const runtime = await buildDoRuntime(AppModule, ctx, { env: {} });
    const host = new DoWebSocketHost(ctx, runtime.dispatcher, runtime.registry);
    const member = new FakeWs();
    await expect(acceptTrusted(host, member, '/lobby', 'room1', 'user1')).resolves.toBe(true);
    const newcomer = new FakeWs();
    await expect(acceptTrusted(host, newcomer, '/lobby', 'room1', 'user2')).resolves.toBe(true);

    // The admitted member hears about the newcomer. The newcomer is still being
    // admitted while its own hook runs, so the broadcast skips it: no frame, no close.
    expect(member.lastFrame().event).toBe('joined');
    expect(member.closed).toBeUndefined();
    expect(newcomer.sent).toEqual([]);
    expect(newcomer.closed).toBeUndefined();
    expect((newcomer.deserializeAttachment() as { state: string }).state).toBe('active');
  });

  it('closes fail-closed when OnGatewayConnection rejects', async () => {
    let messages = 0;
    @WebSocketGateway({ path: '/reject', binding: 'CHAT' })
    class RejectGateway implements OnGatewayConnection {
      handleConnection() {
        throw new Error('unauthorized');
      }
      @SubscribeMessage('probe')
      onProbe() {
        messages += 1;
      }
    }
    @Module({ imports: [WebSocketModule.forRoot()], providers: [RejectGateway] })
    class AppModule {}

    const ctx = new FakeDoState();
    const runtime = await buildDoRuntime(AppModule, ctx, { env: {} });
    const host = new DoWebSocketHost(ctx, runtime.dispatcher, runtime.registry);
    const ws = new FakeWs();

    await expect(acceptTrusted(host, ws, '/reject', 'room1')).resolves.toBe(false);
    expect(ws.closed?.code).toBe(1008);
    await host.onMessage(ws, JSON.stringify({ event: 'probe' }));
    expect(messages).toBe(0);
    expect((ws.deserializeAttachment() as { state: string }).state).toBe('rejected');
  });

  it('permanently rejects an immediate frame while handleConnection is pending', async () => {
    let releaseConnection!: () => void;
    const connectionGate = new Promise<void>((resolve) => {
      releaseConnection = resolve;
    });
    let messages = 0;

    @WebSocketGateway({ path: '/pending', binding: 'CHAT' })
    class PendingGateway implements OnGatewayConnection {
      handleConnection() {
        return connectionGate;
      }
      @SubscribeMessage('probe')
      onProbe() {
        messages += 1;
      }
    }
    @Module({ imports: [WebSocketModule.forRoot()], providers: [PendingGateway] })
    class AppModule {}

    const ctx = new FakeDoState();
    const runtime = await buildDoRuntime(AppModule, ctx, { env: {} });
    const host = new DoWebSocketHost(ctx, runtime.dispatcher, runtime.registry);
    const ws = new FakeWs();

    const accepting = acceptTrusted(host, ws, '/pending', 'room1');
    expect((ws.deserializeAttachment() as { state: string }).state).toBe('pending');
    await host.onMessage(ws, JSON.stringify({ event: 'probe' }));
    releaseConnection();

    await expect(accepting).resolves.toBe(false);
    expect(messages).toBe(0);
    expect(ws.closed?.code).toBe(1008);
    expect((ws.deserializeAttachment() as { state: string }).state).toBe('rejected');
  });

  it('admits a socket whose connection hook broadcasts to its room', async () => {
    @WebSocketGateway({ path: '/announce', binding: 'CHAT' })
    class AnnounceGateway implements OnGatewayConnection {
      constructor(@WebSocketServer() private readonly server: WsServer) {}
      async handleConnection(client: WsClient) {
        client.send('welcome', { id: client.id });
        await this.server.emit('joined', { id: client.id });
      }
    }
    @Module({ imports: [WebSocketModule.forRoot()], providers: [AnnounceGateway] })
    class AppModule {}

    const ctx = new FakeDoState();
    const runtime = await buildDoRuntime(AppModule, ctx, { env: {} });
    const host = new DoWebSocketHost(ctx, runtime.dispatcher, runtime.registry);
    const first = new FakeWs();
    const second = new FakeWs();

    await expect(acceptTrusted(host, first, '/announce', 'room1')).resolves.toBe(true);
    await expect(acceptTrusted(host, second, '/announce', 'room1', 'user-2')).resolves.toBe(true);

    const secondId = (second.deserializeAttachment() as { connId: string }).connId;
    for (const ws of [first, second]) {
      expect(ws.closed).toBeUndefined();
      expect((ws.deserializeAttachment() as { state: string }).state).toBe('active');
    }
    // Delivered to the admitted socket; the joining one only gets its own
    // hook's direct frame until the hook completes.
    expect(first.lastFrame()).toEqual({ event: 'joined', data: { id: secondId } });
    expect(second.sent.map((frame) => JSON.parse(frame))).toEqual([
      { event: 'welcome', data: { id: secondId } },
    ]);
  });

  it('still closes a pending socket that is not being admitted when a broadcast reaches it', async () => {
    const ctx = new FakeDoState();
    const runtime = await buildDoRuntime(chatModule(), ctx, { env: {} });
    const stale = new FakeWs();
    ctx.acceptWebSocket(stale, [roomTag('room1'), connTag('stale')]);
    stale.serializeAttachment({
      version: 1,
      connId: 'stale',
      state: 'pending',
      path: '/chat',
      rooms: ['room1'],
      data: {},
    });

    await runtime.server.to('room1').emit('shout', 'hello');

    expect(stale.sent).toEqual([]);
    expect(stale.closed?.code).toBe(1008);
    expect((stale.deserializeAttachment() as { state: string }).state).toBe('rejected');
  });

  it('closes an oversized Durable Object frame with 1009 before dispatch', async () => {
    let messages = 0;
    @WebSocketGateway({ path: '/limited', binding: 'CHAT', maxFrameBytes: 32 })
    class LimitedGateway {
      @SubscribeMessage('probe')
      onProbe() {
        messages += 1;
      }
    }
    @Module({ imports: [WebSocketModule.forRoot()], providers: [LimitedGateway] })
    class AppModule {}

    const ctx = new FakeDoState();
    const runtime = await buildDoRuntime(AppModule, ctx, { env: {} });
    const host = new DoWebSocketHost(ctx, runtime.dispatcher, runtime.registry);
    const ws = new FakeWs();
    await expect(acceptTrusted(host, ws, '/limited', 'room1')).resolves.toBe(true);

    await host.onMessage(ws, JSON.stringify({ event: 'probe', data: { value: 'x'.repeat(100) } }));

    expect(messages).toBe(0);
    expect(ws.closed?.code).toBe(1009);
  });

  it('persists and applies the gateway ceiling to Durable Object replies', async () => {
    @WebSocketGateway({ path: '/limited-reply', binding: 'CHAT', maxFrameBytes: 48 })
    class LimitedReplyGateway {
      @SubscribeMessage('probe')
      onProbe() {
        return 'x'.repeat(100);
      }
    }
    @Module({ imports: [WebSocketModule.forRoot()], providers: [LimitedReplyGateway] })
    class AppModule {}

    const ctx = new FakeDoState();
    const runtime = await buildDoRuntime(AppModule, ctx, { env: {} });
    const host = new DoWebSocketHost(ctx, runtime.dispatcher, runtime.registry);
    const ws = new FakeWs();
    await expect(acceptTrusted(host, ws, '/limited-reply', 'room1')).resolves.toBe(true);

    expect((ws.deserializeAttachment() as { maxFrameBytes?: number }).maxFrameBytes).toBe(48);
    expect(() =>
      host.broadcast({
        rooms: ['room1'],
        frame: JSON.stringify({ event: 'large', data: 'x'.repeat(100) }),
      }),
    ).toThrow(/exceeds 48/);
    expect(ws.sent).toEqual([]);
    expect(ws.closed).toBeUndefined();

    await host.onMessage(ws, JSON.stringify({ event: 'probe' }));

    expect(ws.sent).toEqual([]);
    expect(ws.closed?.code).toBe(1009);
  });

  it('persists normalized identity expiry in the hibernation attachment', async () => {
    const ctx = new FakeDoState();
    const runtime = await buildDoRuntime(chatModule(), ctx, { env: {} });
    const host = new DoWebSocketHost(ctx, runtime.dispatcher, runtime.registry);
    const ws = new FakeWs();
    const expiresAtMs = Date.now() + 60_000;
    const principal = {
      issuer: 'https://access.example.test',
      subject: 'user1',
      principalType: 'user' as const,
      tenantId: 'tenant-1',
    };

    await host.accept(ws, '/chat', 'room1', 'user1', expiresAtMs, principal);
    const attachment = ws.deserializeAttachment() as {
      principal?: { issuer: string; subject: string; principalType: string };
      tenantId?: string;
      expiresAtMs?: number;
      data: Record<string, unknown>;
    };
    expect(attachment).toMatchObject({
      principal: {
        issuer: principal.issuer,
        subject: principal.subject,
        principalType: principal.principalType,
      },
      tenantId: principal.tenantId,
      expiresAtMs,
    });
    expect(attachment.data).toEqual({
      userId: 'user1',
      principal: {
        issuer: principal.issuer,
        subject: principal.subject,
        principalType: principal.principalType,
      },
      tenantId: principal.tenantId,
      expiresAtMs,
    });
  });

  it('rejects an already-expired identity before accepting the socket', async () => {
    const ctx = new FakeDoState();
    const runtime = await buildDoRuntime(chatModule(), ctx, { env: {} });
    const host = new DoWebSocketHost(ctx, runtime.dispatcher, runtime.registry);
    const ws = new FakeWs();

    await expect(host.accept(ws, '/chat', 'room1', 'user1', Date.now() - 1)).resolves.toBe(false);
    expect(ctx.accepted).toHaveLength(0);
    expect(ws.deserializeAttachment()).toBeNull();
  });

  it('rejects an oversized initial hibernation attachment before accepting the socket', async () => {
    const ctx = new FakeDoState();
    const runtime = await buildDoRuntime(chatModule(), ctx, { env: {} });
    const host = new DoWebSocketHost(ctx, runtime.dispatcher, runtime.registry);
    const ws = new FakeWs();

    await expect(host.accept(ws, '/chat', 'x'.repeat(17_000))).resolves.toBe(false);
    expect(ctx.accepted).toHaveLength(0);
    expect(ws.deserializeAttachment()).toBeNull();
  });

  it('broadcasts from a handler to every socket in the room', async () => {
    const ctx = new FakeDoState();
    const runtime = await buildDoRuntime(chatModule(), ctx, { env: {} });
    const host = new DoWebSocketHost(ctx, runtime.dispatcher, runtime.registry);

    const a = new FakeWs();
    const b = new FakeWs();
    await expect(acceptTrusted(host, a, '/chat', 'room1', 'ua')).resolves.toBe(true);
    await expect(acceptTrusted(host, b, '/chat', 'room1', 'ub')).resolves.toBe(true);
    a.sent.length = 0;
    b.sent.length = 0;

    await host.onMessage(a, JSON.stringify({ event: 'shout', data: 'hey' }));

    expect(a.lastFrame()).toEqual({ event: 'shout', data: 'hey' });
    expect(b.lastFrame()).toEqual({ event: 'shout', data: 'hey' });
  });

  it('re-runs gateway authorization before server-initiated fan-out', async () => {
    let authorized = true;
    @WebSocketGateway({
      path: '/delivery',
      binding: 'CHAT',
      authorizeDelivery: () => authorized,
    })
    class DeliveryGateway {}
    @Module({ imports: [WebSocketModule.forRoot()], providers: [DeliveryGateway] })
    class AppModule {}

    const ctx = new FakeDoState();
    const runtime = await buildDoRuntime(AppModule, ctx, { env: {} });
    const host = new DoWebSocketHost(ctx, runtime.dispatcher, runtime.registry);
    const ws = new FakeWs();
    await expect(acceptTrusted(host, ws, '/delivery', 'room1')).resolves.toBe(true);

    authorized = false;
    await host.broadcast({
      rooms: ['room1'],
      frame: JSON.stringify({ event: 'secret', data: 1 }),
    });

    expect(ws.sent).toEqual([]);
    expect(ws.closed?.code).toBe(1008);
    expect((ws.deserializeAttachment() as { state: string }).state).toBe('rejected');
  });
});

describe('Gateways push boundary (Worker -> Durable Object)', () => {
  it("does not resolve or call a Durable Object stub for a push over the gateway's frame limit", async () => {
    let gets = 0;
    let broadcasts = 0;
    const namespace = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => {
        gets += 1;
        return {
          async broadcast(): Promise<void> {
            broadcasts += 1;
          },
        };
      },
    };
    @WebSocketGateway({ path: '/chat', binding: 'CHAT' })
    class ChatGateway {}
    @WebSocketGateway({ path: '/large', binding: 'CHAT', maxFrameBytes: 96 * 1024 })
    class LargeGateway {}
    @Module({ imports: [WebSocketModule.forRoot()], providers: [ChatGateway, LargeGateway] })
    class AppModule {}

    const app = await createCloudflareApp(AppModule, { env: { CHAT: namespace } });
    try {
      const gateways = app.get(Gateways);
      await expect(
        gateways
          .of(ChatGateway)
          .to('r1')
          .emit('large', 'x'.repeat(70 * 1024)),
      ).rejects.toThrow(/exceeds 65536/);
      expect(gets).toBe(0);
      expect(broadcasts).toBe(0);

      await expect(
        gateways
          .of(LargeGateway)
          .to('r1')
          .emit('large', 'x'.repeat(70 * 1024)),
      ).resolves.toBeUndefined();
      expect(gets).toBe(1);
      expect(broadcasts).toBe(1);
    } finally {
      await app.close();
    }
  });
});

// ---- Worker upgrade routing ----

/**
 * Consumer middleware standing in for an access proxy: it publishes the
 * identity this environment attests (read from ENV) as the request's trusted
 * identity, before the gateway's upgrade route runs.
 */
@Injectable()
class AccessIdentityMiddleware implements NestMiddleware {
  constructor(@InjectEnv() private readonly env: VelaEnv) {}

  use(context: VelaContext, next: () => Promise<void>) {
    const subject: unknown = Reflect.get(this.env, 'ACCESS_SUBJECT');
    const expiresAtMs: unknown = Reflect.get(this.env, 'ACCESS_EXPIRES_AT_MS');
    if (typeof subject === 'string' && typeof expiresAtMs === 'number') {
      setTrustedRequestIdentity(context.req.raw, {
        principal: { issuer: 'https://access.example.test', subject, principalType: 'user' },
        tenantId: 'tenant-1',
        expiresAtMs,
      });
    }
    return next();
  }
}

@Module({ providers: [AccessIdentityMiddleware] })
class AccessIdentityModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AccessIdentityMiddleware).forRoutes('*');
  }
}

describe('gateway upgrade routes (Worker → DO)', () => {
  function mockNamespace() {
    const calls: Array<{
      id: string;
      room: string | null;
      path: string | null;
      user: string | null;
      issuer: string | null;
      subject: string | null;
      principalType: string | null;
      tenantId: string | null;
      expiresAtMs: string | null;
      url: string;
    }> = [];
    const ns = {
      idFromName: (name: string) => ({ toString: () => `id:${name}`, name }),
      get: (id: { toString(): string }) => ({
        fetch: async (req: Request) => {
          calls.push({
            id: id.toString(),
            room: req.headers.get('x-vela-room'),
            path: req.headers.get('x-vela-path'),
            user: req.headers.get('x-vela-user'),
            issuer: req.headers.get('x-vela-issuer'),
            subject: req.headers.get('x-vela-subject'),
            principalType: req.headers.get('x-vela-principal-type'),
            tenantId: req.headers.get('x-vela-tenant'),
            expiresAtMs: req.headers.get('x-vela-expires-at-ms'),
            url: req.url,
          });
          // Node's undici forbids constructing a 101 Response (valid only in
          // workerd); use 200 to stand in for "the DO returned the upgrade".
          return new Response('upgraded', { status: 200 });
        },
      }),
    };
    return { ns, calls };
  }

  it('forwards the upgrade to a gateway-scoped room id with spoof-safe headers', async () => {
    @WebSocketGateway({
      path: '/rooms/:id/ws',
      roomParam: 'id',
      binding: 'ROOM',
      authenticator: TestUpgradeAuthenticator,
    })
    class RoomGateway {
      @SubscribeMessage('noop')
      onNoop() {}
    }
    @Module({ imports: [WebSocketModule.forRoot()], providers: [RoomGateway] })
    class AppModule {}

    const { ns, calls } = mockNamespace();
    const app = await createCloudflareApp(AppModule, { env: { ROOM: ns } });

    const res = await app
      .getHonoApp()
      .request(
        '/rooms/general/ws',
        { headers: { upgrade: 'websocket', 'x-vela-user': 'spoofed' } },
        app.env,
      );

    expect(res.status).toBe(200); // whatever the DO returned, passed through
    expect(calls[0]).toMatchObject({
      id: 'id:vela:ws:v2:%2Frooms%2F%3Aid%2Fws:general',
      room: 'general',
      path: '/rooms/:id/ws',
      user: 'user-1', // client spoof was replaced by authenticated state
      issuer: 'https://issuer.test',
      subject: 'user-1',
      principalType: 'user',
      tenantId: 'tenant-1',
      url: 'http://localhost/rooms/general/ws',
    });
    expect(Number(calls[0]?.expiresAtMs)).toBeGreaterThan(Date.now());
  });

  it("authenticates through the gateway module's DI before resolving the Durable Object", async () => {
    // Only the declaring module provides the tenant, so resolution must start there.
    const TENANT = new InjectionToken<string>('test.cf.ws.tenant');
    let constructed = 0;
    class CookieAuthenticator implements UpgradeAuthenticator {
      constructor(@Inject(TENANT) private readonly tenantId: string) {
        constructed++;
      }
      authenticate(request: Request): WebSocketUpgradeIdentity | false {
        if (request.headers.get('cookie') !== 'session=valid') return false;
        return {
          principal: { issuer: 'https://issuer.test', subject: 'user-7', principalType: 'user' },
          tenantId: this.tenantId,
          expiresAtMs: Date.now() + 60_000,
        };
      }
    }
    @WebSocketGateway({
      path: '/tenant-rooms/:room/ws',
      roomParam: 'room',
      binding: 'ROOM',
      authenticator: CookieAuthenticator,
      allowedOrigins: (env) => {
        const origin: unknown = Reflect.get(env, 'APP_ORIGIN');
        return typeof origin === 'string' ? [origin] : [];
      },
    })
    class RoomGateway {}
    @Module({ providers: [defineProvider(TENANT, { useValue: 'tenant-7' }), RoomGateway] })
    class RoomsModule {}
    @Module({ imports: [WebSocketModule.forRoot(), RoomsModule] })
    class AppModule {}

    const { ns, calls } = mockNamespace();
    const resolved: string[] = [];
    const idFromName = ns.idFromName;
    ns.idFromName = (name: string) => {
      resolved.push(name);
      return idFromName(name);
    };
    const app = await createCloudflareApp(AppModule, {
      env: { ROOM: ns, APP_ORIGIN: 'https://app.test' },
    });
    const upgrade = (headers: Record<string, string>) =>
      app
        .getHonoApp()
        .request(
          'https://api.test/tenant-rooms/alpha/ws',
          { headers: { upgrade: 'websocket', origin: 'https://app.test', ...headers } },
          app.env,
        );

    const anonymous = await upgrade({});
    const foreign = await upgrade({ cookie: 'session=valid', origin: 'https://evil.test' });
    expect([anonymous.status, foreign.status]).toEqual([403, 403]);
    expect(resolved).toEqual([]);

    const first = await upgrade({ cookie: 'session=valid' });
    const second = await upgrade({ cookie: 'session=valid' });
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(calls.map(({ subject, tenantId }) => ({ subject, tenantId }))).toEqual([
      { subject: 'user-7', tenantId: 'tenant-7' },
      { subject: 'user-7', tenantId: 'tenant-7' },
    ]);
    expect(constructed).toBe(1);
  });

  it('derives room ids from a parameter not named id', async () => {
    @WebSocketGateway({
      path: '/rooms/:roomId/ws',
      roomParam: 'roomId',
      binding: 'ROOM',
      authenticator: TestUpgradeAuthenticator,
    })
    class RoomGateway {}
    @Module({ imports: [WebSocketModule.forRoot()], providers: [RoomGateway] })
    class AppModule {}

    const { ns, calls } = mockNamespace();
    const app = await createCloudflareApp(AppModule, { env: { ROOM: ns } });
    const res = await app
      .getHonoApp()
      .request('/rooms/alpha/ws', { headers: { upgrade: 'websocket' } }, app.env);

    expect(res.status).toBe(200);
    expect(calls[0]?.id).toBe('id:vela:ws:v2:%2Frooms%2F%3AroomId%2Fws:alpha');
    expect(calls[0]?.room).toBe('alpha');
  });

  it('rejects an oversized room id before Durable Object allocation', async () => {
    @WebSocketGateway({
      path: '/bounded-rooms/:room/ws',
      roomParam: 'room',
      binding: 'ROOM',
    })
    class RoomGateway {}
    @Module({ imports: [WebSocketModule.forRoot()], providers: [RoomGateway] })
    class AppModule {}

    const { ns, calls } = mockNamespace();
    const app = await createCloudflareApp(AppModule, { env: { ROOM: ns } });
    const res = await app
      .getHonoApp()
      .request(
        `/bounded-rooms/${'x'.repeat(513)}/ws`,
        { headers: { upgrade: 'websocket' } },
        app.env,
      );

    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('rejects cross-origin browsers and authorization failures before DO allocation', async () => {
    @WebSocketGateway({
      path: '/secure-ws',
      binding: 'ROOM',
      allowedOrigins: ['https://trusted.test'],
      authorizeUpgrade: (request) => request.headers.get('x-api-key') === 'valid',
    })
    class SecureGateway {}
    @Module({ imports: [WebSocketModule.forRoot()], providers: [SecureGateway] })
    class AppModule {}

    const { ns, calls } = mockNamespace();
    const app = await createCloudflareApp(AppModule, { env: { ROOM: ns } });
    const evil = await app
      .getHonoApp()
      .request(
        'https://api.test/secure-ws',
        { headers: { upgrade: 'websocket', origin: 'https://evil.test', 'x-api-key': 'valid' } },
        app.env,
      );
    const unauthorized = await app
      .getHonoApp()
      .request(
        'https://api.test/secure-ws',
        { headers: { upgrade: 'websocket', origin: 'https://trusted.test' } },
        app.env,
      );

    expect(evil.status).toBe(403);
    expect(unauthorized.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('strips spoofed internal identity headers before upgrade authorization', async () => {
    @WebSocketGateway({
      path: '/internal-header-ws',
      binding: 'ROOM',
      authorizeUpgrade: (request) => request.headers.get('x-vela-user') === 'admin',
    })
    class SecureGateway {}
    @Module({ imports: [WebSocketModule.forRoot()], providers: [SecureGateway] })
    class AppModule {}

    const { ns, calls } = mockNamespace();
    const app = await createCloudflareApp(AppModule, { env: { ROOM: ns } });
    const res = await app
      .getHonoApp()
      .request(
        '/internal-header-ws',
        { headers: { upgrade: 'websocket', 'x-vela-user': 'admin' } },
        app.env,
      );

    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('forwards request-context credential expiry into the DO attachment header', async () => {
    const expiresAtMs = Date.now() + 60_000;
    class AccessAuthenticator implements UpgradeAuthenticator {
      authenticate(): WebSocketUpgradeIdentity {
        return {
          principal: {
            issuer: 'https://access.example.test',
            subject: 'user-1',
            principalType: 'user',
          },
          tenantId: 'tenant-1',
          expiresAtMs,
        };
      }
    }
    @WebSocketGateway({ path: '/identity-ws', binding: 'ROOM', authenticator: AccessAuthenticator })
    class IdentityGateway {}
    @Module({
      imports: [WebSocketModule.forRoot(), AccessIdentityModule],
      providers: [IdentityGateway],
    })
    class AppModule {}

    const { ns, calls } = mockNamespace();
    const app = await createCloudflareApp(AppModule, {
      env: { ROOM: ns, ACCESS_SUBJECT: 'user-1', ACCESS_EXPIRES_AT_MS: expiresAtMs },
    });
    await app.getHonoApp().request('/identity-ws', { headers: { upgrade: 'websocket' } }, app.env);

    expect(calls[0]?.user).toBe('user-1');
    expect(calls[0]).toMatchObject({
      issuer: 'https://access.example.test',
      subject: 'user-1',
      principalType: 'user',
      tenantId: 'tenant-1',
      expiresAtMs: String(expiresAtMs),
    });
  });

  it('rejects a conflicting trusted request identity before DO allocation', async () => {
    @WebSocketGateway({
      path: '/expired-identity-ws',
      binding: 'ROOM',
      authenticator: TestUpgradeAuthenticator,
    })
    class IdentityGateway {}
    @Module({
      imports: [WebSocketModule.forRoot(), AccessIdentityModule],
      providers: [IdentityGateway],
    })
    class AppModule {}

    const { ns, calls } = mockNamespace();
    const app = await createCloudflareApp(AppModule, {
      env: {
        ROOM: ns,
        ACCESS_SUBJECT: 'another-user',
        ACCESS_EXPIRES_AT_MS: Date.now() + 60_000,
      },
    });
    const res = await app
      .getHonoApp()
      .request('/expired-identity-ws', { headers: { upgrade: 'websocket' } }, app.env);

    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('consumes a room-bound socket ticket once and strips it before DO forwarding', async () => {
    const secret = 'test-only-websocket-ticket-secret';
    const nonceStore = new MemoryNonceStore();
    class TicketAuthenticator implements UpgradeAuthenticator {
      async authenticate(
        _request: Request,
        context: WebSocketUpgradeAuthenticationContext,
      ): Promise<WebSocketUpgradeIdentity | false> {
        if (!context.ticket) return false;
        return verifyAndConsumeWebSocketTicket(context.ticket, {
          secret,
          gatewayPath: context.gatewayPath,
          room: context.room,
          nonceStore,
        });
      }
    }
    @WebSocketGateway({
      path: '/ticket-rooms/:room/ws',
      roomParam: 'room',
      binding: 'ROOM',
      authenticator: TicketAuthenticator,
    })
    class TicketGateway {}
    @Module({ imports: [WebSocketModule.forRoot()], providers: [TicketGateway] })
    class AppModule {}

    const ticket = await issueWebSocketTicket({
      secret,
      gatewayPath: '/ticket-rooms/:room/ws',
      room: 'alpha',
      principal: { issuer: 'https://issuer.test', subject: 'user-1', principalType: 'user' },
      tenantId: 'tenant-1',
    });
    const { ns, calls } = mockNamespace();
    const app = await createCloudflareApp(AppModule, { env: { ROOM: ns } });
    const first = await app
      .getHonoApp()
      .request(
        `/ticket-rooms/alpha/ws?ticket=${encodeURIComponent(ticket)}`,
        { headers: { upgrade: 'websocket' } },
        app.env,
      );
    const replay = await app
      .getHonoApp()
      .request(
        `/ticket-rooms/alpha/ws?ticket=${encodeURIComponent(ticket)}`,
        { headers: { upgrade: 'websocket' } },
        app.env,
      );

    expect(first.status).toBe(200);
    expect(replay.status).toBe(403);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      user: 'user-1',
      issuer: 'https://issuer.test',
      subject: 'user-1',
      principalType: 'user',
      tenantId: 'tenant-1',
    });
    expect(calls[0]?.url).toBe('http://localhost/ticket-rooms/alpha/ws');
  });

  it('rejects a non-upgrade request with 426', async () => {
    @WebSocketGateway({ path: '/ws', binding: 'ROOM' })
    class Gw {
      @SubscribeMessage('noop')
      onNoop() {}
    }
    @Module({ imports: [WebSocketModule.forRoot()], providers: [Gw] })
    class AppModule {}

    const app = await createCloudflareApp(AppModule, { env: {} });
    const res = await app.getHonoApp().request('/ws', undefined, app.env);
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
    @Module({ imports: [WebSocketModule.forRoot()], providers: [ChatGateway] })
    class AppModule {}

    const ctx = new FakeDoState();
    const DoClass = VelaWebSocketDurableObject(AppModule);
    const instance = new DoClass(ctx as never, {}) as unknown as {
      broadcast(cmd: BroadcastCommand): Promise<void>;
      webSocketMessage(ws: WsLike, msg: string): Promise<void>;
    };

    // A socket already in room1 (as if accepted earlier).
    const ws = new FakeWs();
    ws.serializeAttachment({
      connId: 'x',
      state: 'active',
      path: '/chat',
      rooms: ['room1'],
      expiresAtMs: Date.now() + 60_000,
      data: {
        principal: {
          issuer: 'https://issuer.test',
          subject: 'user-1',
          principalType: 'user',
        },
        tenantId: 'tenant-1',
        expiresAtMs: Date.now() + 60_000,
      },
    });
    ctx.acceptWebSocket(ws, [roomTag('room1')]);

    await instance.broadcast({
      rooms: ['room1'],
      frame: JSON.stringify({ event: 'ping', data: 1 }),
    });

    expect(ws.lastFrame()).toEqual({ event: 'ping', data: 1 });
  });
});

describe('cloudflare — code-review regressions', () => {
  it('does not deliver to a socket that left the hub room (attachment beats the immutable tag)', () => {
    const ctx = new FakeDoState();
    const a = new FakeWs();
    a.serializeAttachment({
      connId: 'a',
      state: 'active',
      path: '/c',
      rooms: ['lobby'],
      data: {},
    });
    ctx.acceptWebSocket(a, [roomTag('lobby')]);
    const b = new FakeWs();
    b.serializeAttachment({
      connId: 'b',
      state: 'active',
      path: '/c',
      rooms: ['lobby'],
      data: {},
    });
    ctx.acceptWebSocket(b, [roomTag('lobby')]);

    // b leaves the hub room: the hibernation tag is immutable, but attachment.rooms updates.
    b.serializeAttachment({
      connId: 'b',
      state: 'active',
      path: '/c',
      rooms: [],
      data: {},
    });

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
    @Module({ imports: [WebSocketModule.forRoot()], providers: [MiniGateway] })
    class MiniApp {}

    const ctx = new FakeDoState();
    const runtime = await buildDoRuntime(MiniApp, ctx, { env: {} });
    const host = new DoWebSocketHost(ctx, runtime.dispatcher, runtime.registry);

    const ws = new FakeWs();
    ws.serializeAttachment({
      connId: 'x',
      state: 'active',
      path: '/c',
      rooms: ['lobby'],
      data: {},
    });

    await expect(host.onClose(ws, 1006, '')).resolves.toBeUndefined();
    expect(ws.closed).toBeDefined(); // handshake completed with a codeless close, no throw
  });
});
