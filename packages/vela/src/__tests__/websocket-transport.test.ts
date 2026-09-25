import { describe, expect, it } from 'vitest';
import {
  Global,
  Injectable,
  Module,
  VelaFactory,
  defineProvider,
  type NestMiddleware,
  type MiddlewareConsumer,
  type NestModule,
  type VelaContext,
} from '../index.js';
import { setTrustedRequestIdentity, type RuntimeAdapter } from '../module-kit.js';
import {
  WS_SERVER,
  WS_SYNC_DRIVER,
  WS_TRANSPORT,
  WebSocketGateway,
  WebSocketModule,
  WebSocketServer,
  WsServerImpl,
  type BroadcastOperator,
  type ForwardedWebSocketUpgrade,
  type SyncDriver,
  type UpgradeAuthenticator,
  type WebSocketTransport,
  type WebSocketUpgradeIdentity,
  type WsServer,
} from '../websocket/index.js';

function identity(subject: string, expiresAtMs = Date.now() + 60_000): WebSocketUpgradeIdentity {
  return {
    principal: { issuer: 'https://issuer.test', subject, principalType: 'user' },
    tenantId: 'tenant-1',
    expiresAtMs,
  };
}

@Injectable()
class StaticAuthenticator implements UpgradeAuthenticator {
  authenticate(): WebSocketUpgradeIdentity {
    return identity('user-1');
  }
}

/** A platform whose sockets live in another isolate: every upgrade is forwarded. */
class ForwardingTransport implements WebSocketTransport {
  readonly forwardingHeaders = ['x-platform-room', 'x-platform-subject'];
  readonly forwarded: ForwardedWebSocketUpgrade[] = [];

  async forwardUpgrade(upgrade: ForwardedWebSocketUpgrade): Promise<Response> {
    this.forwarded.push(upgrade);
    return new Response('forwarded', { status: 200 });
  }
}

function transportAdapter(transport: WebSocketTransport): RuntimeAdapter {
  return {
    name: 'test-platform',
    configureContainer(container) {
      container.register(defineProvider(WS_TRANSPORT, { useValue: transport }));
      container.markGlobalToken(WS_TRANSPORT);
    },
  };
}

class RecordingServer implements WsServer {
  readonly emitted: Array<{ event: string; data?: unknown }> = [];
  emit(event: string, data?: unknown): void {
    this.emitted.push({ event, data });
  }
  to(): BroadcastOperator {
    throw new Error('not used');
  }
  in(): BroadcastOperator {
    throw new Error('not used');
  }
  except(): BroadcastOperator {
    throw new Error('not used');
  }
}

describe('WebSocketModule platform transport', () => {
  it("builds the gateway server through the transport, from the module's sync driver", async () => {
    const server = new RecordingServer();
    const drivers: SyncDriver[] = [];
    const transport: WebSocketTransport = {
      createServer(driver) {
        drivers.push(driver);
        return server;
      },
    };

    @WebSocketGateway({ path: '/chat', authenticator: StaticAuthenticator })
    class ChatGateway {
      constructor(@WebSocketServer() readonly server: WsServer) {}
    }
    @Module({ imports: [WebSocketModule.forRoot()], providers: [ChatGateway] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, { adapters: [transportAdapter(transport)] });
    try {
      expect(app.get(WS_SERVER)).toBe(server);
      expect(drivers).toEqual([app.get(WS_SYNC_DRIVER)]);
      // A transport server without forGateway is the one every gateway pushes through.
      await app.get(ChatGateway).server.emit('ping', 1);
      expect(server.emitted).toEqual([{ event: 'ping', data: 1 }]);
    } finally {
      await app.close();
    }
  });

  it('keeps an in-process server without a transport', async () => {
    @Module({ imports: [WebSocketModule.forRoot()] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    try {
      expect(app.get(WS_SERVER)).toBeInstanceOf(WsServerImpl);
    } finally {
      await app.close();
    }
  });

  it('mounts no upgrade route without a forwarding transport', async () => {
    @WebSocketGateway({ path: '/rooms', binding: 'ROOMS', authenticator: StaticAuthenticator })
    class RoomsGateway {}
    @Module({ imports: [WebSocketModule.forRoot()], providers: [RoomsGateway] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, {
      adapters: [transportAdapter({ createServer: () => new RecordingServer() })],
    });
    try {
      const response = await app.getHonoApp().request('/rooms', {
        headers: { upgrade: 'websocket' },
      });
      expect(response.status).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('WebSocketModule forwarding upgrade routes', () => {
  it('authenticates each binding-backed upgrade and forwards it with trusted values', async () => {
    const transport = new ForwardingTransport();
    const seen: Array<string | null> = [];

    @WebSocketGateway({
      path: '/rooms/:room/ws',
      roomParam: 'room',
      binding: 'ROOMS',
      authenticator: StaticAuthenticator,
      authorizeUpgrade: (request) => {
        seen.push(request.headers.get('x-platform-subject'));
        return true;
      },
    })
    class RoomsGateway {}
    @WebSocketGateway({ path: '/local', authenticator: StaticAuthenticator })
    class LocalGateway {}
    @Module({ imports: [WebSocketModule.forRoot()], providers: [RoomsGateway, LocalGateway] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, { adapters: [transportAdapter(transport)] });
    try {
      const hono = app.getHonoApp();
      const response = await hono.request('/rooms/general/ws?ticket=one-time', {
        headers: { upgrade: 'websocket', 'x-platform-subject': 'spoofed', cookie: 'a=b' },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('forwarded');
      expect(seen).toEqual([null]);

      const [upgrade] = transport.forwarded;
      expect(upgrade).toMatchObject({
        gatewayPath: '/rooms/:room/ws',
        room: 'general',
        binding: 'ROOMS',
        identity: {
          principal: { issuer: 'https://issuer.test', subject: 'user-1', principalType: 'user' },
          tenantId: 'tenant-1',
        },
      });
      expect(upgrade?.request.url).toBe('http://localhost/rooms/general/ws');
      expect(upgrade?.request.headers.get('x-platform-subject')).toBeNull();
      expect(upgrade?.request.headers.get('cookie')).toBe('a=b');

      expect((await hono.request('/rooms/general/ws')).status).toBe(426);
      expect((await hono.request('/local', { headers: { upgrade: 'websocket' } })).status).toBe(
        404,
      );
      expect(transport.forwarded).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('refuses before forwarding when the room, the upgrade or the identity is invalid', async () => {
    const transport = new ForwardingTransport();

    @Injectable()
    class ExpiredAuthenticator implements UpgradeAuthenticator {
      authenticate(request: Request): WebSocketUpgradeIdentity | false {
        return request.headers.get('cookie') === 'session=valid' ? identity('user-1') : false;
      }
    }
    @WebSocketGateway({
      path: '/rooms/:room/ws',
      roomParam: 'room',
      binding: 'ROOMS',
      authenticator: ExpiredAuthenticator,
    })
    class RoomsGateway {}
    @Module({ imports: [WebSocketModule.forRoot()], providers: [RoomsGateway] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, { adapters: [transportAdapter(transport)] });
    try {
      const hono = app.getHonoApp();
      const oversized = 'x'.repeat(600);
      const badRoom = await hono.request(`/rooms/${oversized}/ws`, {
        headers: { upgrade: 'websocket', cookie: 'session=valid' },
      });
      expect(badRoom.status).toBe(400);
      const refused = await hono.request('/rooms/general/ws', {
        headers: { upgrade: 'websocket' },
      });
      expect(refused.status).toBe(403);
      expect(transport.forwarded).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("reconciles the request's trusted identity from consumer middleware", async () => {
    const transport = new ForwardingTransport();
    const expiresAtMs = Date.now() + 30_000;

    @Injectable()
    class TrustedIdentityMiddleware implements NestMiddleware {
      use(context: VelaContext, next: () => Promise<void>) {
        const subject = context.req.header('x-test-subject');
        if (subject) {
          setTrustedRequestIdentity(context.req.raw, { ...identity(subject), expiresAtMs });
        }
        return next();
      }
    }

    @WebSocketGateway({ path: '/ws', binding: 'ROOMS', authenticator: StaticAuthenticator })
    class Gateway {}
    @Module({ imports: [WebSocketModule.forRoot()], providers: [Gateway] })
    class AppModule implements NestModule {
      configure(consumer: MiddlewareConsumer) {
        consumer.apply(TrustedIdentityMiddleware).forRoutes('*');
      }
    }

    const app = await VelaFactory.create(AppModule, { adapters: [transportAdapter(transport)] });
    try {
      const hono = app.getHonoApp();
      const agreed = await hono.request('/ws', {
        headers: { upgrade: 'websocket', 'x-test-subject': 'user-1' },
      });
      expect(agreed.status).toBe(200);
      // The narrower of the two credential lifetimes wins.
      expect(transport.forwarded[0]?.identity.expiresAtMs).toBe(expiresAtMs);

      const conflicting = await hono.request('/ws', {
        headers: { upgrade: 'websocket', 'x-test-subject': 'someone-else' },
      });
      expect(conflicting.status).toBe(403);
      expect(transport.forwarded).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("serves the gateway server and upgrade route from an application's global transport", async () => {
    const platform = new ForwardingTransport();
    const custom = new ForwardingTransport();
    const server = new RecordingServer();
    const application: WebSocketTransport = {
      createServer: () => server,
      forwardUpgrade: (upgrade) => custom.forwardUpgrade(upgrade),
    };

    @WebSocketGateway({ path: '/chat', binding: 'CHAT', authenticator: StaticAuthenticator })
    class ChatGateway {}
    @Global()
    @Module({
      providers: [defineProvider(WS_TRANSPORT, { useValue: application })],
      exports: [WS_TRANSPORT],
    })
    class TransportModule {}
    @Module({
      imports: [TransportModule, WebSocketModule.forRoot()],
      providers: [ChatGateway],
    })
    class AppModule {}

    // The adapter registers its transport as a platform default; the
    // application's global module overrides it for every reader.
    const app = await VelaFactory.create(AppModule, { adapters: [transportAdapter(platform)] });
    try {
      expect(app.get(WS_SERVER)).toBe(server);
      const response = await app.getHonoApp().request('/chat', {
        headers: { upgrade: 'websocket' },
      });
      expect(response.status).toBe(200);
      expect(custom.forwarded.map(({ binding }) => binding)).toEqual(['CHAT']);
      expect(platform.forwarded).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('mounts a gateway once when several WebSocketModule instances discover it', async () => {
    const transport = new ForwardingTransport();

    @WebSocketGateway({ path: '/ws', binding: 'ROOMS', authenticator: StaticAuthenticator })
    class Gateway {}
    // The gateway's module sees one server; each instance's dispatcher
    // discovers the gateway application-wide.
    @Module({ imports: [WebSocketModule.forRoot()], providers: [Gateway] })
    class GatewayModule {}
    @Module({ imports: [WebSocketModule.forRoot({ key: 'second' })] })
    class OtherModule {}
    @Module({ imports: [GatewayModule, OtherModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, {
      adapters: [transportAdapter(transport)],
      diagnostics: 'silent',
    });
    try {
      const routes = app
        .getHonoApp()
        .routes.filter((route) => route.path === '/ws' && route.method === 'GET');
      expect(routes).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
