import { defineProvider } from '../container/types';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  Controller,
  Get,
  Injectable,
  InjectionToken,
  Module,
  Scope,
  VelaFactory,
} from '../index.js';
import {
  DiscoveryService,
  createDiscoverableDecorator,
  registerEntrypointKind,
  runInEntrypointScope,
  Container,
} from '../module-kit.js';
import { WebSocketModule, WS_SERVER } from '../websocket/index.js';
import { _resetEntrypointKinds } from '../entrypoint/entrypoint.registry.js';
import type { ContributesEntrypoints, Entrypoint, RuntimeAdapter } from '../module-kit.js';

beforeEach(() => {
  _resetEntrypointKinds();
});

describe('DiscoveryService', () => {
  it('finds providers by class-level metadata with instances and meta', async () => {
    interface RobotMeta {
      model: string;
    }
    const Robot = createDiscoverableDecorator<RobotMeta>('vela-test:robot');

    @Robot({ model: 'R2' })
    @Injectable()
    class R2 {}

    @Robot({ model: 'C3' })
    @Injectable()
    class C3 {}

    // Decorated but NOT registered as a provider — must not be discovered.
    @Robot({ model: 'Ghost' })
    @Injectable()
    class Ghost {}
    void Ghost;

    @Module({ providers: [R2, C3] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const discovery = app.get(DiscoveryService);

    const found = discovery.providersWithMeta<RobotMeta>(Robot);
    const models = found.map((f) => f.meta.model).sort();
    expect(models).toEqual(['C3', 'R2']);
    expect(found.every((f) => f.instance !== undefined)).toBe(true);
    expect(found.every((f) => f.moduleIds.length > 0)).toBe(true);
  });

  it('finds methods via the appended class-level list convention', async () => {
    interface JobMeta {
      cron: string;
    }
    const Job = createDiscoverableDecorator<JobMeta>('vela-test:job', { append: true });

    @Injectable()
    class Worker {
      @Job({ cron: '* * * * *' })
      tick() {}

      @Job({ cron: '0 0 * * *' })
      nightly() {}
    }

    @Module({ providers: [Worker] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const discovery = app.get(DiscoveryService);

    const methods = discovery.methodsWithMeta<JobMeta & { methodName: string }>(Job);
    expect(methods.map((m) => String(m.methodName)).sort()).toEqual(['nightly', 'tick']);
    expect(methods.every((m) => m.class.instance instanceof Worker)).toBe(true);
  });

  it('finds handler-level metadata written by non-append method decorators', async () => {
    const Tagged = createDiscoverableDecorator<string>('vela-test:tagged');

    @Injectable()
    class Svc {
      @Tagged('a')
      one() {}
    }

    @Module({ providers: [Svc] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const discovery = app.get(DiscoveryService);

    const methods = discovery.methodsWithMeta<string>('vela-test:tagged');
    expect(methods).toHaveLength(1);
    expect(methods[0].methodName).toBe('one');
    expect(methods[0].meta).toBe('a');
  });

  it('skips request-scoped providers by default (instance undefined), resolves them in a requestScope', async () => {
    const Flagged = createDiscoverableDecorator<boolean>('vela-test:flagged');

    @Flagged(true)
    @Injectable({ scope: Scope.REQUEST })
    class PerRequest {}

    @Module({ providers: [PerRequest] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const discovery = app.get(DiscoveryService);

    const found = discovery.providersWithMeta<boolean>(Flagged);
    expect(found).toHaveLength(1);
    expect(found[0].scope).toBe(Scope.REQUEST);
    expect(found[0].instance).toBeUndefined();

    await runInEntrypointScope(app.getContainer(), (scope) => {
      const forced = discovery.providersWithMeta<boolean>(Flagged, { requestScope: scope });
      expect(forced[0].instance).toBeInstanceOf(PerRequest);
      expect(forced[0].instance).toBe(scope.resolve(PerRequest));
    });
  });

  it('honors diagnostics=throw when a discovered provider cannot resolve', async () => {
    const Broken = createDiscoverableDecorator<boolean>('vela-test:broken');
    const MISSING = new InjectionToken<string>('MISSING_DEP_TEST');

    @Broken(true)
    @Injectable()
    class NeedsMissing {
      constructor() {}
    }

    @Module({ providers: [NeedsMissing] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, { diagnostics: 'throw' });
    // Re-register with a factory that throws, simulating a broken provider.
    app.getContainer().replaceProvider(
      defineProvider(NeedsMissing, {
        inject: [],
        useFactory: () => {
          throw new Error('boom');
        },
      }),
    );
    // Bust the memoized singleton so discovery re-resolves.
    const discovery = new DiscoveryService(app.getContainer());

    expect(() => discovery.providersWithMeta(Broken)).toThrow(/boom/);
    void MISSING;
  });
});

describe('EntrypointRegistry', () => {
  it('collects class-level kinds declared via registerEntrypointKind', async () => {
    interface ConsumerMeta {
      queue: string;
    }
    const QueueConsumer = createDiscoverableDecorator<ConsumerMeta>('vela-test:queue-consumer');
    registerEntrypointKind({
      kind: 'queue',
      metaKey: QueueConsumer.KEY,
      level: 'class',
    });

    @QueueConsumer({ queue: 'emails' })
    @Injectable()
    class EmailConsumer {}

    @Module({ providers: [EmailConsumer] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const eps = app.entrypoints.ofKind('queue');
    expect(eps).toHaveLength(1);
    expect(eps[0].meta).toEqual({ queue: 'emails' });
    expect(eps[0].instance).toBeInstanceOf(EmailConsumer);
  });

  it('collects method-level kinds', async () => {
    interface TickMeta {
      every: number;
    }
    const Tick = createDiscoverableDecorator<TickMeta>('vela-test:tick', { append: true });
    registerEntrypointKind({ kind: 'tick', metaKey: Tick.KEY, level: 'method' });

    @Injectable()
    class Ticker {
      @Tick({ every: 5 })
      five() {}
      @Tick({ every: 10 })
      ten() {}
    }

    @Module({ providers: [Ticker] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const eps = app.entrypoints.ofKind('tick');
    expect(eps.map((e) => String(e.methodName)).sort()).toEqual(['five', 'ten']);
  });

  it('a ContributesEntrypoints provider is authoritative for its kinds', async () => {
    const Marked = createDiscoverableDecorator<boolean>('vela-test:marked');
    registerEntrypointKind({ kind: 'marked', metaKey: Marked.KEY, level: 'class' });

    @Marked(true)
    @Injectable()
    class MetaDeclared {}

    @Injectable()
    class Computer implements ContributesEntrypoints {
      collectEntrypoints(): Entrypoint[] {
        return [{ kind: 'marked', token: Computer, instance: this, meta: { computed: true } }];
      }
    }

    @Module({ providers: [MetaDeclared, Computer] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const eps = app.entrypoints.ofKind('marked');
    // Contributor replaced the metaKey-derived entry.
    expect(eps).toHaveLength(1);
    expect(eps[0].meta).toEqual({ computed: true });
  });

  it('two apps in one process do not share entrypoint instances (per-app registries)', async () => {
    interface NamedMeta {
      name: string;
    }
    const Named = createDiscoverableDecorator<NamedMeta>('vela-test:named');
    registerEntrypointKind({ kind: 'named', metaKey: Named.KEY, level: 'class' });

    @Named({ name: 'only-in-A' })
    @Injectable()
    class AService {}

    @Module({ providers: [AService] })
    class AModule {}

    @Module({})
    class BModule {}

    const appA = await VelaFactory.create(AModule);
    const appB = await VelaFactory.create(BModule);

    expect(appA.entrypoints.ofKind('named')).toHaveLength(1);
    // B's container never registered AService — its registry must be empty.
    expect(appB.entrypoints.ofKind('named')).toHaveLength(0);
  });

  it('the websocket module contributes one entrypoint per gateway (HMR-dedup regression)', async () => {
    const { WebSocketGateway, SubscribeMessage } = await import('../websocket/index.js');

    @WebSocketGateway({ path: '/ws/chat/:id', roomParam: 'id' })
    class ChatGateway {
      @SubscribeMessage('ping')
      ping() {
        return { event: 'pong', data: {} };
      }
    }

    // Two identical forRoot() calls must dedup into ONE module instance
    // (deterministic key — the old counter minted a new instance per call).
    @Module({
      imports: [WebSocketModule.forRoot(), WebSocketModule.forRoot()],
      providers: [ChatGateway],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const eps = app.entrypoints.ofKind('websocket');
    expect(eps).toHaveLength(1);
    expect(eps[0].token).toBe(ChatGateway);
    expect(app.get(WS_SERVER)).toBeDefined();
  });
});

describe('Container.replaceProvider', () => {
  it('replaces the token in every bucket that already holds it, plus root', async () => {
    const TOKEN = new InjectionToken<string>('REPLACE_TEST');

    @Module({ providers: [defineProvider(TOKEN, { useValue: 'original' })], exports: [TOKEN] })
    class FeatureModule {}

    @Injectable()
    class Reader {
      constructor() {}
    }

    @Module({ imports: [FeatureModule], providers: [Reader] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const container = app.getContainer() as Container;

    container.replaceProvider(defineProvider(TOKEN, { useValue: 'override' }));

    // Root/no-requester view AND module-scoped view both see the override.
    expect(container.resolve(TOKEN)).toBe('override');
    for (const moduleId of container.getOwnerModuleIds(TOKEN)) {
      expect(container.resolve(TOKEN, moduleId)).toBe('override');
    }
  });
});

describe('factory dependency visibility (declaringModuleId threading)', () => {
  it('a forRootAsync-style factory resolves inject deps from its module scope', async () => {
    const DEP = new InjectionToken<string>('SCOPED_DEP_TEST');
    const OUT = new InjectionToken<string>('SCOPED_OUT_TEST');

    @Module({ providers: [defineProvider(DEP, { useValue: 'from-import' })], exports: [DEP] })
    class DepModule {}

    // FeatureModule imports DepModule; its factory injects DEP — visible only
    // through the module's imports (not global, not in root).
    @Module({
      imports: [DepModule],
      providers: [
        defineProvider(OUT, { useFactory: (dep: string) => `got:${dep}`, inject: [DEP] }),
      ],
      exports: [OUT],
      isGlobal: true,
    })
    class FeatureModule {}

    @Module({ imports: [FeatureModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(app.get(OUT)).toBe('got:from-import');
  });
});

describe('RuntimeAdapter', () => {
  it('runs onBootstrap before routes and onRoutesBuilt after, with entrypoints available', async () => {
    const order: string[] = [];

    @Controller('/a')
    class AController {
      @Get() list() {
        return [];
      }
    }

    @Module({ controllers: [AController] })
    class AppModule {}

    const adapter: RuntimeAdapter = {
      name: 'test-adapter',
      onBootstrap: (ctx) => {
        order.push('bootstrap');
        // entrypoints already built; routes not yet.
        expect(ctx.app.entrypoints).toBeDefined();
        expect(() => ctx.app.getHonoApp()).toThrow();
      },
      onRoutesBuilt: (ctx) => {
        order.push('routes');
        expect(ctx.app.getHonoApp()).toBeDefined();
      },
    };

    const requestLog = vi.fn();
    adapter.requestMiddleware = [
      async (_c, next) => {
        requestLog();
        await next();
      },
    ];

    const app = await VelaFactory.create(AppModule, { adapters: [adapter] });
    expect(order).toEqual(['bootstrap', 'routes']);

    const res = await app.getHonoApp().request('/a');
    expect(res.status).toBe(200);
    expect(requestLog).toHaveBeenCalledTimes(1);
  });
});
