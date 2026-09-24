import { Controller, Get, Module, VelaFactory } from '@velajs/vela';
import { describe, expect, it, vi } from 'vitest';
import {
  BETTER_AUTH_OPTIONS,
  BetterAuthModule,
  BetterAuthService,
  createBetterAuthCatchallController,
} from '../index';
import type { BetterAuthInstance } from '../better-auth.types';

function makeMockAuth(session: { user: unknown; session: unknown } | null = null) {
  return {
    api: {
      getSession: vi.fn().mockResolvedValue(session),
    },
    handler: vi.fn().mockResolvedValue(new Response('better-auth-ok')),
  } satisfies BetterAuthInstance;
}

describe('BetterAuthModule', () => {
  it('forRoot exposes BetterAuthService with the provided auth instance', async () => {
    const auth = makeMockAuth();

    @Module({ imports: [BetterAuthModule.forRoot({ auth })] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const service = app.get(BetterAuthService);
    expect(service.auth).toBe(auth);
    expect(service.api).toBe(auth.api);
    expect(app.get(BETTER_AUTH_OPTIONS)).toEqual({
      basePath: '/api/auth',
      issuer: 'better-auth:/api/auth',
      globalGuard: true,
      mountHandler: true,
    });
  });

  it('builds an auth function on first use only', async () => {
    const auth = makeMockAuth();
    const build = vi.fn(() => auth);

    @Module({ imports: [BetterAuthModule.forRoot({ auth: build })] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(build).not.toHaveBeenCalled();
    expect(app.get(BetterAuthService).auth).toBe(auth);
    expect(app.get(BetterAuthService).api).toBe(auth.api);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('keys registrations by their structural options, not by the auth instance', () => {
    const first = BetterAuthModule.forRoot({ auth: makeMockAuth() });
    const second = BetterAuthModule.forRoot({ auth: makeMockAuth() });
    expect(first.key).toBe(second.key);
    expect(BetterAuthModule.forRoot({ auth: makeMockAuth(), basePath: '/auth' }).key).not.toBe(
      first.key,
    );
    const deferred = BetterAuthModule.forRootAsync({
      useFactory: () => ({ auth: makeMockAuth() }),
    });
    expect(deferred.key).toBe(first.key);
  });

  it('reports a second auth configuration under the same key instead of merging it', async () => {
    @Module({
      imports: [
        BetterAuthModule.forRoot({ auth: makeMockAuth() }),
        BetterAuthModule.forRoot({ auth: makeMockAuth() }),
      ],
    })
    class Conflicting {}
    await expect(VelaFactory.create(Conflicting, { diagnostics: 'throw' })).rejects.toThrow(
      /BetterAuthModule#\w+ was imported again with different options/,
    );

    // Same-source async closures are different configurations too.
    const makeFactory = () => () => ({ auth: makeMockAuth() });
    @Module({
      imports: [
        BetterAuthModule.forRootAsync({ useFactory: makeFactory() }),
        BetterAuthModule.forRootAsync({ useFactory: makeFactory() }),
      ],
    })
    class ConflictingAsync {}
    await expect(VelaFactory.create(ConflictingAsync, { diagnostics: 'throw' })).rejects.toThrow(
      /was imported again with different options/,
    );

    // One registration imported again deduplicates.
    const shared = BetterAuthModule.forRoot({ auth: makeMockAuth(), key: 'named-auth' });
    @Module({ imports: [shared, shared] })
    class Shared {}
    const app = await VelaFactory.create(Shared, { diagnostics: 'throw' });
    await app.close();
  });

  it('boots roots rebuilt with the same explicit key in one process', async () => {
    // A root rebuilt per environment or per Durable Object creates new auth
    // registrations under the same key in the same isolate.
    const buildRoot = () => {
      const auth = makeMockAuth();
      const factory = () => ({ auth });
      @Module({
        imports: [
          BetterAuthModule.forRoot({ auth, key: 'rebuilt-auth' }),
          BetterAuthModule.forRootAsync({
            useFactory: factory,
            key: 'rebuilt-async-auth',
            basePath: '/internal-auth',
            globalGuard: false,
          }),
        ],
      })
      class AppModule {}
      return { AppModule, auth };
    };
    const first = buildRoot();
    const second = buildRoot();

    const [firstApp, secondApp] = await Promise.all([
      VelaFactory.create(first.AppModule),
      VelaFactory.create(second.AppModule),
    ]);

    expect(firstApp.get(BetterAuthService).auth).toBe(first.auth);
    expect(secondApp.get(BetterAuthService).auth).toBe(second.auth);
    await Promise.all([firstApp.close(), secondApp.close()]);
  });

  it.each(['', ' padded'])('rejects the explicit key %j', (key) => {
    expect(() => BetterAuthModule.forRoot({ auth: makeMockAuth(), key })).toThrow(
      /explicit module key must be a non-empty string/,
    );
  });

  it.each(['', '/', 'api/auth', '//api/auth', '/api/auth/', '/api/../auth', '/api/%2e%2e/auth'])(
    'rejects unsafe basePath %j',
    (basePath) => {
      expect(() => BetterAuthModule.forRoot({ auth: makeMockAuth(), basePath })).toThrow(
        /basePath/,
      );
    },
  );

  it('applies the same basePath validation to the exported controller factory', () => {
    expect(() => createBetterAuthCatchallController('/api/../private')).toThrow(/basePath/);
  });

  it('builds one catch-all controller class per base path', () => {
    expect(createBetterAuthCatchallController('/api/auth')).toBe(
      createBetterAuthCatchallController(),
    );
    expect(createBetterAuthCatchallController('/internal-auth')).not.toBe(
      createBetterAuthCatchallController(),
    );
  });

  it('mounts the catch-all once for an identical registration imported twice', async () => {
    const auth = makeMockAuth();
    @Module({ imports: [BetterAuthModule.forRoot({ auth }), BetterAuthModule.forRoot({ auth })] })
    class AppModule {}
    const app = await VelaFactory.create(AppModule, { diagnostics: 'throw' });
    const routes = app.describeRoutes().filter((route) => route.path.startsWith('/api/auth'));
    expect(routes).toHaveLength(1);
    await app.close();
  });

  it('forRootAsync defers the auth builder its factory returns until first auth access', async () => {
    const auth = makeMockAuth();
    let factoryCalls = 0;
    let authBuilds = 0;

    @Module({
      imports: [
        BetterAuthModule.forRootAsync({
          useFactory: () => {
            factoryCalls++;
            return {
              issuer: 'accounts',
              auth: () => {
                authBuilds++;
                return auth;
              },
            };
          },
        }),
      ],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    // The options factory runs while the application initializes; the auth
    // builder it returned does not.
    expect(factoryCalls).toBe(1);
    expect(authBuilds).toBe(0);

    const service = app.get(BetterAuthService);
    // First access builds and caches the instance.
    expect(service.auth).toBe(auth);
    expect(authBuilds).toBe(1);
    expect(service.api).toBe(auth.api);
    expect(authBuilds).toBe(1);

    expect(app.get(BETTER_AUTH_OPTIONS)).toMatchObject({ issuer: 'accounts', globalGuard: true });
  });

  it('isGlobal makes BetterAuthService visible to every module; it defaults to false', async () => {
    const auth = makeMockAuth();
    @Module({})
    class Feature {}
    const visibleFrom = async (isGlobal: boolean | undefined) => {
      @Module({ imports: [BetterAuthModule.forRoot({ auth, isGlobal }), Feature] })
      class AppModule {}
      const app = await VelaFactory.create(AppModule, { diagnostics: 'throw' });
      try {
        return app.getContainer().getResolvedScope(BetterAuthService, 'Feature#default');
      } finally {
        await app.close();
      }
    };
    await expect(visibleFrom(true)).resolves.toBeDefined();
    await expect(visibleFrom(undefined)).resolves.toBeUndefined();
  });

  it('mounts the catch-all controller at /api/auth/* by default', async () => {
    const auth = makeMockAuth();

    @Module({ imports: [BetterAuthModule.forRoot({ auth })] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/api/auth/sign-in', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('better-auth-ok');
    expect(auth.handler).toHaveBeenCalled();
  });

  it('mounts the catch-all controller at a custom basePath', async () => {
    const auth = makeMockAuth();

    @Module({ imports: [BetterAuthModule.forRoot({ auth, basePath: '/auth' })] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/auth/sign-in', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('better-auth-ok');
    expect(auth.handler).toHaveBeenCalled();

    // The default base path is no longer mounted.
    const old = await hono.request('/api/auth/sign-in', { method: 'POST' });
    expect(old.status).toBe(404);
  });

  it('forRootAsync mounts the catch-all controller at a custom basePath', async () => {
    const auth = makeMockAuth();

    @Module({
      imports: [BetterAuthModule.forRootAsync({ useFactory: () => ({ auth }), basePath: '/auth' })],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/auth/sign-in', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(auth.handler).toHaveBeenCalled();
  });

  it('mountHandler:false skips the catch-all controller', async () => {
    const auth = makeMockAuth();

    @Module({
      imports: [BetterAuthModule.forRoot({ auth, mountHandler: false })],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/api/auth/sign-in', { method: 'POST' });

    expect(res.status).toBe(404);
    expect(auth.handler).not.toHaveBeenCalled();
  });

  it('registers AuthGuard via APP_GUARD by default', async () => {
    const auth = makeMockAuth(null);

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
});
