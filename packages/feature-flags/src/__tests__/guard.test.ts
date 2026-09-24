import { Controller, Get, Reflector, UseGuards } from '@velajs/vela';
import { Test } from '@velajs/testing';
import { describe, expect, it, vi } from 'vitest';
import { FEATURE_FLAG_METADATA } from '../decorators/feature-flag.decorator';
import { FeatureFlag, FeatureFlagGuard, FeatureFlagsModule, memoryFlagDriver } from '../index';
import type { FeatureFlagDriver } from '../drivers/driver';
import type { FlagManifest } from '../feature-flags.types';

/** Fresh decorated controller per test (metadata is re-applied on each build). */
function guardedController() {
  @Controller('/checkout')
  @UseGuards(FeatureFlagGuard)
  class CheckoutController {
    @Get('/plain')
    plain() {
      return { ok: true };
    }

    @FeatureFlag('new-checkout')
    @Get('/v2')
    v2() {
      return { checkout: 'v2' };
    }

    @FeatureFlag('beta', { onDisabled: 'forbidden' })
    @Get('/beta')
    beta() {
      return { beta: true };
    }
  }
  return CheckoutController;
}

async function appWith(
  controller: ReturnType<typeof guardedController>,
  driver: FeatureFlagDriver,
  moduleOpts: { guard?: 'global' | 'none'; manifest?: FlagManifest } = {},
) {
  // Per-route gating through the controller's @UseGuards, without the app-wide guard.
  const moduleRef = await Test.createTestingModule({
    controllers: [controller],
    imports: [FeatureFlagsModule.forRoot({ drivers: [driver], guard: 'none', ...moduleOpts })],
  }).compile();
  const app = await moduleRef.createApplication();
  return app.getHonoApp();
}

describe('FeatureFlagGuard (integration)', () => {
  it('reads route metadata through the application Reflector', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [guardedController()],
      imports: [
        FeatureFlagsModule.forRoot({
          drivers: [memoryFlagDriver({ values: { 'new-checkout': true } })],
        }),
      ],
    }).compile();
    const app = await moduleRef.createApplication();
    const reads = vi.spyOn(app.get(Reflector), 'getAllAndOverride');
    expect((await app.getHonoApp().request('/checkout/v2')).status).toBe(200);
    expect(reads).toHaveBeenCalledWith(FEATURE_FLAG_METADATA, expect.anything());
    await app.close();
  });

  it('hides a route behind a disabled flag (404)', async () => {
    const driver = memoryFlagDriver({ values: { 'new-checkout': false } });
    const app = await appWith(guardedController(), driver);
    const res = await app.request('/checkout/v2');
    expect(res.status).toBe(404);
  });

  it('serves the route when the flag is enabled (200)', async () => {
    const driver = memoryFlagDriver({ values: { 'new-checkout': true } });
    const app = await appWith(guardedController(), driver);
    const res = await app.request('/checkout/v2');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ checkout: 'v2' });
  });

  it('lets un-gated routes through untouched', async () => {
    const driver = memoryFlagDriver({ values: { 'new-checkout': false } });
    const app = await appWith(guardedController(), driver);
    const res = await app.request('/checkout/plain');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns 403 when the decorator opts into forbidden-on-disabled', async () => {
    const driver = memoryFlagDriver({ values: { beta: false } });
    const app = await appWith(guardedController(), driver);
    const res = await app.request('/checkout/beta');
    expect(res.status).toBe(403);
  });

  it('re-evaluates per request (a flag flip is picked up without rebuilding the app)', async () => {
    const driver = memoryFlagDriver({ values: { 'new-checkout': false } });
    const app = await appWith(guardedController(), driver);

    expect((await app.request('/checkout/v2')).status).toBe(404);
    driver.set('new-checkout', true);
    expect((await app.request('/checkout/v2')).status).toBe(200);
  });

  it('fails closed when evaluation errors even if the manifest fallback is true', async () => {
    const broken: FeatureFlagDriver = {
      name: 'broken',
      getBoolean: () => Promise.reject(new Error('down')),
      getString: (_key, fallback) => Promise.resolve(fallback),
      getNumber: (_key, fallback) => Promise.resolve(fallback),
      getObject: (_key, fallback) => Promise.resolve(fallback),
    };
    const app = await appWith(guardedController(), broken, {
      manifest: { 'new-checkout': true },
    });
    expect((await app.request('/checkout/v2')).status).toBe(404);
  });

  it('denies a non-boolean driver verdict end-to-end even when the manifest fallback is true', async () => {
    const malformed: FeatureFlagDriver = {
      name: 'malformed',
      getBoolean: () => Promise.resolve('yes' as unknown as boolean),
      getString: (_key, fallback) => Promise.resolve(fallback),
      getNumber: (_key, fallback) => Promise.resolve(fallback),
      getObject: (_key, fallback) => Promise.resolve(fallback),
    };
    const app = await appWith(guardedController(), malformed, {
      manifest: { 'new-checkout': true },
    });

    expect((await app.request('/checkout/v2')).status).toBe(404);
  });

  it('gates app-wide by default (no @UseGuards, no guard option)', async () => {
    @Controller('/promo')
    class PromoController {
      @FeatureFlag('promo')
      @Get('/show')
      show() {
        return { promo: true };
      }
    }
    const driver = memoryFlagDriver({ values: { promo: false } });
    for (const imports of [
      [FeatureFlagsModule.forRoot({ drivers: [driver] })],
      [FeatureFlagsModule.forRoot({ drivers: [driver], guard: 'global' })],
      [FeatureFlagsModule.forRoot({ drivers: [driver], isGlobal: true })],
      [FeatureFlagsModule.forRootAsync({ useFactory: () => ({ drivers: [driver] }) })],
      [
        FeatureFlagsModule.forRootAsync({
          guard: 'global',
          useFactory: () => ({ drivers: [driver] }),
        }),
      ],
    ]) {
      driver.set('promo', false);
      const moduleRef = await Test.createTestingModule({
        controllers: [PromoController],
        imports,
      }).compile();
      const app = await moduleRef.createApplication();
      const hono = app.getHonoApp();

      expect((await hono.request('/promo/show')).status).toBe(404);
      driver.set('promo', true);
      expect((await hono.request('/promo/show')).status).toBe(200);
      await app.close();
    }
  });

  it("leaves gating to @UseGuards with guard: 'none'", async () => {
    @Controller('/promo')
    class UngatedController {
      @FeatureFlag('promo')
      @Get('/show')
      show() {
        return { promo: true };
      }
    }
    const driver = memoryFlagDriver({ values: { promo: false } });
    const moduleRef = await Test.createTestingModule({
      controllers: [UngatedController],
      imports: [FeatureFlagsModule.forRoot({ drivers: [driver], guard: 'none' })],
    }).compile();
    const app = await moduleRef.createApplication();
    expect((await app.getHonoApp().request('/promo/show')).status).toBe(200);
    await app.close();
    // Beside a forRootAsync factory too.
    const asyncRef = await Test.createTestingModule({
      controllers: [UngatedController],
      imports: [
        FeatureFlagsModule.forRootAsync({ guard: 'none', useFactory: () => ({ drivers: [driver] }) }),
      ],
    }).compile();
    const asyncApp = await asyncRef.createApplication();
    expect((await asyncApp.getHonoApp().request('/promo/show')).status).toBe(200);
    await asyncApp.close();
  });

  it("rejects a guard option other than 'global' or 'none'", () => {
    const driver = memoryFlagDriver({ values: {} });
    // As an untyped caller would pass the previous boolean option.
    for (const guard of [true, false, 'app']) {
      expect(() =>
        Reflect.apply(FeatureFlagsModule.forRoot, FeatureFlagsModule, [{ drivers: [driver], guard }]),
      ).toThrow("FeatureFlagsModule guard must be 'global' or 'none'");
    }
  });
});
