import { Controller, Get, MetadataRegistry, Module, UseGuards, VelaFactory } from '@velajs/vela';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  session: { id: 's-1', userId: 'u-1', token: 't-1' },
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
      ok() {
        return { ok: true };
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
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('@OptionalAuth() permits anonymous traffic without throwing', async () => {
    const auth = mockAuth(null);

    @Controller('/maybe')
    @UseGuards(AuthGuard)
    class MaybeController {
      @Get()
      @OptionalAuth(true)
      handle(@CurrentUser() user: { id: string } | undefined) {
        // Lazy proxy is always object-truthy; probe a property to materialize.
        return { hasUser: user?.id != null };
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
    expect(await res.json()).toEqual({ hasUser: false });
  });

  it('defaultPolicy:allow lets unauthenticated requests through globally', async () => {
    const auth = mockAuth(null);

    @Controller('/items')
    @UseGuards(AuthGuard)
    class ItemsController {
      @Get()
      list() {
        return { items: [] };
      }
    }

    @Module({
      imports: [BetterAuthModule.forRoot({ auth, defaultPolicy: 'allow' })],
      controllers: [ItemsController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/items');
    expect(res.status).toBe(200);
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
