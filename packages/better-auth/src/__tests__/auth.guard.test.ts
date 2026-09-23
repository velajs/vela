import { sessionFixture } from './fixtures';
import { RolesGuard, Roles } from '@velajs/authz/vela';
import {
  Controller,
  Get,
  Module,
  Req,
  ThrottlerModule,
  UseGuards,
  VelaFactory,
  getTrustedRequestIdentity,
} from '@velajs/vela';
import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@velajs/vela';
import {
  AuthGuard,
  BetterAuthModule,
  BetterAuthService,
  CurrentSession,
  CurrentUser,
  OptionalAuth,
  Public,
} from '../index';
import type { BetterAuthInstance } from '../better-auth.types';

const SESSION_OK = sessionFixture('u-1', 'admin');

function mockAuth(session: typeof SESSION_OK | null) {
  return {
    api: { getSession: vi.fn().mockResolvedValue(session) },
    handler: vi.fn().mockResolvedValue(new Response('ok')),
  } satisfies BetterAuthInstance;
}

describe('AuthGuard', () => {
  it('publishes validated session state and lets @CurrentUser observe guard-set state', async () => {
    const auth = mockAuth(SESSION_OK);

    @Controller('/me')
    @UseGuards(AuthGuard)
    class MeController {
      @Get()
      me(@CurrentUser() user: { id: string; email: string }) {
        return { id: user.id, email: user.email };
      }
    }

    @Module({
      imports: [BetterAuthModule.forRoot({ auth })],
      controllers: [MeController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/me');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'u-1', email: 'ada@example.com' });
  });

  it('publishes verified principal and organization state to Vela security components', async () => {
    const auth = mockAuth(SESSION_OK);

    @Controller('/trusted-identity')
    @UseGuards(AuthGuard)
    class IdentityController {
      @Get()
      identity(@Req() context: { req: { raw: Request } }) {
        return getTrustedRequestIdentity(context.req.raw);
      }
    }

    @Module({
      imports: [BetterAuthModule.forRoot({ auth, issuer: 'accounts.example' })],
      controllers: [IdentityController],
    })
    class AppModule {}

    const response = await (
      await VelaFactory.create(AppModule)
    )
      .getHonoApp()
      .request('/trusted-identity');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      principal: {
        issuer: 'accounts.example',
        subject: 'u-1',
        principalType: 'user',
      },
      tenantId: 'tenant-1',
      roles: ['admin'],
      expiresAtMs: SESSION_OK.session.expiresAt.getTime(),
    });
  });

  it('lets throttling partition verified Better Auth principals before IP fallback', async () => {
    const auth = {
      api: {
        getSession: vi.fn(async ({ headers }: { headers: Headers }) => {
          const id = headers.get('x-test-verified-user');
          if (!id) return null;
          return sessionFixture(id);
        }),
      },
      handler: vi.fn().mockResolvedValue(new Response('ok')),
    } satisfies BetterAuthInstance;

    @Controller('/identity-throttle')
    class IdentityThrottleController {
      @Get()
      ok() {
        return { ok: true };
      }
    }

    @Module({
      imports: [
        BetterAuthModule.forRoot({ auth, issuer: 'accounts.example' }),
        ThrottlerModule.forRoot({ limit: 1, ttl: 60_000 }),
      ],
      controllers: [IdentityThrottleController],
    })
    class AppModule {}

    const hono = (
      await VelaFactory.create(AppModule, { getClientIp: () => 'same-edge-ip' })
    ).getHonoApp();
    const requestAs = (id: string) =>
      hono.request('/identity-throttle', { headers: { 'x-test-verified-user': id } });

    expect((await requestAs('user-a')).status).toBe(200);
    expect((await requestAs('user-a')).status).toBe(429);
    expect((await requestAs('user-b')).status).toBe(200);
  });

  it('@CurrentSession returns the session populated by the guard', async () => {
    const auth = mockAuth(SESSION_OK);

    @Controller('/session')
    @UseGuards(AuthGuard)
    class SessionController {
      @Get()
      get(@CurrentSession() s: { id: string; token: string }) {
        return { sessionId: s.id, token: s.token };
      }
    }

    @Module({
      imports: [BetterAuthModule.forRoot({ auth })],
      controllers: [SessionController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/session');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionId: 'session-u-1', token: 'token-u-1' });
  });

  it('throws 401 when no session and policy is deny (default)', async () => {
    const auth = mockAuth(null);

    @Controller('/me')
    @UseGuards(AuthGuard)
    class MeController {
      @Get()
      me() {
        return {};
      }
    }

    @Module({
      imports: [BetterAuthModule.forRoot({ auth })],
      controllers: [MeController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/me');
    expect(res.status).toBe(401);
  });

  it('@Public() bypasses the guard even with isGlobal:true', async () => {
    const auth = mockAuth(null);

    @Controller('/health')
    class HealthController {
      @Get()
      @Public(true)
      ok(@CurrentUser() user: { id: string } | undefined) {
        return { ok: true, hasUser: Boolean(user) };
      }
    }

    @Module({
      imports: [BetterAuthModule.forRoot({ auth, isGlobal: true })],
      controllers: [HealthController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, hasUser: false });
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('@OptionalAuth() returns ordinary falsy user and session values for anonymous traffic', async () => {
    const auth = mockAuth(null);

    @Controller('/maybe')
    @UseGuards(AuthGuard)
    class MaybeController {
      @Get()
      @OptionalAuth(true)
      handle(
        @CurrentUser() user: { id: string } | undefined,
        @CurrentSession() session: { id: string } | undefined,
      ) {
        return { hasUser: Boolean(user), hasSession: Boolean(session) };
      }
    }

    @Module({
      imports: [BetterAuthModule.forRoot({ auth })],
      controllers: [MaybeController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/maybe');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasUser: false, hasSession: false });
  });

  it('does not bypass authentication merely because a route is under basePath', async () => {
    const auth = mockAuth(null);

    @Controller('/api/auth/private')
    class PrivateController {
      @Get()
      handle() {
        return { leaked: true };
      }
    }

    @Module({
      imports: [BetterAuthModule.forRoot({ auth, isGlobal: true, mountHandler: false })],
      controllers: [PrivateController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/api/auth/private');
    expect(res.status).toBe(401);
    expect(auth.api.getSession).toHaveBeenCalledOnce();
  });

  it('installed auth denies an unannotated application route by default', async () => {
    const auth = mockAuth(null);

    @Controller('/items')
    class ItemsController {
      @Get()
      list() {
        return { items: [] };
      }
    }

    @Module({
      imports: [BetterAuthModule.forRoot({ auth })],
      controllers: [ItemsController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/items');
    expect(res.status).toBe(401);
  });

  it('accepts only the trusted finite-lived WebSocket attachment without using HTTP accessors', async () => {
    const auth = mockAuth(null);
    const guard = new AuthGuard(new BetterAuthService(() => auth), {});
    const client = {
      id: 'socket-1',
      rooms: new Set<string>(),
      raw: undefined,
      send() {},
      sendRaw() {},
      join() {},
      leave() {},
      commit() {},
      close() {},
      data: {
        principal: { issuer: 'issuer', subject: 'u-1', principalType: 'user' },
        tenantId: 't-1',
        expiresAtMs: Date.now() + 30_000,
      },
    };
    const context = {
      getType: () => 'ws',
      getClass: () => class Gateway {},
      getHandler: () => 'message',
      getModuleId: () => 'GatewayModule',
      getContainer: () => undefined,
      getContext: () => {
        throw new Error('HTTP accessor called');
      },
      getRequest: () => {
        throw new Error('HTTP accessor called');
      },
      switchToHttp: () => {
        throw new Error('HTTP accessor called');
      },
      switchToWs: () => ({
        getClient: () => client,
        getData: () => undefined,
        getPattern: () => 'message',
      }),
    } satisfies ExecutionContext;

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(auth.api.getSession).not.toHaveBeenCalled();

    client.data.expiresAtMs = Date.now() - 1;
    await expect(guard.canActivate(context)).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('RolesGuard', () => {
  it('allows when user has a required role', async () => {
    const auth = mockAuth(SESSION_OK);

    @Controller('/admin')
    @UseGuards(AuthGuard, RolesGuard)
    class AdminController {
      @Get()
      @Roles(['admin'])
      ok() {
        return { ok: true };
      }
    }

    @Module({
      imports: [BetterAuthModule.forRoot({ auth })],
      controllers: [AdminController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/admin');
    expect(res.status).toBe(200);
  });

  it('rejects with 403 when user lacks required role', async () => {
    const auth = mockAuth({
      ...SESSION_OK,
      user: { ...SESSION_OK.user, role: 'user' },
    });

    @Controller('/admin')
    @UseGuards(AuthGuard, RolesGuard)
    class AdminController {
      @Get()
      @Roles(['admin'])
      ok() {
        return { ok: true };
      }
    }

    @Module({
      imports: [BetterAuthModule.forRoot({ auth })],
      controllers: [AdminController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/admin');
    expect(res.status).toBe(403);
  });

  it('passes through when no roles are required', async () => {
    const auth = mockAuth(SESSION_OK);

    @Controller('/anyone')
    @UseGuards(AuthGuard, RolesGuard)
    class AnyoneController {
      @Get()
      ok() {
        return { ok: true };
      }
    }

    @Module({
      imports: [BetterAuthModule.forRoot({ auth })],
      controllers: [AnyoneController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/anyone');
    expect(res.status).toBe(200);
  });
});
