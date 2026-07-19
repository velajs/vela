import {
  Controller,
  Get,
  MetadataRegistry,
  Module,
  Req,
  ThrottlerModule,
  UseGuards,
  VelaFactory,
  getTrustedRequestIdentity,
} from '@velajs/vela';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@velajs/vela';
import {
  AuthGuard,
  BetterAuthModule,
  CurrentSession,
  CurrentUser,
  OptionalAuth,
  Public,
  Roles,
  RolesGuard,
} from '../index';
import type { BetterAuthInstance } from '../better-auth.types';

const SESSION_OK = {
  user: { id: 'u-1', email: 'ada@example.com', role: 'admin' },
  session: {
    id: 's-1',
    userId: 'u-1',
    token: 't-1',
    activeOrganizationId: 'tenant-1',
  },
};

function mockAuth(session: typeof SESSION_OK | null) {
  return {
    api: { getSession: vi.fn().mockResolvedValue(session) },
    handler: vi.fn().mockResolvedValue(new Response('ok')),
  } as unknown as BetterAuthInstance;
}

describe('AuthGuard', () => {
  beforeEach(() => MetadataRegistry.clear());
  afterEach(() => MetadataRegistry.clear());

  it('populates REQUEST_CONTEXT and lets @CurrentUser observe guard-set state', async () => {
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
    });
  });

  it('lets throttling partition verified Better Auth principals before IP fallback', async () => {
    const auth = {
      api: {
        getSession: vi.fn(async ({ headers }: { headers: Headers }) => {
          const id = headers.get('x-test-verified-user');
          if (!id) return null;
          return {
            user: { id, email: `${id}@example.com` },
            session: {
              id: `session-${id}`,
              userId: id,
              token: `token-${id}`,
              activeOrganizationId: 'tenant-1',
            },
          };
        }),
      },
      handler: vi.fn().mockResolvedValue(new Response('ok')),
    } as unknown as BetterAuthInstance;

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
    expect(await res.json()).toEqual({ sessionId: 's-1', token: 't-1' });
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
    const guard = new AuthGuard(auth as never, {} as never);
    const client = {
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
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(auth.api.getSession).not.toHaveBeenCalled();

    client.data.expiresAtMs = Date.now() - 1;
    await expect(guard.canActivate(context)).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('RolesGuard', () => {
  beforeEach(() => MetadataRegistry.clear());
  afterEach(() => MetadataRegistry.clear());

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
