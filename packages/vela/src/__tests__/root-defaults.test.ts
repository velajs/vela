import { describe, expect, it } from 'vitest';
// Deliberately not the root barrel: it loads every framework module, and this
// suite checks what bootstrap registers before a module has been loaded.
import { Inject, Injectable } from '../container/decorators';
import { declareRootDefault } from '../container/root-defaults';
import { InjectionToken, defineProvider, describeToken } from '../container/types';
import { bootstrap } from '../factory/bootstrap';
import { VelaFactory } from '../factory';
import { Global, Module } from '../module/decorators';

const OPTIONAL_SERVICES = [
  'UrlGeneratorService',
  'SignedUrlGuard',
  'InternalDispatcher',
  'SignedInvocationGuard',
  'InjectionToken(NONCE_STORE)',
];

interface Clock {
  now(): number;
}

describe('framework root defaults', () => {
  it('registers the signed-URL and signed-dispatch services once their modules load', async () => {
    @Module({})
    class AppModule {}

    const before = await bootstrap(AppModule);
    const registeredBefore = new Set(before.container.getTokens().map(describeToken));
    expect(OPTIONAL_SERVICES.filter((name) => registeredBefore.has(name))).toEqual([]);

    const { InternalDispatcher } = await import('../dispatch/internal-dispatcher');
    const { SignedInvocationGuard } = await import('../dispatch/signed-invocation.guard');
    const { NONCE_STORE, MemoryNonceStore } = await import('../dispatch/nonce-store');
    const { SignedUrlGuard } = await import('../http/url/signed-url.guard');
    const { UrlGeneratorService } = await import('../http/url/url-generator.service');

    const app = await VelaFactory.create(AppModule);
    for (const token of [
      InternalDispatcher,
      SignedInvocationGuard,
      NONCE_STORE,
      SignedUrlGuard,
      UrlGeneratorService,
    ]) {
      expect(app.getContainer().has(token)).toBe(true);
    }
    expect(app.get(NONCE_STORE)).toBeInstanceOf(MemoryNonceStore);
    expect(app.get(InternalDispatcher)).toBe(app.get(InternalDispatcher));
    await app.close();
  });

  it('serves a declared default to every module as one application-wide singleton', async () => {
    @Injectable()
    class SystemClock implements Clock {
      now(): number {
        return 1;
      }
    }
    declareRootDefault(SystemClock);

    @Injectable()
    class Stamper {
      constructor(@Inject(SystemClock) readonly clock: SystemClock) {}
    }

    @Module({ providers: [Stamper] })
    class FeatureModule {}

    @Module({ imports: [FeatureModule] })
    class AppModule {}

    const first = await VelaFactory.create(AppModule);
    const second = await VelaFactory.create(AppModule);
    expect(first.get(Stamper).clock).toBe(first.get(SystemClock));
    expect(second.get(SystemClock)).not.toBe(first.get(SystemClock));
    await Promise.all([first.close(), second.close()]);
  });

  it('yields to one @Global() module, then to what the application configures', async () => {
    const CLOCK = new InjectionToken<Clock>('synthetic clock');
    declareRootDefault(defineProvider(CLOCK, { useValue: { now: () => 1 } }));

    @Global()
    @Module({
      providers: [defineProvider(CLOCK, { useValue: { now: () => 2 } })],
      exports: [CLOCK],
    })
    class ClockModule {}

    @Module({ imports: [ClockModule] })
    class AppModule {}

    const overridden = await VelaFactory.create(AppModule);
    expect(overridden.get(CLOCK).now()).toBe(2);

    const configured = await VelaFactory.create(AppModule, {
      configureContainer: (container) => {
        container.register(defineProvider(CLOCK, { useValue: { now: () => 3 } }));
      },
    });
    expect(configured.get(CLOCK).now()).toBe(3);
    await Promise.all([overridden.close(), configured.close()]);
  });
});
