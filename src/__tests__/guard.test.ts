import { Controller, Get, MetadataRegistry, UseGuards } from '@velajs/vela';
import { Test } from '@velajs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  moduleOpts: { isGlobal?: boolean; manifest?: FlagManifest } = {},
) {
  const moduleRef = await Test.createTestingModule({
    controllers: [controller],
    imports: [FeatureFlagsModule.forRoot({ drivers: [driver], ...moduleOpts })],
  }).compile();
  const app = await moduleRef.createApplication();
  return app.getHonoApp();
}

describe('FeatureFlagGuard (integration)', () => {
  beforeEach(() => MetadataRegistry.clear());
  afterEach(() => MetadataRegistry.clear());

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

  it('gates app-wide via the isGlobal APP_GUARD (no @UseGuards on the controller)', async () => {
    @Controller('/promo')
    class PromoController {
      @FeatureFlag('promo')
      @Get('/show')
      show() {
        return { promo: true };
      }
    }
    const driver = memoryFlagDriver({ values: { promo: false } });
    const moduleRef = await Test.createTestingModule({
      controllers: [PromoController],
      imports: [FeatureFlagsModule.forRoot({ drivers: [driver], isGlobal: true })],
    }).compile();
    const app = (await moduleRef.createApplication()).getHonoApp();

    expect((await app.request('/promo/show')).status).toBe(404);
    driver.set('promo', true);
    expect((await app.request('/promo/show')).status).toBe(200);
  });
});
