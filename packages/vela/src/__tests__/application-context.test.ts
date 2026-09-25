import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ENV,
  Inject,
  InjectionToken,
  Injectable,
  Module,
  Scope,
  VelaApplication,
  VelaApplicationContext,
  VelaFactory,
  defineProvider,
  type DynamicModule,
  type VelaApplicationContextOptions,
} from '../index';
import { ModuleVisibilityError, runInEntrypointScope } from '../module-kit';

const GREETING = new InjectionToken<string>('GREETING');

@Injectable()
class Repository {
  readonly rows = ['a', 'b'];
}

@Injectable()
class Hidden {}

@Module({ providers: [Repository, Hidden], exports: [Repository] })
class DataModule {}

@Injectable()
class Report {
  constructor(@Inject(Repository) readonly repository: Repository) {}
}

@Module({ imports: [DataModule], providers: [Report] })
class ReportsModule {}

describe('VelaFactory.createApplicationContext', () => {
  it('boots the module graph with its lifecycle hooks and no HTTP surface', async () => {
    const events: string[] = [];
    @Injectable()
    class Worker {
      onModuleInit() {
        events.push('init');
      }
      onApplicationBootstrap() {
        events.push('bootstrap');
      }
      beforeApplicationShutdown(signal?: string) {
        events.push(`before:${signal}`);
      }
      onModuleDestroy() {
        events.push('destroy');
      }
      onApplicationShutdown(signal?: string) {
        events.push(`shutdown:${signal}`);
      }
    }
    @Module({ providers: [Worker] })
    class AppModule {}

    const context = await VelaFactory.createApplicationContext(AppModule);
    expectTypeOf(context).toEqualTypeOf<VelaApplicationContext>();
    expect(events).toEqual(['init', 'bootstrap']);
    expect(context.get(Worker)).toBeInstanceOf(Worker);
    expect(context).not.toBeInstanceOf(VelaApplication);
    expect('fetch' in context).toBe(false);
    // Entrypoints are assembled as for an application.
    expect(context.entrypoints.all()).toEqual([]);

    // init() is idempotent: the hooks already ran while creating the context.
    await expect(context.init()).resolves.toBe(context);
    expect(events).toEqual(['init', 'bootstrap']);

    await context.close('SIGTERM');
    expect(events).toEqual(['init', 'bootstrap', 'before:SIGTERM', 'destroy', 'shutdown:SIGTERM']);
  });

  it('seeds ENV and runs configureContainer before any provider is constructed', async () => {
    const env = { REGION: 'eu' };
    const seen: unknown[] = [];
    @Injectable()
    class Reader {
      constructor(
        @Inject(ENV) readonly env: object,
        @Inject(GREETING) readonly greeting: string,
      ) {
        seen.push(env, greeting);
      }
    }
    @Module({ providers: [Reader] })
    class AppModule {}

    const options: VelaApplicationContextOptions = {
      env,
      configureContainer(container) {
        container.register(defineProvider(GREETING, { useValue: 'hello' }));
        container.markGlobalToken(GREETING);
      },
    };
    const context = await VelaFactory.createApplicationContext(AppModule, options);
    expect(seen).toEqual([env, 'hello']);
    expect(context.get(ENV)).toBe(env);
    await context.dispose();
  });

  it('resolves app-wide by default and with module visibility when strict', async () => {
    @Module({ imports: [ReportsModule] })
    class AppModule {}
    const context = await VelaFactory.createApplicationContext(AppModule);

    const report = context.get(Report);
    expectTypeOf(report).toEqualTypeOf<Report>();
    expect(report.repository).toBe(context.get(Repository));
    // Not exported by DataModule, still reachable app-wide.
    expect(context.get(Hidden)).toBeInstanceOf(Hidden);

    const reports = context.select(ReportsModule);
    expect(reports).toBeInstanceOf(VelaApplicationContext);
    expect(reports.get(Report, { strict: true })).toBe(report);
    expect(reports.get(Repository, { strict: true })).toBe(context.get(Repository));
    expect(() => reports.get(Hidden, { strict: true })).toThrow(ModuleVisibilityError);
    expect(reports.get(Hidden)).toBe(context.get(Hidden));
    // The root context resolves strictly as the root module sees it.
    expect(() => context.get(Report, { strict: true })).toThrow(ModuleVisibilityError);
    await context.dispose();
  });

  it('selects keyed module instances by their DynamicModule', async () => {
    const NAME = new InjectionToken<string>('NAME');
    @Module({})
    class NamedModule {
      static named(name: string): DynamicModule {
        return {
          module: NamedModule,
          key: name,
          providers: [defineProvider(NAME, { useValue: name })],
          exports: [NAME],
        };
      }
    }
    const primary = NamedModule.named('primary');
    const secondary = NamedModule.named('secondary');
    @Module({ imports: [primary, secondary] })
    class AppModule {}
    const context = await VelaFactory.createApplicationContext(AppModule);

    expect(context.select(primary).get(NAME, { strict: true })).toBe('primary');
    expect(context.select(secondary).get(NAME, { strict: true })).toBe('secondary');
    expect(() => context.select(NamedModule)).toThrow(/NamedModule/);
    @Module({})
    class Unused {}
    expect(() => context.select(Unused)).toThrow(/Unused/);
    await context.dispose();
  });

  it('resolves transient providers anew and request-scoped ones only inside a scope', async () => {
    let created = 0;
    @Injectable({ scope: Scope.TRANSIENT })
    class Fresh {
      readonly id = ++created;
    }
    @Injectable({ scope: Scope.REQUEST })
    class PerCall {
      readonly id = ++created;
    }
    @Module({ providers: [Fresh, PerCall] })
    class AppModule {}
    const context = await VelaFactory.createApplicationContext(AppModule);

    const first = await context.resolve(Fresh);
    const second = await context.resolve(Fresh);
    expectTypeOf(first).toEqualTypeOf<Fresh>();
    expect(first).not.toBe(second);
    await expect(context.resolve(PerCall)).rejects.toThrow();
    const [inScope, again] = await runInEntrypointScope(context.getContainer(), async (scope) => [
      await context.resolve(PerCall, scope),
      await context.resolve(PerCall, scope),
    ]);
    expect(inScope).toBe(again);
    await context.dispose();
  });

  it('shares one lifecycle between an application context and its selections', async () => {
    const events: string[] = [];
    @Injectable()
    class Resource {
      onModuleDestroy() {
        events.push('destroy');
      }
    }
    @Module({ providers: [Resource], exports: [Resource] })
    class FeatureModule {}
    @Module({ imports: [FeatureModule] })
    class AppModule {}
    const context = await VelaFactory.createApplicationContext(AppModule);
    const feature = context.select(FeatureModule);
    await expect(feature.init()).resolves.toBe(feature);
    expect(feature.entrypoints).toBe(context.entrypoints);
    await feature.close();
    expect(events).toEqual(['destroy']);
    await context.dispose();
  });

  it('disposes the graph and rethrows when initialization fails', async () => {
    let disposed = 0;
    const failure = new Error('init failed');
    @Injectable()
    class Resource {
      [Symbol.dispose]() {
        disposed++;
      }
    }
    @Injectable()
    class Broken {
      constructor(@Inject(Resource) readonly resource: Resource) {}
      onModuleInit() {
        throw failure;
      }
    }
    @Module({ providers: [Resource, Broken] })
    class AppModule {}
    await expect(VelaFactory.createApplicationContext(AppModule)).rejects.toBe(failure);
    expect(disposed).toBe(1);
  });

  it('is the base of the HTTP application', async () => {
    @Module({ imports: [ReportsModule] })
    class AppModule {}
    const app = await VelaFactory.create(AppModule);
    expect(app).toBeInstanceOf(VelaApplicationContext);
    await expect(app.init()).resolves.toBe(app);
    const reports = app.select(ReportsModule);
    expectTypeOf(reports).toEqualTypeOf<VelaApplicationContext>();
    expect(reports.get(Report, { strict: true })).toBe(app.get(Report));
    await app.dispose();
  });
});
