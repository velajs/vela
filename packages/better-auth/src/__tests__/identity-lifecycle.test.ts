import {
  Controller,
  Get,
  MetadataRegistry,
  Module,
  Reflector,
  UseGuards,
  VelaFactory,
  clearTrustedRequestIdentity,
  getTrustedRequestIdentity,
  setTrustedRequestIdentity,
  bindTrustedRequestContext,
  buildEntrypointExecutionContext,
  type CanActivate,
  type ExecutionContext,
} from '@velajs/vela';
import { AuthzModule, PermissionGuard, RequirePermission } from '@velajs/authz/vela';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthGuard,
  BetterAuthModule,
  BetterAuthService,
  CurrentUser,
  OptionalAuth,
  Public,
} from '../index';
import { authenticateRequest, getAuthRequestState } from '../auth-request-state';
import { validateSessionData } from '../session-data';
import { sessionFixture } from './fixtures';

beforeEach(() => MetadataRegistry.clear());
afterEach(() => {
  MetadataRegistry.clear();
  vi.useRealTimers();
});

describe('validated Better Auth boundary', () => {
  it('validates the full base models and preserves opaque plugin fields', () => {
    const fixture = sessionFixture();
    const data = validateSessionData(fixture);
    expect(data?.user).toMatchObject(fixture.user);
    expect(data?.session).toMatchObject(fixture.session);
    expect(data?.roles).toEqual(['editor']);
    expect(data?.tenantId).toBe('tenant-1');
    expect(
      validateSessionData({ user: { id: 'u-1' }, session: { id: 's-1', userId: 'u-1' } }),
    ).toBeUndefined();
  });

  it.each(['expiresAt', 'createdAt', 'updatedAt'])(
    'rejects missing or invalid session %s',
    (key) => {
      const fixture = sessionFixture();
      expect(
        validateSessionData({ ...fixture, session: { ...fixture.session, [key]: '2099-01-01' } }),
      ).toBeUndefined();
    },
  );

  it('rejects expired, mismatched and malformed authority fields without getters', () => {
    const fixture = sessionFixture();
    expect(
      validateSessionData({ ...fixture, session: { ...fixture.session, expiresAt: new Date(0) } }),
    ).toBeUndefined();
    expect(
      validateSessionData({ ...fixture, session: { ...fixture.session, userId: 'other' } }),
    ).toBeUndefined();
    expect(
      validateSessionData({ ...fixture, user: { ...fixture.user, role: [123] } }),
    ).toBeUndefined();
    const getter = vi.fn(() => fixture.user);
    expect(validateSessionData(Object.defineProperty({}, 'user', { get: getter }))).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('canonical identity lifecycle', () => {
  it('authorizes bound custom contexts without reauthentication and observes revocation', async () => {
    class Resolver {}
    const request = new Request('https://test.invalid/graphql');
    const context = {
      ...buildEntrypointExecutionContext('graphql', Resolver, 'read', {}),
      getRequest: () => request,
    };
    const getSession = vi.fn(async () => sessionFixture());
    const guard = new AuthGuard(
      new BetterAuthService(() => ({
        api: { getSession },
        handler: async () => new Response(),
      })),
      {},
      new Reflector(),
    );
    const data = validateSessionData(sessionFixture());
    if (!data) throw new Error('Expected valid fixture');
    authenticateRequest(context, data, 'accounts');
    await expect(guard.canActivate(context)).rejects.toThrow('Authentication required');
    bindTrustedRequestContext(context, request);
    await expect(
      Promise.all([guard.canActivate(context), guard.canActivate(context)]),
    ).resolves.toEqual([true, true]);
    expect(getSession).not.toHaveBeenCalled();
    expect(getAuthRequestState(context)?.user.id).toBe('u-1');
    clearTrustedRequestIdentity(request);
    await expect(guard.canActivate(context)).rejects.toThrow('Authentication required');
    expect(getAuthRequestState(context)).toBeUndefined();
  });

  it('invalidates provider payload after replacement and clearing', async () => {
    const checks: boolean[] = [];
    class ReplaceIdentity implements CanActivate {
      canActivate(context: ExecutionContext) {
        const request = context.getRequest();
        checks.push(getAuthRequestState(context)?.user.id === 'u-1');
        setTrustedRequestIdentity(request, {
          principal: { issuer: 'access', subject: 'other', principalType: 'service' },
          roles: ['editor'],
          expiresAtMs: Date.now() + 30_000,
        });
        checks.push(getAuthRequestState(context) === undefined);
        clearTrustedRequestIdentity(request);
        checks.push(getTrustedRequestIdentity(request) === undefined);
        return true;
      }
    }
    @Controller('/replace')
    @UseGuards(AuthGuard, ReplaceIdentity)
    class ControllerUnderTest {
      @Get()
      read(@CurrentUser() user: unknown) {
        return { hasUser: Boolean(user) };
      }
    }
    @Module({
      imports: [
        BetterAuthModule.forRoot({
          auth: {
            api: { getSession: async () => sessionFixture() },
            handler: async () => new Response(),
          },
          isGlobal: false,
        }),
      ],
      controllers: [ControllerUnderTest],
    })
    class App {}
    const app = await VelaFactory.create(App);
    expect(await (await app.getHonoApp().request('/replace')).json()).toEqual({ hasUser: false });
    expect(checks).toEqual([true, true, true]);
    await app.dispose();
  });

  it('public, logout, rejected and throwing reauthentication cannot inherit prior identity', async () => {
    const results: Array<ReturnType<typeof getTrustedRequestIdentity>> = [];
    const auth = {
      api: { getSession: vi.fn<() => Promise<unknown>>().mockResolvedValue(null) },
      handler: async () => new Response(),
    };
    class SeedIdentity implements CanActivate {
      canActivate(context: ExecutionContext) {
        setTrustedRequestIdentity(context.getRequest(), {
          principal: { issuer: 'old', subject: 'old', principalType: 'user' },
          roles: ['admin'],
        });
        return true;
      }
    }
    @Controller('/clear')
    @UseGuards(SeedIdentity, AuthGuard)
    class ControllerUnderTest {
      @Get('/public')
      @Public(true)
      publicRoute() {
        return { ok: true };
      }
      @Get('/optional')
      @OptionalAuth(true)
      optional() {
        return { ok: true };
      }
    }
    @Module({
      imports: [BetterAuthModule.forRoot({ auth, isGlobal: false })],
      controllers: [ControllerUnderTest],
    })
    class App {}
    const app = await VelaFactory.create(App);
    const hono = app.getHonoApp();
    // Observe the same raw request after the whole guard pipeline settles.
    for (const path of ['/clear/public', '/clear/optional', '/clear/optional', '/clear/optional']) {
      if (results.length === 2) auth.api.getSession.mockResolvedValueOnce({ user: { id: 'u-1' } });
      if (results.length === 3)
        auth.api.getSession.mockRejectedValueOnce(new Error('provider failed'));
      const request = new Request(`http://local.test${path}`);
      await hono.fetch(request);
      results.push(getTrustedRequestIdentity(request));
    }
    expect(results).toEqual([undefined, undefined, undefined, undefined]);
    await app.dispose();
  });

  it('denies if verified session expires during permission resolution', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01'));
    const fixture = sessionFixture();
    fixture.session.expiresAt = new Date(Date.now() + 1000);
    @Controller('/slow')
    @UseGuards(AuthGuard, PermissionGuard)
    class ControllerUnderTest {
      @Get()
      @RequirePermission(['posts:write'])
      read() {
        return { leaked: true };
      }
    }
    @Module({
      imports: [
        BetterAuthModule.forRoot({
          auth: { api: { getSession: async () => fixture }, handler: async () => new Response() },
          isGlobal: false,
        }),
        AuthzModule.forRoot({
          resolver: {
            grants() {
              vi.setSystemTime(Date.now() + 1000);
              return new Set(['posts:write']);
            },
          },
        }),
      ],
      controllers: [ControllerUnderTest],
    })
    class App {}
    const app = await VelaFactory.create(App);
    expect((await app.getHonoApp().request('/slow')).status).toBe(403);
    await app.dispose();
  });
});
