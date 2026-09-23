import { describe, expect, it } from 'vitest';
import { WSContext, defineWebSocketHelper, type WSEvents } from 'hono/ws';
import {
  Inject,
  Injectable,
  InjectionToken,
  Module,
  VelaFactory,
  defineProvider,
  type VelaApplication,
} from '../index.js';
import {
  WebSocketGateway,
  WebSocketModule,
  type OnGatewayConnection,
  type UpgradeAuthenticator,
  type WebSocketUpgradeAuthenticationContext,
  type WebSocketUpgradeIdentity,
  type WsClient,
} from '../websocket/index.js';
import { registerWebSocketGateways } from '../websocket-node/index.js';

function identity(subject: string): WebSocketUpgradeIdentity {
  return {
    principal: { issuer: 'https://issuer.test', subject, principalType: 'user' },
    tenantId: 'tenant-1',
    expiresAtMs: Date.now() + 60_000,
  };
}

/** Accept each upgrade the gateway admits and keep its socket events. */
function serve(app: VelaApplication): WSEvents[] {
  const opened: WSEvents[] = [];
  const upgrade = defineWebSocketHelper((_context, events) => {
    opened.push(events);
    return new Response(null, { status: 200 });
  });
  registerWebSocketGateways(app, upgrade);
  return opened;
}

function socket(): WSContext {
  return new WSContext({ send() {}, close() {}, readyState: 1 });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

@Injectable()
class StaticAuthenticator implements UpgradeAuthenticator {
  authenticate(): WebSocketUpgradeIdentity {
    return identity('static-user');
  }
}

describe('WebSocket upgrade authenticators', () => {
  it("resolves the authenticator through the gateway's declaring module, once per application", async () => {
    // Visible only inside the feature module: resolution must start there.
    const SESSIONS = new InjectionToken<ReadonlyMap<string, string>>('test.ws.sessions');
    const contexts: WebSocketUpgradeAuthenticationContext[] = [];
    const connected: unknown[] = [];
    let constructed = 0;

    @Injectable()
    class SessionAuthenticator implements UpgradeAuthenticator {
      constructor(@Inject(SESSIONS) private readonly sessions: ReadonlyMap<string, string>) {
        constructed++;
      }

      authenticate(request: Request, context: WebSocketUpgradeAuthenticationContext) {
        contexts.push(context);
        const subject = this.sessions.get(request.headers.get('x-session') ?? '');
        return subject === undefined ? false : identity(subject);
      }
    }

    @WebSocketGateway({
      path: '/rooms/:room/ws',
      roomParam: 'room',
      authenticator: SessionAuthenticator,
    })
    class RoomGateway implements OnGatewayConnection {
      handleConnection(client: WsClient): void {
        connected.push(client.data);
      }
    }

    @Module({
      providers: [
        defineProvider(SESSIONS, { useValue: new Map([['session-1', 'user-1']]) }),
        RoomGateway,
      ],
    })
    class RoomsModule {}

    @Module({ imports: [WebSocketModule.forRoot({}), RoomsModule] })
    class AppModule {}

    const first = await VelaFactory.create(AppModule);
    const second = await VelaFactory.create(AppModule);
    try {
      const opened = serve(first);
      const denied = await first.fetch(
        new Request('http://localhost/rooms/alpha/ws', { headers: { 'x-session': 'unknown' } }),
      );
      const admitted = await first.fetch(
        new Request('http://localhost/rooms/alpha/ws?ticket=opaque', {
          headers: { 'x-session': 'session-1' },
        }),
      );

      expect(denied.status).toBe(403);
      expect(admitted.status).toBe(200);
      expect(contexts).toEqual([
        { gatewayPath: '/rooms/:room/ws', room: 'alpha' },
        { gatewayPath: '/rooms/:room/ws', room: 'alpha', ticket: 'opaque' },
      ]);
      expect(opened).toHaveLength(1);
      opened[0]?.onOpen?.(new Event('open'), socket());
      await settle();
      expect(connected).toEqual([
        expect.objectContaining({
          principal: { issuer: 'https://issuer.test', subject: 'user-1', principalType: 'user' },
          tenantId: 'tenant-1',
        }),
      ]);
      // One instance serves every upgrade of an application...
      expect(constructed).toBe(1);

      serve(second);
      await second.fetch(
        new Request('http://localhost/rooms/beta/ws', { headers: { 'x-session': 'session-1' } }),
      );
      // ...and each application owns its own.
      expect(constructed).toBe(2);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('fails closed without an authenticator and when the authenticator throws', async () => {
    @Injectable()
    class ThrowingAuthenticator implements UpgradeAuthenticator {
      authenticate(): never {
        throw new Error('token service unavailable');
      }
    }

    @WebSocketGateway({ path: '/anonymous' })
    class AnonymousGateway {}

    @WebSocketGateway({ path: '/throwing', authenticator: ThrowingAuthenticator })
    class ThrowingGateway {}

    @Module({
      imports: [WebSocketModule.forRoot({})],
      providers: [AnonymousGateway, ThrowingGateway],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    try {
      const opened = serve(app);
      const anonymous = await app.fetch(new Request('http://localhost/anonymous'));
      const throwing = await app.fetch(new Request('http://localhost/throwing'));

      expect(anonymous.status).toBe(403);
      expect(throwing.status).toBe(403);
      expect(opened).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('reports an authenticator its declaring module cannot construct instead of admitting', async () => {
    const MISSING = new InjectionToken<string>('test.ws.missing');

    @Injectable()
    class UnwiredAuthenticator implements UpgradeAuthenticator {
      constructor(@Inject(MISSING) readonly issuer: string) {}
      authenticate(): false {
        return false;
      }
    }

    @WebSocketGateway({ path: '/unwired', authenticator: UnwiredAuthenticator })
    class UnwiredGateway {}

    @Module({ imports: [WebSocketModule.forRoot({})], providers: [UnwiredGateway] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, { diagnostics: 'silent' });
    try {
      const opened = serve(app);
      const response = await app.fetch(new Request('http://localhost/unwired'));

      expect(response.status).toBe(500);
      expect(opened).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('constructs an authenticator that another module registers without exporting', async () => {
    const built: string[] = [];

    @Injectable()
    class ScopedAuthenticator implements UpgradeAuthenticator {
      constructor() {
        built.push('authenticator');
      }
      authenticate(): WebSocketUpgradeIdentity {
        return identity('scoped-user');
      }
    }

    @Module({ providers: [ScopedAuthenticator] })
    class SessionsModule {}

    @WebSocketGateway({ path: '/scoped', authenticator: ScopedAuthenticator })
    class ScopedGateway {}

    @Module({
      imports: [WebSocketModule.forRoot({}), SessionsModule],
      providers: [ScopedGateway],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    try {
      const opened = serve(app);
      const response = await app.fetch(new Request('http://localhost/scoped'));

      expect(response.status).toBe(200);
      expect(opened).toHaveLength(1);
      // The private provider and the gateway's own instance.
      expect(built).toEqual(['authenticator', 'authenticator']);
    } finally {
      await app.close();
    }
  });

  it('reads allowedOrigins from ENV once per application', async () => {
    let reads = 0;

    @WebSocketGateway({
      path: '/feed',
      authenticator: StaticAuthenticator,
      allowedOrigins: (env) => {
        reads++;
        const origin: unknown = Reflect.get(env, 'APP_ORIGIN');
        return typeof origin === 'string' ? [origin] : [];
      },
    })
    class FeedGateway {}

    @Module({ imports: [WebSocketModule.forRoot({})], providers: [FeedGateway] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, { env: { APP_ORIGIN: 'https://app.test' } });
    try {
      serve(app);
      const trusted = await app.fetch(
        new Request('https://api.test/feed', { headers: { origin: 'https://app.test' } }),
      );
      const again = await app.fetch(
        new Request('https://api.test/feed', { headers: { origin: 'https://app.test' } }),
      );
      const foreign = await app.fetch(
        new Request('https://api.test/feed', { headers: { origin: 'https://evil.test' } }),
      );

      expect([trusted.status, again.status, foreign.status]).toEqual([200, 200, 403]);
      expect(reads).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('types authenticators as DI classes instead of closures', () => {
    // @ts-expect-error the closure hook is gone; upgrades authenticate through a DI class
    WebSocketGateway({ path: '/closure', authenticateUpgrade: () => false });

    class NotAnAuthenticator {
      verify(): boolean {
        return true;
      }
    }
    // @ts-expect-error an authenticator implements authenticate(request, context)
    WebSocketGateway({ path: '/wrong', authenticator: NotAnAuthenticator });

    // @ts-expect-error an ENV-derived allowlist returns origins, never the '*' opt-out
    WebSocketGateway({ path: '/any', allowedOrigins: () => '*' });
  });
});
