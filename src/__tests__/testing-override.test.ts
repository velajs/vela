import { MetadataRegistry } from '@velajs/vela';
import { Test } from '@velajs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BETTER_AUTH, BetterAuthModule } from '../index';
import type { BetterAuthInstance } from '../better-auth.types';

function makeAuth(label: string) {
  return {
    api: { getSession: vi.fn().mockResolvedValue(null) },
    handler: vi.fn().mockResolvedValue(new Response(label)),
    __label__: label,
  } as unknown as BetterAuthInstance & { __label__: string };
}

// These tests pin the documented unit-testing surface: `@velajs/testing`'s
// `Test.createTestingModule(...).overrideProvider(BETTER_AUTH).use*(...)` and
// the corresponding `moduleRef.get(BETTER_AUTH)` lookup. They prove the
// override is reachable at the DI boundary — which is what consumers reach
// for when unit-testing services that `@Inject(BETTER_AUTH)`.
//
// Note (current @velajs/testing limitation): `Test.createTestingModule(...)`
// does not run the full `bootstrap()` (no REQUEST_CONTEXT registration), so
// integration-style tests that exercise the request pipeline + AuthGuard
// should use `VelaFactory.create(AppModule)` directly — see
// auth.guard.test.ts. The override surface tested here remains useful for
// any DI consumer that resolves BETTER_AUTH outside the request pipeline.
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
});
