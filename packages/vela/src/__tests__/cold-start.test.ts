import { defineProvider } from '../container/types';
import { describe, expect, it } from 'vitest';
import {
  Controller,
  EventEmitter,
  EventEmitterModule,
  EventEmitterSubscriber,
  Get,
  Inject,
  Injectable,
  Module,
  OnEvent,
  ScheduleModule,
  ScheduleRegistry,
  VelaFactory,
} from '../index.js';
import type {
  DynamicModule,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
} from '../index.js';
import { SeederModule, SeederRegistry, Seeder, runSeeders } from '../seeder/index.js';
import { I18nModule, MessageLoaderService } from '../i18n/index.js';
import { defineModule } from '../module/define-module.js';

describe('lazy cold-start init — deferral', () => {
  it('does not construct providers of a lazy module at create()', async () => {
    let constructed = 0;

    @Injectable()
    class LazySvc {
      constructor() {
        constructed++;
      }
    }

    @Module({ lazy: true, providers: [LazySvc], exports: [LazySvc] })
    class LazyModule {}

    @Controller('/')
    class AppController {
      @Get('/ping')
      ping() {
        return { ok: true };
      }
    }

    @Module({ imports: [LazyModule], controllers: [AppController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);

    expect(constructed).toBe(0);
    expect(app.getContainer().isInstantiated(LazySvc)).toBe(false);
    expect(app.getContainer().isLazyPending(LazySvc)).toBe(true);

    const res = await app.getHonoApp().request('/ping');
    expect(res.status).toBe(200);
    expect(constructed).toBe(0);
  });

  it('does not run lifecycle hooks of an untriggered lazy module (init or shutdown)', async () => {
    const events: string[] = [];

    @Injectable()
    class LazyHooked implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
      onModuleInit() {
        events.push('init');
      }
      onApplicationBootstrap() {
        events.push('bootstrap');
      }
      onModuleDestroy() {
        events.push('destroy');
      }
    }

    @Module({ lazy: true, providers: [LazyHooked], exports: [LazyHooked] })
    class LazyModule {}

    @Module({ imports: [LazyModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(events).toEqual([]);

    await app.close();
    expect(events).toEqual([]);
  });

  it('a token registered by BOTH a lazy and a non-lazy module stays eager', async () => {
    let constructed = 0;

    @Injectable()
    class SharedSvc {
      constructor() {
        constructed++;
      }
    }

    @Module({ lazy: true, providers: [SharedSvc], exports: [SharedSvc] })
    class LazyModule {}

    @Module({ providers: [SharedSvc], exports: [SharedSvc] })
    class EagerModule {}

    @Module({ imports: [LazyModule, EagerModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(constructed).toBeGreaterThanOrEqual(1);
    expect(app.getContainer().isLazyPending(SharedSvc)).toBe(false);
  });

  it('DynamicModule.lazy defers the module', async () => {
    let constructed = 0;

    @Injectable()
    class DynSvc {
      constructor() {
        constructed++;
      }
    }

    class DynModule {}

    const dyn: DynamicModule = {
      module: DynModule,
      lazy: true,
      providers: [DynSvc],
      exports: [DynSvc],
    };

    @Module({ imports: [dyn] })
    class AppModule {}

    await VelaFactory.create(AppModule);
    expect(constructed).toBe(0);
  });

  it('defineModule({ lazy: true }) stamps laziness onto generated definitions', async () => {
    let constructed = 0;

    @Injectable()
    class EngineSvc {
      constructor() {
        constructed++;
      }
    }

    const { ConfigurableModuleClass } = defineModule<{ x?: number }>({
      name: 'LazyEngine',
      lazy: true,
      setup: () => ({ providers: [EngineSvc], exports: [EngineSvc] }),
    });
    class EngineModule extends ConfigurableModuleClass {}

    @Module({ imports: [EngineModule.forRoot({ x: 1 })] })
    class AppModule {}

    await VelaFactory.create(AppModule);
    expect(constructed).toBe(0);
  });
});

describe('lazy cold-start init — triggering', () => {
  it('app.get() triggers the module: group constructs once, hooks replay once, in order', async () => {
    const events: string[] = [];

    @Injectable()
    class SvcA implements OnModuleInit, OnApplicationBootstrap {
      constructor() {
        events.push('construct:A');
      }
      onModuleInit() {
        events.push('init:A');
      }
      onApplicationBootstrap() {
        events.push('bootstrap:A');
      }
    }

    @Injectable()
    class SvcB implements OnModuleInit {
      constructor() {
        events.push('construct:B');
      }
      onModuleInit() {
        events.push('init:B');
      }
    }

    @Module({ lazy: true, providers: [SvcA, SvcB], exports: [SvcA, SvcB] })
    class LazyModule {}

    @Module({ imports: [LazyModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(events).toEqual([]);

    const a = app.get(SvcA);
    expect(a).toBeInstanceOf(SvcA);
    // Whole group materialized; onModuleInit for all members precedes
    // onApplicationBootstrap (mirrors the app-level phase order).
    expect(events).toEqual(['construct:A', 'construct:B', 'init:A', 'init:B', 'bootstrap:A']);

    // Memoized: further resolution does not re-run anything.
    app.get(SvcB);
    app.get(SvcA);
    expect(events).toEqual(['construct:A', 'construct:B', 'init:A', 'init:B', 'bootstrap:A']);

    // Materialized instances join the app's instance flow.
    expect(app.getInstances()).toContain(a);
  });

  it('an eager consumer injecting a lazy export triggers absorption during bootstrap (hooks run in normal phases)', async () => {
    const events: string[] = [];

    @Injectable()
    class LazyDep implements OnApplicationBootstrap {
      onApplicationBootstrap() {
        events.push('bootstrap:dep');
      }
    }

    @Module({ lazy: true, providers: [LazyDep], exports: [LazyDep] })
    class LazyModule {}

    @Injectable()
    class EagerConsumer implements OnApplicationBootstrap {
      constructor(@Inject(LazyDep) readonly dep: LazyDep) {}
      onApplicationBootstrap() {
        events.push('bootstrap:consumer');
      }
    }

    @Module({ imports: [LazyModule], providers: [EagerConsumer] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);

    // Both hooks ran during create(); the absorbed dependency's hook runs
    // BEFORE its eager consumer's (dependency-before-consumer ordering).
    expect(events).toEqual(['bootstrap:dep', 'bootstrap:consumer']);
    expect(app.getInstances().some((i) => i instanceof LazyDep)).toBe(true);
  });

  it('a lazy module controller constructs on first request, not at create()', async () => {
    let constructed = 0;
    const events: string[] = [];

    @Controller('/lazy')
    class LazyController implements OnModuleInit {
      constructor() {
        constructed++;
      }
      onModuleInit() {
        events.push('init');
      }
      @Get('/hello')
      hello() {
        return { hello: true };
      }
    }

    @Module({ lazy: true, controllers: [LazyController] })
    class LazyFeatureModule {}

    @Module({ imports: [LazyFeatureModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(constructed).toBe(0);
    expect(events).toEqual([]);

    const res = await app.getHonoApp().request('/lazy/hello');
    expect(res.status).toBe(200);
    expect(constructed).toBe(1);
    expect(events).toEqual(['init']);

    await app.getHonoApp().request('/lazy/hello');
    expect(constructed).toBe(1);
  });

  it('runs shutdown hooks for materialized lazy instances on close()', async () => {
    const events: string[] = [];

    @Injectable()
    class LazySvc implements OnModuleDestroy {
      onModuleDestroy() {
        events.push('destroy');
      }
    }

    @Module({ lazy: true, providers: [LazySvc], exports: [LazySvc] })
    class LazyModule {}

    @Module({ imports: [LazyModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    app.get(LazySvc);
    await app.close();
    expect(events).toEqual(['destroy']);
  });

  it('materializeLazyModules() materializes every pending group (async hooks allowed)', async () => {
    const events: string[] = [];

    @Injectable()
    class AsyncHooked implements OnModuleInit {
      async onModuleInit() {
        await Promise.resolve();
        events.push('async-init');
      }
    }

    @Module({ lazy: true, providers: [AsyncHooked], exports: [AsyncHooked] })
    class LazyModule {}

    @Module({ imports: [LazyModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(events).toEqual([]);

    await app.materializeLazyModules();
    expect(events).toEqual(['async-init']);
    expect(app.getContainer().isLazyPending(AsyncHooked)).toBe(false);
  });

  it('sync trigger of a lazy module with async hooks throws a descriptive error', async () => {
    @Injectable()
    class AsyncHooked implements OnModuleInit {
      async onModuleInit() {
        await Promise.resolve();
      }
    }

    @Module({ lazy: true, providers: [AsyncHooked], exports: [AsyncHooked] })
    class LazyModule {}

    @Module({ imports: [LazyModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(() => app.get(AsyncHooked)).toThrow(/async/i);
  });
});

describe('lazy cold-start init — first-party subsystems (HTTP-only worker)', () => {
  it('pays zero subsystem cost when nothing uses them', async () => {
    @Controller('/')
    class AppController {
      @Get('/ping')
      ping() {
        return { ok: true };
      }
    }

    @Module({
      imports: [EventEmitterModule, ScheduleModule, SeederModule, I18nModule.forRoot({})],
      controllers: [AppController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const container = app.getContainer();

    expect(container.isInstantiated(EventEmitterSubscriber)).toBe(false);
    expect(container.isInstantiated(EventEmitter)).toBe(false);
    expect(container.isInstantiated(ScheduleRegistry)).toBe(false);
    expect(container.isInstantiated(SeederRegistry)).toBe(false);
    expect(container.isInstantiated(MessageLoaderService)).toBe(false);

    const res = await app.getHonoApp().request('/ping');
    expect(res.status).toBe(200);
  });

  it('@OnEvent subscribers fire when the emitter is first reached via app.get()', async () => {
    const received: unknown[] = [];

    @Injectable()
    class Listener {
      @OnEvent('user.created')
      onUserCreated(payload: unknown) {
        received.push(payload);
      }
    }

    @Module({ imports: [EventEmitterModule], providers: [Listener] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    app.get(EventEmitter).emit('user.created', { id: 1 });
    expect(received).toEqual([{ id: 1 }]);
  });

  it('@OnEvent subscribers fire when an eager service injects the emitter', async () => {
    const received: unknown[] = [];

    @Injectable()
    class Listener {
      @OnEvent('order.placed')
      onOrder(payload: unknown) {
        received.push(payload);
      }
    }

    @Injectable()
    class OrderService {
      constructor(readonly emitter: EventEmitter) {}
      place() {
        this.emitter.emit('order.placed', { order: 42 });
      }
    }

    @Module({ imports: [EventEmitterModule], providers: [Listener, OrderService] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    app.get(OrderService).place();
    expect(received).toEqual([{ order: 42 }]);
  });

  it('schedule registry populates on first access', async () => {
    @Injectable()
    class Jobs {
      ticks = 0;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      tick() {
        this.ticks++;
      }
    }
    // Decorate via the public decorator import to keep parity with schedule tests.
    const { Cron } = await import('../schedule/index.js');
    Cron('* * * * *')(
      Jobs.prototype,
      'tick',
      Object.getOwnPropertyDescriptor(Jobs.prototype, 'tick')!,
    );

    @Module({ imports: [ScheduleModule], providers: [Jobs] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(app.getContainer().isInstantiated(ScheduleRegistry)).toBe(false);

    const registry = app.get(ScheduleRegistry);
    expect(registry.getCronJobs()).toHaveLength(1);
  });

  it('runSeeders() works against a lazy SeederModule', async () => {
    const seeded: string[] = [];

    @Seeder({ order: 1 })
    class UserSeeder {
      run() {
        seeded.push('users');
      }
    }

    @Module({ imports: [SeederModule.forRoot({ seeders: [UserSeeder] })] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(app.getContainer().isInstantiated(SeederRegistry)).toBe(false);

    const results = await runSeeders(app);
    expect(seeded).toEqual(['users']);
    expect(results).toHaveLength(1);
  });

  it('i18n translates on first request without bootstrap-time materialization', async () => {
    const { I18nService } = await import('../i18n/index.js');

    @Controller('/')
    class GreetController {
      constructor(@Inject(I18nService) private readonly i18n: InstanceType<typeof I18nService>) {}
      @Get('/greet')
      greet() {
        return { message: this.i18n.t('greeting') };
      }
    }

    @Module({
      imports: [
        I18nModule.forRoot({ fallbackLocale: 'en' }),
        I18nModule.registerMessages({ en: { greeting: 'hello' } }),
      ],
      controllers: [GreetController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(app.getContainer().isInstantiated(MessageLoaderService)).toBe(false);

    const res = await app.getHonoApp().request('/greet');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: 'hello' });
  });
});

describe('lazy cold-start init — entrypoints', () => {
  it('declared-kind providers in lazy modules yield metadata-only entries; dispatch-time resolve materializes', async () => {
    const { registerEntrypointKind } = await import('../index.js');
    const { _resetEntrypointKinds } = await import('../entrypoint/entrypoint.registry.js');
    const { createDiscoverableDecorator } = await import('../index.js');
    _resetEntrypointKinds();

    const QueueWorker = createDiscoverableDecorator<{ queue: string }>('test:cs:queue');
    registerEntrypointKind({ kind: 'cs:queue', metaKey: QueueWorker.KEY, level: 'class' });

    const events: string[] = [];

    @QueueWorker({ queue: 'jobs' })
    @Injectable()
    class JobsConsumer implements OnApplicationBootstrap {
      constructor() {
        events.push('construct');
      }
      onApplicationBootstrap() {
        events.push('bootstrap');
      }
    }

    @Module({ lazy: true, providers: [JobsConsumer], exports: [JobsConsumer] })
    class QueueModule {}

    @Module({ imports: [QueueModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);

    // Snapshot has the entry, metadata intact, no instance — nothing constructed.
    const eps = app.entrypoints.ofKind('cs:queue');
    expect(eps).toHaveLength(1);
    expect(eps[0]!.meta).toEqual({ queue: 'jobs' });
    expect(eps[0]!.instance).toBeUndefined();
    expect(events).toEqual([]);

    // Dispatch-time re-resolve by token (the cloudflare pattern) materializes
    // the module and replays its hooks.
    const instance = app.getContainer().resolve(eps[0]!.token);
    expect(instance).toBeInstanceOf(JobsConsumer);
    expect(events).toEqual(['construct', 'bootstrap']);
    _resetEntrypointKinds();
  });

  it('a ContributesEntrypoints provider in a lazy module is materialized before the snapshot', async () => {
    const events: string[] = [];

    @Injectable()
    class TickDispatcher {
      constructor() {
        events.push('construct');
      }
      collectEntrypoints() {
        return [
          { kind: 'cs:tick', token: TickDispatcher, instance: this, meta: { computed: true } },
        ];
      }
    }

    @Module({ lazy: true, providers: [TickDispatcher], exports: [TickDispatcher] })
    class TickModule {}

    @Module({ imports: [TickModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);

    // Computed contributions cannot be deferred — the module was materialized
    // right before the snapshot (documented cost of computed entrypoints).
    expect(events).toEqual(['construct']);
    const eps = app.entrypoints.ofKind('cs:tick');
    expect(eps).toHaveLength(1);
    expect(eps[0]!.meta).toEqual({ computed: true });
  });

  it('keyed lazy module instances trigger independently', async () => {
    const constructed: string[] = [];
    const NAME_A = Symbol('cs:name:a');
    const NAME_B = Symbol('cs:name:b');

    @Injectable()
    class Named {
      constructor() {
        constructed.push('instance');
      }
    }

    class NamedModule {}
    const instanceOf = (key: string, token: symbol): DynamicModule => ({
      module: NamedModule,
      key,
      lazy: true,
      providers: [defineProvider(token, { inject: [], useFactory: () => new Named() })],
      exports: [token as never],
    });

    @Module({ imports: [instanceOf('a', NAME_A), instanceOf('b', NAME_B)] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(constructed).toHaveLength(0);

    app.get(NAME_A as never);
    expect(constructed).toHaveLength(1);

    app.get(NAME_B as never);
    expect(constructed).toHaveLength(2);
  });
});

describe('lazy cold-start init — concurrency', () => {
  it('a drainAsync arriving while another is in flight awaits the full completion', async () => {
    const { LazyModuleManager } = await import('../module/lazy-modules.js');
    const { Container: RawContainer } = await import('../container/container.js');

    const events: string[] = [];
    const container = new RawContainer({ diagnostics: 'throw' });

    @Injectable()
    class Slow implements OnModuleInit {
      async onModuleInit() {
        await new Promise((r) => setTimeout(r, 20));
        events.push('slow-init');
      }
    }

    @Injectable()
    class Fast implements OnModuleInit {
      onModuleInit() {
        events.push('fast-init');
      }
    }

    container.registerScope({
      moduleId: 'M1',
      localProviders: new Set([Slow]),
      importedModules: new Set(),
      exportedTokens: new Set(),
      isGlobal: false,
      lazy: true,
    });
    container.registerScope({
      moduleId: 'M2',
      localProviders: new Set([Fast]),
      importedModules: new Set(),
      exportedTokens: new Set(),
      isGlobal: false,
      lazy: true,
    });
    container.register(Slow, 'M1');
    container.register(Fast, 'M2');

    const manager = new LazyModuleManager(container);
    manager.registerGroup({ moduleId: 'M1', tokens: [Slow], hasEntrypointContributor: false });
    manager.registerGroup({ moduleId: 'M2', tokens: [Fast], hasEntrypointContributor: false });
    manager.setPhaseLive();

    manager.claim('M1');
    const first = manager.drainAsync();
    manager.claim('M2');
    const second = manager.drainAsync();

    await second;
    // The second drain must not resolve before every claimed group —
    // including M2, picked up by the in-flight loop — has run its hooks.
    expect(events).toContain('fast-init');
    expect(events).toContain('slow-init');
    await first;
  });
});

describe('lazy cold-start init — hand-rolled bootstrap paths', () => {
  it('arms the manager from loader.load() so builders that never call bootstrap() keep hook replay', async () => {
    // @velajs/testing's TestingModuleBuilder.compile() constructs its own
    // Container and replicates bootstrap()'s registrations without calling
    // bootstrap(). If the LazyModuleManager were armed only by bootstrap(),
    // that path would skip lazy tokens in the eager sweep with NO trigger
    // installed — first touch would construct silently WITHOUT hook replay.
    const { Container, ModuleLoader, RouteManager, VelaApplication } =
      await import('../internal.js');

    const events: string[] = [];

    @Injectable()
    class WiredService implements OnModuleInit {
      onModuleInit() {
        events.push('init');
      }
    }

    @Module({ lazy: true, providers: [WiredService], exports: [WiredService] })
    class LazyModule {}

    @Module({ imports: [LazyModule] })
    class AppModule {}

    const container = new Container({ diagnostics: 'throw' });
    const routeManager = new RouteManager(container);
    const loader = new ModuleLoader(container, routeManager);
    loader.load(AppModule);
    container.computeEffectiveScopes();

    const app = new VelaApplication(container, routeManager);
    const instances = await loader.resolveAllInstances();
    app.setInstances(instances);
    await app.callOnModuleInit();
    await app.callOnApplicationBootstrap();

    // Deferred at bootstrap…
    expect(instances.some((i) => i instanceof WiredService)).toBe(false);
    expect(events).toEqual([]);

    // …and the first sync touch still materializes WITH hook replay.
    container.resolve(WiredService);
    expect(events).toEqual(['init']);
  });
});

describe('lazy cold-start init — review hardening', () => {
  it(
    'an eager provider injecting exports from TWO lazy modules does not deadlock create()',
    { timeout: 5000 },
    async () => {
      const events: string[] = [];

      @Injectable()
      class SvcOne implements OnApplicationBootstrap {
        onApplicationBootstrap() {
          events.push('boot:one');
        }
      }
      @Injectable()
      class SvcTwo implements OnApplicationBootstrap {
        onApplicationBootstrap() {
          events.push('boot:two');
        }
      }

      @Module({ lazy: true, providers: [SvcOne], exports: [SvcOne] })
      class LazyOne {}
      @Module({ lazy: true, providers: [SvcTwo], exports: [SvcTwo] })
      class LazyTwo {}

      @Injectable()
      class EagerBoth {
        constructor(
          @Inject(SvcOne) readonly one: SvcOne,
          @Inject(SvcTwo) readonly two: SvcTwo,
        ) {}
      }

      @Module({ imports: [LazyOne, LazyTwo], providers: [EagerBoth] })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      expect(events).toContain('boot:one');
      expect(events).toContain('boot:two');
      await app.close();
    },
  );

  it(
    'materializeLazyModules() with several pending lazy modules does not deadlock',
    { timeout: 5000 },
    async () => {
      const events: string[] = [];

      @Injectable()
      class PendingA implements OnModuleInit {
        onModuleInit() {
          events.push('init:a');
        }
      }
      @Injectable()
      class PendingB implements OnModuleInit {
        onModuleInit() {
          events.push('init:b');
        }
      }

      @Module({ lazy: true, providers: [PendingA], exports: [PendingA] })
      class ModA {}
      @Module({ lazy: true, providers: [PendingB], exports: [PendingB] })
      class ModB {}

      @Module({ imports: [ModA, ModB] })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      expect(events).toEqual([]);
      await app.materializeLazyModules();
      expect(events.sort()).toEqual(['init:a', 'init:b']);
    },
  );

  it('ModuleRef.create still triggers lazy materialization with hook replay', async () => {
    const { ModuleRef } = await import('../index.js');
    const events: string[] = [];

    @Injectable()
    class LazyWired implements OnModuleInit {
      onModuleInit() {
        events.push('init');
      }
    }

    @Module({ lazy: true, providers: [LazyWired], exports: [LazyWired] })
    class LazyModule {}

    @Module({ imports: [LazyModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(events).toEqual([]);

    @Injectable()
    class SandboxConsumer {
      constructor(@Inject(LazyWired) readonly dep: LazyWired) {}
    }

    const created = await app.get(ModuleRef).create(SandboxConsumer);
    expect(created.dep).toBeInstanceOf(LazyWired);
    expect(events).toEqual(['init']);

    // No poisoned pre-hook singleton left behind: the main container returns
    // the same materialized instance, hooks exactly once.
    expect(app.get(LazyWired)).toBe(created.dep);
    expect(events).toEqual(['init']);
  });

  it('a provider shared by a lazy (imported first) and an eager module runs each hook exactly once', async () => {
    const events: string[] = [];

    @Injectable()
    class SharedHooked implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
      onModuleInit() {
        events.push('init');
      }
      onApplicationBootstrap() {
        events.push('boot');
      }
      onModuleDestroy() {
        events.push('destroy');
      }
    }

    @Module({ lazy: true, providers: [SharedHooked], exports: [SharedHooked] })
    class LazyModule {}
    @Module({ providers: [SharedHooked], exports: [SharedHooked] })
    class EagerModule {}

    @Module({ imports: [LazyModule, EagerModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await app.close();
    expect(events).toEqual(['init', 'boot', 'destroy']);
  });

  it(
    'live-phase nested lazy→lazy keeps dependency-before-consumer hook order (eager parity)',
    { timeout: 5000 },
    async () => {
      const events: string[] = [];

      @Injectable()
      class DepSvc implements OnModuleInit, OnApplicationBootstrap {
        constructor() {
          events.push('construct:dep');
        }
        onModuleInit() {
          events.push('init:dep');
        }
        onApplicationBootstrap() {
          events.push('boot:dep');
        }
      }

      @Module({ lazy: true, providers: [DepSvc], exports: [DepSvc] })
      class LazyDepModule {}

      @Injectable()
      class ConsumerSvc implements OnModuleInit, OnApplicationBootstrap {
        constructor(@Inject(DepSvc) readonly dep: DepSvc) {
          events.push('construct:consumer');
        }
        onModuleInit() {
          events.push('init:consumer');
        }
        onApplicationBootstrap() {
          events.push('boot:consumer');
        }
      }

      @Module({
        lazy: true,
        imports: [LazyDepModule],
        providers: [ConsumerSvc],
        exports: [ConsumerSvc],
      })
      class LazyConsumerModule {}

      @Module({ imports: [LazyConsumerModule] })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      expect(events).toEqual([]);

      app.get(ConsumerSvc);
      // Same phase order the eager bootstrap would produce: dependency's hooks
      // before the consumer's, all inits before all bootstraps.
      expect(events).toEqual([
        'construct:dep',
        'construct:consumer',
        'init:dep',
        'init:consumer',
        'boot:dep',
        'boot:consumer',
      ]);
    },
  );

  it('bootstrap-phase nested lazy→lazy absorption keeps dependency-before-consumer hook order', async () => {
    const events: string[] = [];

    @Injectable()
    class DeepDep implements OnApplicationBootstrap {
      onApplicationBootstrap() {
        events.push('boot:deep');
      }
    }

    @Module({ lazy: true, providers: [DeepDep], exports: [DeepDep] })
    class DeepModule {}

    @Injectable()
    class MidSvc implements OnApplicationBootstrap {
      constructor(@Inject(DeepDep) readonly dep: DeepDep) {}
      onApplicationBootstrap() {
        events.push('boot:mid');
      }
    }

    @Module({ lazy: true, imports: [DeepModule], providers: [MidSvc], exports: [MidSvc] })
    class MidModule {}

    @Injectable()
    class EagerTop implements OnApplicationBootstrap {
      constructor(@Inject(MidSvc) readonly mid: MidSvc) {}
      onApplicationBootstrap() {
        events.push('boot:top');
      }
    }

    @Module({ imports: [MidModule], providers: [EagerTop] })
    class AppModule {}

    await VelaFactory.create(AppModule);
    expect(events).toEqual(['boot:deep', 'boot:mid', 'boot:top']);
  });
});
