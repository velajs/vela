import { Controller, Get, MetadataRegistry, Module, VelaFactory } from '@velajs/vela';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  beforeEach(() => MetadataRegistry.clear());
  afterEach(() => MetadataRegistry.clear());

  it('forRoot exposes BetterAuthService with the provided auth instance', async () => {
    const auth = makeMockAuth();

    @Module({ imports: [BetterAuthModule.forRoot({ auth })] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const service = app.get(BetterAuthService);
    expect(service.auth).toBe(auth);
    expect(service.api).toBe(auth.api);
    expect(app.get(BETTER_AUTH_OPTIONS)).toMatchObject({
      basePath: '/api/auth',
      issuer: 'better-auth:/api/auth',
      isGlobal: true,
      mountHandler: true,
    });
  });

  it('keys otherwise identical registrations by auth instance identity', () => {
    const first = BetterAuthModule.forRoot({ auth: makeMockAuth() });
    const second = BetterAuthModule.forRoot({ auth: makeMockAuth() });
    expect(first.key).not.toBe(second.key);
  });

  it('keys same-source async closures by factory identity', () => {
    const makeFactory = () => () => makeMockAuth();
    const first = BetterAuthModule.forRootAsync({ inject: [], useFactory: makeFactory() });
    const second = BetterAuthModule.forRootAsync({ inject: [], useFactory: makeFactory() });
    expect(first.key).not.toBe(second.key);
  });

  it('boots roots rebuilt with the same explicit key in one process', async () => {
    // A root rebuilt per environment or per Durable Object creates new auth
    // registrations under the same key in the same isolate.
    const buildRoot = () => {
      const auth = makeMockAuth();
      const factory = () => auth;
      @Module({
        imports: [
          BetterAuthModule.forRoot({ auth, key: 'rebuilt-auth' }),
          BetterAuthModule.forRootAsync({
            inject: [],
            useFactory: factory,
            key: 'rebuilt-async-auth',
            basePath: '/internal-auth',
            isGlobal: false,
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

  it('keys explicit registrations by name, options and auth identity', () => {
    const auth = makeMockAuth();
    const key = 'named-auth';
    const registration = BetterAuthModule.forRoot({ auth, key });

    // The same registration imported twice in one application deduplicates.
    expect(BetterAuthModule.forRoot({ auth, key }).key).toBe(registration.key);
    // A different registration never collapses into an existing instance.
    expect(BetterAuthModule.forRoot({ auth: makeMockAuth(), key }).key).not.toBe(registration.key);
    expect(BetterAuthModule.forRoot({ auth, key, basePath: '/auth' }).key).not.toBe(
      registration.key,
    );
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

  it('forRootAsync defers the user factory until first auth access', async () => {
    const auth = makeMockAuth();
    let factoryCalls = 0;

    @Module({
      imports: [
        BetterAuthModule.forRootAsync({
          inject: [],
          useFactory: () => {
            factoryCalls++;
            return auth;
          },
        }),
      ],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    // Module load completes without invoking the user factory. The
    // builder closure exists but is uncalled — vela resolved the
    // BetterAuthService singleton, but the service's `.auth` getter only
    // runs the builder on first use.
    expect(factoryCalls).toBe(0);

    const service = app.get(BetterAuthService);
    // First access fires the factory and caches the result.
    expect(service.auth).toBe(auth);
    expect(factoryCalls).toBe(1);

    // Subsequent accesses are cached — no second factory call.
    expect(service.api).toBe(auth.api);
    expect(factoryCalls).toBe(1);

    expect(app.get(BETTER_AUTH_OPTIONS).isGlobal).toBe(true);
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
      imports: [
        BetterAuthModule.forRootAsync({ inject: [], useFactory: () => auth, basePath: '/auth' }),
      ],
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
