import { describe, expect, it } from 'vitest';
// Deliberately not the root barrel: it loads every framework module, and this
// suite loads the modules that declare framework defaults after bootstrap.
import { Scope } from '../constants';
import { Inject, Injectable } from '../container/decorators';
import { ModuleRef } from '../container/module-ref';
import { declareRootDefault } from '../container/root-defaults';
import { InjectionToken, defineProvider } from '../container/types';
import { VelaFactory } from '../factory';
import { Global, Module } from '../module/decorators';

interface Clock {
  now(): number;
}

@Injectable()
class Host {
  constructor(@Inject(ModuleRef) readonly moduleRef: ModuleRef) {}
}

describe('framework defaults declared after bootstrap', () => {
  it('registers InternalDispatcher for a service a dynamic import loads after the application exists', async () => {
    @Module({ providers: [Host] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const { LateDispatchService } = await import('./fixtures/late-dispatch.service');
    const { InternalDispatcher } = await import('../dispatch/internal-dispatcher');

    const service = await app.get(Host).moduleRef.create(LateDispatchService);
    expect(service.dispatcher).toBeInstanceOf(InternalDispatcher);
    expect(app.get(InternalDispatcher)).toBe(service.dispatcher);
    await app.close();
  });

  it('serves a late default as one application-wide singleton to every module', async () => {
    @Injectable()
    class SystemClock implements Clock {
      now(): number {
        return 1;
      }
    }

    @Injectable()
    class Stamper {
      constructor(@Inject(SystemClock) readonly clock: SystemClock) {}
    }

    @Module({ providers: [Host] })
    class AppModule {}

    const first = await VelaFactory.create(AppModule);
    const second = await VelaFactory.create(AppModule);
    declareRootDefault(SystemClock);

    const stamper = await first.get(Host).moduleRef.create(Stamper);
    expect(stamper.clock).toBe(first.get(SystemClock));
    expect(second.get(SystemClock)).not.toBe(first.get(SystemClock));
    await Promise.all([first.close(), second.close()]);
  });

  it('keeps a late default that injects a request-scoped provider request-scoped', async () => {
    const REQUEST_ID = new InjectionToken<string>('synthetic request id');

    @Injectable()
    class RequestStamp {
      constructor(@Inject(REQUEST_ID) readonly id: string) {}
    }

    @Global()
    @Module({
      providers: [
        defineProvider(REQUEST_ID, { scope: Scope.REQUEST, inject: [], useFactory: () => 'id' }),
      ],
      exports: [REQUEST_ID],
    })
    class RequestModule {}

    @Module({ imports: [RequestModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    declareRootDefault(RequestStamp);

    expect(app.getContainer().getResolvedScope(RequestStamp)).toBe(Scope.REQUEST);
    await app.close();
  });

  it('yields a late default to one @Global() module, then to what the application configures', async () => {
    const CLOCK = new InjectionToken<Clock>('synthetic late clock');

    @Global()
    @Module({
      providers: [defineProvider(CLOCK, { useValue: { now: () => 2 } })],
      exports: [CLOCK],
    })
    class ClockModule {}

    @Module({ imports: [ClockModule] })
    class OverriddenModule {}

    @Module({})
    class PlainModule {}

    const overridden = await VelaFactory.create(OverriddenModule);
    const configured = await VelaFactory.create(PlainModule, {
      configureContainer: (container) => {
        container.register(defineProvider(CLOCK, { useValue: { now: () => 3 } }));
      },
    });
    const plain = await VelaFactory.create(PlainModule);
    declareRootDefault(defineProvider(CLOCK, { useValue: { now: () => 1 } }));

    expect(overridden.get(CLOCK).now()).toBe(2);
    expect(configured.get(CLOCK).now()).toBe(3);
    expect(plain.get(CLOCK).now()).toBe(1);
    await Promise.all([overridden.close(), configured.close(), plain.close()]);
  });
});
