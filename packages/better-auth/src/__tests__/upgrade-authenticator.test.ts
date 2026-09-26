import { describe, expect, it } from 'vitest';
import { defineWebSocketHelper } from 'hono/ws';
import { APP_GUARD, Module, VelaFactory, defineProvider, type VelaApplication } from '@velajs/vela';
import {
  WebSocketGateway,
  WebSocketModule,
  type WebSocketUpgradeAuthenticationContext,
} from '@velajs/vela/websocket';
import { registerWebSocketGateways } from '@velajs/vela/websocket-node';
import {
  AuthGuard,
  BETTER_AUTH_UPGRADE_TENANT,
  BetterAuthModule,
  BetterAuthUpgradeAuthenticator,
  type BetterAuthInstance,
  type BetterAuthUpgradeSession,
} from '../index';
import { sessionFixture } from './fixtures';

const ISSUER = 'https://auth.example.test';

/** Sessions keyed by the test cookie; the `none` cookie carries no organization. */
function auth(): BetterAuthInstance {
  return {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const cookie = headers.get('cookie') ?? '';
        if (cookie === 'session=member') return sessionFixture('member');
        if (cookie === 'session=none') {
          const fixture = sessionFixture('loner');
          const { activeOrganizationId: _, ...session } = fixture.session;
          return { user: fixture.user, session };
        }
        return null;
      },
    },
    handler: async () => new Response(null, { status: 404 }),
  };
}

/** Serve the app's gateways; an admitted upgrade answers 200, a refused one 403. */
function serve(app: VelaApplication): { status(cookie: string, path?: string): Promise<number> } {
  const upgrade = defineWebSocketHelper(() => new Response(null, { status: 200 }));
  registerWebSocketGateways(app, upgrade);
  return {
    status: async (cookie, path = '/boards/alpha/ws') =>
      (await app.fetch(new Request(`http://localhost${path}`, { headers: { cookie } }))).status,
  };
}

async function authenticate(
  app: VelaApplication,
  cookie: string,
  context: WebSocketUpgradeAuthenticationContext = {
    gatewayPath: '/boards/:board/ws',
    room: 'alpha',
  },
) {
  const authenticator = await app.getContainer().construct(BetterAuthUpgradeAuthenticator);
  return authenticator.authenticate(
    new Request('http://localhost/boards/alpha/ws', { headers: { cookie } }),
    context,
  );
}

describe('BetterAuthUpgradeAuthenticator', () => {
  it("admits a session with the module's issuer and the active organization as tenant", async () => {
    @Module({
      providers: [{ provide: APP_GUARD, useExisting: AuthGuard }],
      imports: [BetterAuthModule.forRoot({ auth: auth(), issuer: ISSUER, mountHandler: false })],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    try {
      expect(await authenticate(app, 'session=member')).toEqual({
        principal: { issuer: ISSUER, subject: 'member', principalType: 'user' },
        tenantId: 'tenant-1',
        expiresAtMs: sessionFixture('member').session.expiresAt.getTime(),
      });
      expect(await authenticate(app, 'session=missing')).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('fails closed when a session has no tenant and no resolver supplies one', async () => {
    @Module({
      providers: [{ provide: APP_GUARD, useExisting: AuthGuard }],
      imports: [BetterAuthModule.forRoot({ auth: auth(), issuer: ISSUER, mountHandler: false })],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    try {
      expect(await authenticate(app, 'session=none')).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("guards a gateway, reading the tenant resolver from the gateway's module", async () => {
    const seen: BetterAuthUpgradeSession[] = [];

    @WebSocketGateway({
      path: '/boards/:board/ws',
      roomParam: 'board',
      authenticator: BetterAuthUpgradeAuthenticator,
    })
    class BoardGateway {}

    @Module({
      imports: [BetterAuthModule.forRoot({ auth: auth(), issuer: ISSUER, mountHandler: false })],
      providers: [
        { provide: APP_GUARD, useExisting: AuthGuard },
        // Every session joins the alpha board's tenant; any other board
        // resolves no tenant, so the upgrade is refused.
        defineProvider(BETTER_AUTH_UPGRADE_TENANT, {
          useValue: (session: BetterAuthUpgradeSession, context) => {
            seen.push(session);
            return context.room === 'alpha' ? `board:${context.room}` : undefined;
          },
        }),
        BoardGateway,
      ],
    })
    class BoardsModule {}

    @Module({ imports: [WebSocketModule.forRoot({}), BoardsModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    try {
      const gateway = serve(app);

      expect(await gateway.status('session=none')).toBe(200);
      expect(await gateway.status('session=member', '/boards/beta/ws')).toBe(403);
      expect(await gateway.status('session=missing')).toBe(403);
      expect(seen.map(({ user }) => user.id)).toEqual(['loner', 'member']);
    } finally {
      await app.close();
    }
  });
});
