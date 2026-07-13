import { Controller, Get, MetadataRegistry, Module, UseGuards, VelaFactory } from '@velajs/vela';
import { AuthzModule } from '@velajs/authz/vela';
import { defineRole } from '@velajs/authz';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthGuard,
  BetterAuthModule,
  OptionalAuth,
  PermissionGuard,
  RequirePermission,
} from '../index';
import type { BetterAuthInstance } from '../better-auth.types';

interface SessionUser {
  id: string;
  email: string;
  role: string;
}

interface SessionShape {
  user: SessionUser;
  session: { id: string; userId: string; token: string };
}

function sessionWithRole(role: string): SessionShape {
  return {
    user: { id: 'u-1', email: 'ada@example.com', role },
    session: { id: 's-1', userId: 'u-1', token: 't-1' },
  };
}

function mockAuth(session: SessionShape | null): BetterAuthInstance {
  return {
    api: { getSession: vi.fn().mockResolvedValue(session) },
    handler: vi.fn().mockResolvedValue(new Response('ok')),
  } as unknown as BetterAuthInstance;
}

describe('PermissionGuard (e2e)', () => {
  beforeEach(() => MetadataRegistry.clear());
  afterEach(() => MetadataRegistry.clear());

  it('allows (200) when the session user has a role granting the required permission', async () => {
    const auth = mockAuth(sessionWithRole('editor'));

    @Controller('/posts')
    @UseGuards(AuthGuard, PermissionGuard)
    class PostsController {
      @Get()
      @RequirePermission(['posts:write'])
      write() {
        return { ok: true };
      }
    }

    @Module({
      imports: [
        // Deliberately NON-global: no `isGlobal: true`. PermissionGuard resolves
        // AUTHZ at request time from the per-request container (via the exporter
        // index), so a plain `AuthzModule.forRoot()` is reachable without being
        // global. This is exactly what the request-time-resolve fix enables — a
        // present-but-non-global AuthzModule must NOT crash the app at boot.
        AuthzModule.forRoot({ roles: [defineRole('editor', ['posts:write'])] }),
        BetterAuthModule.forRoot({ auth }),
      ],
      controllers: [PostsController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/posts');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('denies (403) when the session user role lacks the required permission', async () => {
    const auth = mockAuth(sessionWithRole('viewer'));

    @Controller('/posts')
    @UseGuards(AuthGuard, PermissionGuard)
    class PostsController {
      @Get()
      @RequirePermission(['posts:write'])
      write() {
        return { ok: true };
      }
    }

    @Module({
      imports: [
        // Deliberately NON-global: no `isGlobal: true`. PermissionGuard resolves
        // AUTHZ at request time from the per-request container (via the exporter
        // index), so a plain `AuthzModule.forRoot()` is reachable without being
        // global. This is exactly what the request-time-resolve fix enables — a
        // present-but-non-global AuthzModule must NOT crash the app at boot.
        AuthzModule.forRoot({ roles: [defineRole('editor', ['posts:write'])] }),
        BetterAuthModule.forRoot({ auth }),
      ],
      controllers: [PostsController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/posts');
    expect(res.status).toBe(403);
  });

  it('denies (403) when there is no session (fail-closed: no authenticated user)', async () => {
    const auth = mockAuth(null);

    // @OptionalAuth lets AuthGuard pass anonymous traffic through so the
    // PermissionGuard — not the AuthGuard — is the one that denies.
    @Controller('/posts')
    @UseGuards(AuthGuard, PermissionGuard)
    class PostsController {
      @Get()
      @OptionalAuth(true)
      @RequirePermission(['posts:write'])
      write() {
        return { ok: true };
      }
    }

    @Module({
      imports: [
        // Deliberately NON-global: no `isGlobal: true`. PermissionGuard resolves
        // AUTHZ at request time from the per-request container (via the exporter
        // index), so a plain `AuthzModule.forRoot()` is reachable without being
        // global. This is exactly what the request-time-resolve fix enables — a
        // present-but-non-global AuthzModule must NOT crash the app at boot.
        AuthzModule.forRoot({ roles: [defineRole('editor', ['posts:write'])] }),
        BetterAuthModule.forRoot({ auth }),
      ],
      controllers: [PostsController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/posts');
    expect(res.status).toBe(403);
  });

  it('denies (403) under require-ALL when only some required permissions are granted', async () => {
    const auth = mockAuth(sessionWithRole('editor'));

    @Controller('/posts')
    @UseGuards(AuthGuard, PermissionGuard)
    class PostsController {
      @Get()
      // editor grants posts:write but NOT posts:delete → require-ALL denies.
      @RequirePermission(['posts:write', 'posts:delete'])
      write() {
        return { ok: true };
      }
    }

    @Module({
      imports: [
        // Non-global registration (no isGlobal) — see note in the first test.
        AuthzModule.forRoot({ roles: [defineRole('editor', ['posts:write'])] }),
        BetterAuthModule.forRoot({ auth }),
      ],
      controllers: [PostsController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/posts');
    expect(res.status).toBe(403);
  });

  it('allows (200) under require-ALL when every required permission is granted', async () => {
    const auth = mockAuth(sessionWithRole('editor'));

    @Controller('/posts')
    @UseGuards(AuthGuard, PermissionGuard)
    class PostsController {
      @Get()
      @RequirePermission(['posts:write', 'posts:delete'])
      write() {
        return { ok: true };
      }
    }

    @Module({
      imports: [
        // Non-global registration (no isGlobal) — see note in the first test.
        AuthzModule.forRoot({
          roles: [defineRole('editor', ['posts:write', 'posts:delete'])],
        }),
        BetterAuthModule.forRoot({ auth }),
      ],
      controllers: [PostsController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/posts');
    expect(res.status).toBe(200);
  });

  it('allows (200) when the route requires no permissions', async () => {
    const auth = mockAuth(sessionWithRole('viewer'));

    @Controller('/open')
    @UseGuards(AuthGuard, PermissionGuard)
    class OpenController {
      @Get()
      open() {
        return { ok: true };
      }
    }

    @Module({
      imports: [
        // Deliberately NON-global: no `isGlobal: true`. PermissionGuard resolves
        // AUTHZ at request time from the per-request container (via the exporter
        // index), so a plain `AuthzModule.forRoot()` is reachable without being
        // global. This is exactly what the request-time-resolve fix enables — a
        // present-but-non-global AuthzModule must NOT crash the app at boot.
        AuthzModule.forRoot({ roles: [defineRole('editor', ['posts:write'])] }),
        BetterAuthModule.forRoot({ auth }),
      ],
      controllers: [OpenController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/open');
    expect(res.status).toBe(200);
  });

  it('denies (403) fail-closed when AuthzModule was never registered (AUTHZ missing)', async () => {
    const auth = mockAuth(sessionWithRole('editor'));

    @Controller('/posts')
    @UseGuards(AuthGuard, PermissionGuard)
    class PostsController {
      @Get()
      @RequirePermission(['posts:write'])
      write() {
        return { ok: true };
      }
    }

    // No AuthzModule import — AUTHZ resolves to undefined via @Optional().
    @Module({
      imports: [BetterAuthModule.forRoot({ auth })],
      controllers: [PostsController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/posts');
    expect(res.status).toBe(403);
  });
});
