import { sessionFixture } from './fixtures';
import { Controller, Get, Inject, MetadataRegistry, UseGuards } from '@velajs/vela';
import { Test } from '@velajs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthGuard, BetterAuthModule, BetterAuthService, CurrentUser, Public } from '../index';
import type { BetterAuthInstance } from '../better-auth.types';

function makeAuth(label: string) {
  return {
    api: { getSession: vi.fn().mockResolvedValue(null) },
    handler: vi.fn().mockResolvedValue(new Response(label)),
    __label__: label,
  } satisfies BetterAuthInstance & { __label__: string };
}

// Verifies the canonical NestJS-style override path:
// `Test.createTestingModule(...).overrideProvider(BetterAuthService).useValue(stub)`.
// AuthGuard and the catch-all controller both inject BetterAuthService, so a
// single override at that token swaps the auth surface for every consumer.
describe('Test.createTestingModule — BetterAuthService override', () => {
  beforeEach(() => MetadataRegistry.clear());
  afterEach(() => MetadataRegistry.clear());

  it('overrideProvider(BetterAuthService).useValue(stub) — resolved via moduleRef.get', async () => {
    const real = makeAuth('real');
    const stub = new BetterAuthService(() => makeAuth('stub'));

    const moduleRef = await Test.createTestingModule({
      imports: [BetterAuthModule.forRoot({ auth: real })],
    })
      .overrideProvider(BetterAuthService)
      .useValue(stub)
      .compile();

    const resolved = moduleRef.get(BetterAuthService);
    expect(resolved).toBe(stub);
    expect(resolved.auth).toMatchObject({ __label__: 'stub' });
  });

  it('AuthGuard sees the overridden service end-to-end through the request pipeline', async () => {
    const real = makeAuth('real');
    const mock = makeAuth('mock-with-session');
    mock.api.getSession = vi.fn().mockResolvedValue(sessionFixture('mock-user'));

    @Controller('/me')
    @UseGuards(AuthGuard)
    class MeController {
      @Get()
      me(@CurrentUser() user: { id: string }) {
        return { id: user.id };
      }
    }

    const moduleRef = await Test.createTestingModule({
      // This test installs AuthGuard explicitly on the controller. Disable the
      // module-level global registration so a single request has one guard
      // invocation, matching the behavior under test.
      imports: [BetterAuthModule.forRoot({ auth: real, isGlobal: false })],
      controllers: [MeController],
    })
      .overrideProvider(BetterAuthService)
      .useValue(new BetterAuthService(() => mock))
      .compile();

    const app = await moduleRef.createApplication();
    const res = await app.getHonoApp().request('/me');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'mock-user' });
    expect(mock.api.getSession).toHaveBeenCalledTimes(1);
    expect(real.api.getSession).not.toHaveBeenCalled();
  });

  it('fails closed when an overridden service returns a mismatched session identity', async () => {
    const real = makeAuth('real');
    const mock = makeAuth('malformed-session');
    mock.api.getSession = vi.fn().mockResolvedValue({
      user: { id: 'user-a', email: 'a@example.com' },
      session: { id: 'session-a', userId: 'user-b' },
    });

    @Controller('/private')
    @UseGuards(AuthGuard)
    class PrivateController {
      @Get()
      handle() {
        return { leaked: true };
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [BetterAuthModule.forRoot({ auth: real })],
      controllers: [PrivateController],
    })
      .overrideProvider(BetterAuthService)
      .useValue(new BetterAuthService(() => mock))
      .compile();

    const app = await moduleRef.createApplication();
    const res = await app.getHonoApp().request('/private');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: 'unauthorized', message: 'Authentication required' },
    });
  });

  it('controllers that @Inject(BetterAuthService) receive the override', async () => {
    const real = makeAuth('real');
    const mock = makeAuth('mock');

    @Controller('/probe')
    @Public(true)
    class ProbeController {
      constructor(
        @Inject(BetterAuthService) private readonly svc: BetterAuthService<
          ReturnType<typeof makeAuth>
        >,
      ) {}

      @Get()
      identity() {
        return { label: this.svc.auth.__label__ };
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [BetterAuthModule.forRoot({ auth: real })],
      controllers: [ProbeController],
    })
      .overrideProvider(BetterAuthService)
      .useValue(new BetterAuthService(() => mock))
      .compile();

    const app = await moduleRef.createApplication();
    const res = await app.getHonoApp().request('/probe');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ label: 'mock' });
  });
});
