import {
  Controller,
  Get,
  MetadataRegistry,
  Module,
  VelaFactory,
} from '@velajs/vela';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BETTER_AUTH,
  BETTER_AUTH_OPTIONS,
  BetterAuthModule,
} from '../index';
import type { BetterAuthInstance } from '../better-auth.types';

function makeMockAuth(session: { user: unknown; session: unknown } | null = null) {
  return {
    api: {
      getSession: vi.fn().mockResolvedValue(session),
    },
    handler: vi.fn().mockResolvedValue(new Response('better-auth-ok')),
  } as unknown as BetterAuthInstance;
}

describe('BetterAuthModule', () => {
  beforeEach(() => MetadataRegistry.clear());
  afterEach(() => MetadataRegistry.clear());

  it('forRoot returns a DynamicModule that resolves BETTER_AUTH and BETTER_AUTH_OPTIONS', async () => {
    const auth = makeMockAuth();

    @Module({ imports: [BetterAuthModule.forRoot({ auth })] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(app.get(BETTER_AUTH)).toBe(auth);
    expect(app.get(BETTER_AUTH_OPTIONS)).toMatchObject({
      basePath: '/api/auth',
      defaultPolicy: 'deny',
      isGlobal: false,
      mountHandler: true,
    });
  });

  it('forRootAsync resolves auth via factory + injected dependency', async () => {
    const auth = makeMockAuth();

    @Module({
      imports: [
        BetterAuthModule.forRootAsync({
          inject: [],
          useFactory: () => ({ auth, defaultPolicy: 'allow' }),
        }),
      ],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(app.get(BETTER_AUTH)).toBe(auth);
    expect(app.get(BETTER_AUTH_OPTIONS).defaultPolicy).toBe('allow');
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

  it('isGlobal:true registers AuthGuard via APP_GUARD', async () => {
    const auth = makeMockAuth(null);

    @Controller('/items')
    class ItemsController {
      @Get()
      list() {
        return { items: [] };
      }
    }

    @Module({
      imports: [BetterAuthModule.forRoot({ auth, isGlobal: true })],
      controllers: [ItemsController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/items');
    expect(res.status).toBe(401);
  });
});
