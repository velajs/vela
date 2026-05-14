import {
  Controller,
  Get,
  Inject,
  MetadataRegistry,
  UseGuards,
} from '@velajs/vela';
import { Test } from '@velajs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthGuard,
  BETTER_AUTH,
  BetterAuthModule,
  CurrentUser,
} from '../index';
import type { BetterAuthInstance } from '../better-auth.types';

function makeAuth(label: string) {
  return {
    api: { getSession: vi.fn().mockResolvedValue(null) },
    handler: vi.fn().mockResolvedValue(new Response(label)),
    __label__: label,
  } as unknown as BetterAuthInstance & { __label__: string };
}

// These tests pin the documented unit-testing surface: `@velajs/testing`'s
// `Test.createTestingModule(...).overrideProvider(BETTER_AUTH).use*(...)`.
// Verified against @velajs/testing >= 0.2.1, which fixed (a) bootstrap parity
// for REQUEST_CONTEXT and (b) module-internal override visibility — so the
// override now reaches both `moduleRef.get(...)` and controllers that
// `@Inject(BETTER_AUTH)` directly.
describe('Test.createTestingModule — BETTER_AUTH override', () => {
  beforeEach(() => MetadataRegistry.clear());
  afterEach(() => MetadataRegistry.clear());

  it('overrideProvider(BETTER_AUTH).useValue(mock) — resolved via moduleRef.get', async () => {
    const real = makeAuth('real');
    const mock = makeAuth('mock');

    const moduleRef = await Test.createTestingModule({
      imports: [BetterAuthModule.forRoot({ auth: real })],
    })
      .overrideProvider(BETTER_AUTH)
      .useValue(mock)
      .compile();

    const resolved = moduleRef.get(BETTER_AUTH) as BetterAuthInstance & {
      __label__: string;
    };
    expect(resolved.__label__).toBe('mock');
    expect(resolved).toBe(mock);
    expect(resolved).not.toBe(real);
  });

  it('overrideProvider(BETTER_AUTH).useFactory({ factory, inject }) resolves with deps', async () => {
    const mock = makeAuth('factory-mock');
    const FACTORY_TAG = Symbol.for('test.factoryTag');

    const moduleRef = await Test.createTestingModule({
      imports: [BetterAuthModule.forRoot({ auth: makeAuth('real') })],
      providers: [{ provide: FACTORY_TAG, useValue: mock }],
    })
      .overrideProvider(BETTER_AUTH)
      .useFactory({
        factory: (tagged: unknown) => tagged,
        inject: [FACTORY_TAG],
      })
      .compile();

    expect(moduleRef.get(BETTER_AUTH)).toBe(mock);
  });

  it('controllers that @Inject(BETTER_AUTH) receive the override', async () => {
    const real = makeAuth('real');
    const mock = makeAuth('mock');

    @Controller('/probe')
    class ProbeController {
      constructor(
        @Inject(BETTER_AUTH) private readonly auth: BetterAuthInstance & {
          __label__: string;
        },
      ) {}

      @Get()
      identity() {
        return { label: this.auth.__label__ };
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [BetterAuthModule.forRoot({ auth: real })],
      controllers: [ProbeController],
    })
      .overrideProvider(BETTER_AUTH)
      .useValue(mock)
      .compile();

    const app = await moduleRef.createApplication();
    const res = await app.getHonoApp().request('/probe');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ label: 'mock' });
  });

  it('AuthGuard reaches the mocked auth.api.getSession via the override', async () => {
    const real = makeAuth('real');
    const mock = makeAuth('mock-with-session');
    // Make the mock return a session — the real one returns null.
    mock.api.getSession = vi.fn().mockResolvedValue({
      user: { id: 'mock-user', email: 'mock@example.com', name: 'Mock' },
      session: { id: 'mock-sess', userId: 'mock-user' },
    });

    @Controller('/me')
    @UseGuards(AuthGuard)
    class MeController {
      @Get()
      me(@CurrentUser() user: { id: string }) {
        return { id: user.id };
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [BetterAuthModule.forRoot({ auth: real })],
      controllers: [MeController],
    })
      .overrideProvider(BETTER_AUTH)
      .useValue(mock)
      .compile();

    const app = await moduleRef.createApplication();
    const res = await app.getHonoApp().request('/me');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'mock-user' });
    expect(mock.api.getSession).toHaveBeenCalledTimes(1);
    expect(real.api.getSession).not.toHaveBeenCalled();
  });
});
