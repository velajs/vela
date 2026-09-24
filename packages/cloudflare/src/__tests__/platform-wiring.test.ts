import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Global, Injectable, Module, defineProvider } from '@velajs/vela';
import {
  WS_SERVER,
  WS_TRANSPORT,
  WebSocketGateway,
  WebSocketModule,
  WebSocketServer,
  WsServerImpl,
  type UpgradeAuthenticator,
  type WebSocketTransport,
  type WebSocketUpgradeIdentity,
  type WsServer,
} from '@velajs/vela/websocket';
import {
  InMemoryCursorLog,
  LIVE_CURSOR_LOG,
  LIVE_DRIVER,
  LiveInvalidation,
  LiveModule,
  localLive,
  type CommitStamp,
  type InvalidationCommand,
} from '@velajs/vela/live';
import { createCloudflareApp } from '../cloudflare-factory';
import { buildDoRuntime } from '../websocket/do-bootstrap';
import { DoCursorLog } from '../websocket/do-live';
import { durableObjectLive, type LiveNamespace } from '../websocket/live-driver';
import type { DoStateLike, SqlStorageLike, WsLike } from '../websocket/do-state';

afterEach(() => {
  vi.restoreAllMocks();
});

function sqlValue(value: unknown): SQLInputValue {
  if (value === null || typeof value === 'number' || typeof value === 'string') return value;
  throw new TypeError('Unsupported SQL binding');
}

/** Real SQLite (node:sqlite) behind the structural SqlStorageLike. */
function sqlStorage(): SqlStorageLike {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query: string, ...bindings: unknown[]) {
      const values = bindings.map(sqlValue);
      if (query.trimStart().toUpperCase().startsWith('SELECT')) {
        const rows = db.prepare(query).all(...values);
        return { toArray: () => rows };
      }
      if (values.length > 0) db.prepare(query).run(...values);
      else db.exec(query);
      return { toArray: () => [] };
    },
  };
}

/**
 * workerd's `ctx.storage.sql` on a Durable Object class without SQLite: the
 * handle exists, and every statement throws.
 */
function sqlDisabledStorage(): SqlStorageLike {
  return {
    exec() {
      throw new Error('SQL is not enabled for this Durable Object class.');
    },
  };
}

class RecordingWs implements WsLike {
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
}

class DoState implements DoStateLike {
  readonly id = { toString: () => 'do-1', name: 'room-1' };
  readonly sockets: Array<{ ws: WsLike; tags: string[] }> = [];
  constructor(readonly storage?: { sql?: SqlStorageLike }) {}
  acceptWebSocket(ws: WsLike, tags: string[] = []): void {
    this.sockets.push({ ws, tags });
  }
  getWebSockets(tag?: string): WsLike[] {
    return this.sockets.filter((s) => tag === undefined || s.tags.includes(tag)).map((s) => s.ws);
  }
}

@Injectable()
class TestAuthenticator implements UpgradeAuthenticator {
  authenticate(): WebSocketUpgradeIdentity {
    return {
      principal: { issuer: 'https://issuer.test', subject: 'user-1', principalType: 'user' },
      tenantId: 'tenant-1',
      expiresAtMs: Date.now() + 60_000,
    };
  }
}

/** A namespace whose room stubs record invalidations. */
function liveNamespace(
  label: string,
  calls: Array<{ label: string; id: string; cmd: InvalidationCommand }>,
) {
  const namespace: LiveNamespace = {
    idFromName(name) {
      return { name, toString: () => name, equals: (other) => other.toString() === name };
    },
    get(id) {
      return {
        invalidate: async (cmd: InvalidationCommand): Promise<CommitStamp> => {
          calls.push({ label, id: id.toString(), cmd });
          return { cursor: 3, epoch: label };
        },
      };
    },
  };
  return namespace;
}

describe('Cloudflare WebSocket platform wiring', () => {
  it("gives Worker gateways a server that points pushes at the room's Durable Object", async () => {
    @WebSocketGateway({ path: '/rooms/:id/ws', roomParam: 'id', binding: 'ROOMS' })
    class RoomsGateway {
      constructor(@WebSocketServer() readonly server: WsServer) {}
    }
    @Module({ imports: [WebSocketModule.forRoot()], providers: [RoomsGateway] })
    class App {}

    const app = await createCloudflareApp(App, { env: {} });
    try {
      const server = app.get(RoomsGateway).server;
      expect(server).toBe(app.get(WS_SERVER));
      expect(() => server.to('general')).toThrow(
        /only available inside the WebSocket Durable Object/,
      );
      expect(() => server.emit('ping')).toThrow(/broadcastToRoom/);
    } finally {
      await app.close();
    }
  });

  it("lets an application's global WS_TRANSPORT override the adapter's for every reader", async () => {
    const forwarded: string[] = [];
    const custom: WebSocketTransport = {
      createServer: (driver) => new WsServerImpl(driver),
      forwardUpgrade: async ({ binding }) => {
        forwarded.push(binding);
        return new Response('custom transport');
      },
    };
    @Global()
    @Module({
      providers: [defineProvider(WS_TRANSPORT, { useValue: custom })],
      exports: [WS_TRANSPORT],
    })
    class TransportModule {}
    @WebSocketGateway({ path: '/chat', binding: 'CHAT', authenticator: TestAuthenticator })
    class ChatGateway {}
    @Module({ imports: [TransportModule, WebSocketModule.forRoot()], providers: [ChatGateway] })
    class App {}

    const env = {};
    const app = await createCloudflareApp(App, { env });
    try {
      expect(app.get(WS_SERVER)).toBeInstanceOf(WsServerImpl);
      const upgrade = new Request('https://worker.test/chat', {
        headers: { upgrade: 'websocket' },
      });
      expect(await (await app.fetch(upgrade, env)).text()).toBe('custom transport');
      expect(forwarded).toEqual(['CHAT']);
    } finally {
      await app.close();
    }
  });

  it("binds Durable Object gateways to that object's hibernatable sockets", async () => {
    @WebSocketGateway({ path: '/chat', binding: 'CHAT', authenticator: TestAuthenticator })
    class ChatGateway {
      constructor(@WebSocketServer() readonly server: WsServer) {}
    }
    @Module({ imports: [WebSocketModule.forRoot()], providers: [ChatGateway] })
    class App {}

    const ctx = new DoState();
    const runtime = await buildDoRuntime(App, ctx, { env: {} });
    try {
      const ws = new RecordingWs();
      ws.serializeAttachment({
        connId: 'c1',
        state: 'active',
        path: '/chat',
        rooms: ['room-1'],
        expiresAtMs: Date.now() + 60_000,
        data: {
          principal: { issuer: 'https://issuer.test', subject: 'user-1', principalType: 'user' },
          tenantId: 'tenant-1',
          expiresAtMs: Date.now() + 60_000,
        },
      });
      ctx.acceptWebSocket(ws, ['room:room-1']);

      expect(runtime.container.resolve(ChatGateway).server).toBe(runtime.server);
      await runtime.server.to('room-1').emit('hello', 1);
      expect(ws.sent.map((frame) => JSON.parse(frame))).toEqual([{ event: 'hello', data: 1 }]);
    } finally {
      await runtime.close();
    }
  });

  it('reports a binding-backed gateway the Worker cannot serve without WebSocketModule', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    @WebSocketGateway({ path: '/unserved', binding: 'UNSERVED', authenticator: TestAuthenticator })
    class UnservedGateway {}
    @Module({ providers: [UnservedGateway] })
    class WithoutWebSockets {}
    @Module({ imports: [WebSocketModule.forRoot()], providers: [UnservedGateway] })
    class WithWebSockets {}

    const env = {};
    const unserved = await createCloudflareApp(WithoutWebSockets, { env });
    const served = await createCloudflareApp(WithWebSockets, { env });
    try {
      const messages = warn.mock.calls.map(([message]) => String(message));
      expect(messages.filter((message) => message.includes("'/unserved'"))).toEqual([
        expect.stringMatching(/UnservedGateway.*binding 'UNSERVED'.*WebSocketModule\.forRoot\(\)/),
      ]);
      const upgrade = new Request('https://worker.test/unserved', {
        headers: { upgrade: 'websocket' },
      });
      expect((await unserved.fetch(upgrade, env)).status).toBe(404);
    } finally {
      await Promise.all([unserved.close(), served.close()]);
    }
  });

  it('requires WebSocketModule in an application served by a WebSocket Durable Object', async () => {
    @Module({})
    class WithoutWebSockets {}

    await expect(buildDoRuntime(WithoutWebSockets, new DoState(), { env: {} })).rejects.toThrow(
      /WebSocketModule\.forRoot\(\)/,
    );
  });
});

describe('Cloudflare live platform wiring', () => {
  const PATH = '/rooms/:id/ws';

  it("routes Worker invalidations to the single gateway's room object, read lazily from ENV", async () => {
    const calls: Array<{ label: string; id: string; cmd: InvalidationCommand }> = [];
    @WebSocketGateway({ path: PATH, roomParam: 'id', binding: 'ROOMS' })
    class RoomsGateway {}
    @Module({
      imports: [WebSocketModule.forRoot(), LiveModule.forRoot()],
      providers: [RoomsGateway],
    })
    class App {}

    const env: Record<string, unknown> = {};
    const app = await createCloudflareApp(App, { env });
    try {
      expect(app.get(LIVE_DRIVER).kind).toBe('durable-object');
      await expect(app.get(LiveInvalidation).invalidate({ tags: ['todos'] })).rejects.toThrow(
        /ENV\.ROOMS is not set: declare the Durable Object namespace binding 'ROOMS' under durable_objects\.bindings/,
      );

      // The namespace is read when an invalidation needs it, not at bootstrap.
      env.ROOMS = liveNamespace('rooms', calls);
      const stamp = await app.get(LiveInvalidation).invalidate({ tags: ['todos'] });
      expect(stamp).toEqual({ cursor: 3, epoch: 'rooms' });
      await app.get(LiveInvalidation).invalidate({ tags: ['todos'], room: 'org-1' });
      expect(calls.map(({ id, cmd }) => ({ id, cmd }))).toEqual([
        {
          id: 'vela:ws:v2:%2Frooms%2F%3Aid%2Fws:default',
          cmd: { tags: ['todos'], room: 'default' },
        },
        {
          id: 'vela:ws:v2:%2Frooms%2F%3Aid%2Fws:org-1',
          cmd: { tags: ['todos'], room: 'org-1' },
        },
      ]);
    } finally {
      await app.close();
    }
  });

  it('raises an ambiguity error only when it must choose between binding-backed gateways', async () => {
    const calls: Array<{ label: string; id: string; cmd: InvalidationCommand }> = [];
    @WebSocketGateway({ path: '/chat', binding: 'CHAT' })
    class ChatGateway {}
    @WebSocketGateway({ path: PATH, roomParam: 'id', binding: 'ROOMS' })
    class RoomsGateway {}
    @WebSocketGateway({ path: '/local' })
    class LocalGateway {}

    const env = { CHAT: liveNamespace('chat', calls), ROOMS: liveNamespace('rooms', calls) };
    const build = (live: ReturnType<typeof LiveModule.forRoot>) => {
      @Module({
        imports: [WebSocketModule.forRoot(), live],
        providers: [ChatGateway, RoomsGateway, LocalGateway],
      })
      class App {}
      return createCloudflareApp(App, { env });
    };

    const ambiguous = await build(LiveModule.forRoot());
    const byBinding = await build(
      LiveModule.forRoot({ driver: () => durableObjectLive({ binding: 'ROOMS' }) }),
    );
    const byPath = await build(
      LiveModule.forRoot({ driver: () => durableObjectLive({ gatewayPath: '/chat' }) }),
    );
    try {
      await expect(ambiguous.get(LiveInvalidation).invalidate({ tags: ['t'] })).rejects.toThrow(
        /several binding-backed gateways \('\/chat', '\/rooms\/:id\/ws'\)/,
      );
      await byBinding.get(LiveInvalidation).invalidate({ tags: ['t'] });
      await byPath.get(LiveInvalidation).invalidate({ tags: ['t'] });
      expect(calls.map(({ label, id }) => ({ label, id }))).toEqual([
        { label: 'rooms', id: 'vela:ws:v2:%2Frooms%2F%3Aid%2Fws:default' },
        { label: 'chat', id: 'vela:ws:v2:%2Fchat:default' },
      ]);
    } finally {
      await Promise.all([ambiguous.close(), byBinding.close(), byPath.close()]);
    }
  });

  it('delivers a Worker invalidation sent from a lifecycle hook', async () => {
    const calls: Array<{ label: string; id: string; cmd: InvalidationCommand }> = [];
    const stamps: Array<CommitStamp | undefined> = [];
    @Injectable()
    class Startup {
      constructor(private readonly live: LiveInvalidation) {}
      async onModuleInit() {
        stamps.push(await this.live.invalidate({ tags: ['init'] }));
      }
      async onApplicationBootstrap() {
        stamps.push(await this.live.invalidate({ tags: ['bootstrap'] }));
      }
    }
    @WebSocketGateway({ path: PATH, roomParam: 'id', binding: 'ROOMS' })
    class RoomsGateway {}
    @Module({
      imports: [WebSocketModule.forRoot(), LiveModule.forRoot()],
      providers: [RoomsGateway, Startup],
    })
    class App {}

    const app = await createCloudflareApp(App, { env: { ROOMS: liveNamespace('rooms', calls) } });
    try {
      expect(stamps).toEqual([
        { cursor: 3, epoch: 'rooms' },
        { cursor: 3, epoch: 'rooms' },
      ]);
      expect(calls.map(({ cmd }) => cmd.tags)).toEqual([['init'], ['bootstrap']]);
    } finally {
      await app.close();
    }
  });

  it('refuses a Worker invalidation when no gateway is backed by a binding', async () => {
    @Module({ imports: [WebSocketModule.forRoot(), LiveModule.forRoot()] })
    class App {}

    const app = await createCloudflareApp(App, { env: {} });
    try {
      await expect(app.get(LiveInvalidation).invalidate({ tags: ['t'] })).rejects.toThrow(
        /no @WebSocketGateway names a binding/,
      );
    } finally {
      await app.close();
    }
  });

  it('warns once when the Worker isolate is configured to deliver locally', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    @Module({
      imports: [WebSocketModule.forRoot(), LiveModule.forRoot({ driver: () => localLive() })],
    })
    class LocalLive {}

    const first = await createCloudflareApp(LocalLive, { env: {} });
    const second = await createCloudflareApp(LocalLive, { env: {} });
    const warnings = warn.mock.calls.filter(([message]) =>
      String(message).includes('localLive() in the Worker isolate'),
    );
    expect(warnings).toHaveLength(1);
    await Promise.all([first.close(), second.close()]);
  });

  it('keeps the SQLite cursor log and local delivery inside a SQLite Durable Object', async () => {
    let stamp: CommitStamp | undefined;
    @Injectable()
    class Startup {
      constructor(private readonly live: LiveInvalidation) {}
      async onModuleInit() {
        stamp = await this.live.invalidate({ tags: ['startup'] });
      }
    }
    @WebSocketGateway({ path: PATH, roomParam: 'id', binding: 'ROOMS' })
    class RoomsGateway {}
    @Module({
      imports: [
        WebSocketModule.forRoot(),
        LiveModule.forRoot({ driver: () => durableObjectLive({ binding: 'ROOMS' }) }),
      ],
      providers: [RoomsGateway, Startup],
    })
    class App {}

    // No ROOMS binding: inside its Durable Object the driver never goes remote.
    const runtime = await buildDoRuntime(App, new DoState({ sql: sqlStorage() }), { env: {} });
    try {
      expect(runtime.live).toBeDefined();
      expect(stamp?.cursor).toBe(1);
      expect(stamp?.epoch).toBeTypeOf('string');
    } finally {
      await runtime.close();
    }
  });

  it('falls back to an in-memory log in a Durable Object without SQLite', async () => {
    @Module({ imports: [WebSocketModule.forRoot(), LiveModule.forRoot()] })
    class App {}

    const sqlite = await buildDoRuntime(App, new DoState({ sql: sqlStorage() }), { env: {} });
    const plain = await buildDoRuntime(App, new DoState({ sql: sqlDisabledStorage() }), {
      env: {},
    });
    const bare = await buildDoRuntime(App, new DoState(), { env: {} });
    try {
      expect(sqlite.container.resolve(LIVE_CURSOR_LOG)).toBeInstanceOf(DoCursorLog);
      for (const runtime of [plain, bare]) {
        expect(runtime.container.resolve(LIVE_CURSOR_LOG)).toBeInstanceOf(InMemoryCursorLog);
        expect(runtime.container.resolve(LIVE_DRIVER).kind).toBe('local');
        // oxlint-disable-next-line eslint/no-await-in-loop -- one runtime at a time
        expect(await runtime.live?.applyInvalidation({ tags: ['t'] })).toMatchObject({
          cursor: 1,
        });
      }
    } finally {
      await Promise.all([sqlite.close(), plain.close(), bare.close()]);
    }
  });
});
