import {
  REQUEST_CONTEXT,
  Scope,
  type ModuleOptions,
  type ProviderOptions,
  type Token,
  type Type,
} from '@velajs/vela';
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_MIDDLEWARE,
  APP_PIPE,
  ComponentManager,
  Container,
  MetadataRegistry,
  ModuleLoader,
  ModuleRef,
  RouteManager,
  VelaApplication,
  bindAppProviders,
} from '@velajs/vela/internal';
import { TestingModule } from './testing-module.js';

interface OverrideEntry {
  token: Token;
  provider: ProviderOptions;
}

export class OverrideBy {
  constructor(
    private readonly builder: TestingModuleBuilder,
    private readonly token: Token,
  ) {}

  useValue(value: unknown): TestingModuleBuilder {
    this.builder['addOverride']({
      token: this.token,
      provider: { provide: this.token, useValue: value },
    });
    return this.builder;
  }

  useClass(cls: Type): TestingModuleBuilder {
    this.builder['addOverride']({
      token: this.token,
      provider: { provide: this.token, useClass: cls },
    });
    return this.builder;
  }

  useFactory(options: {
    factory: (...args: unknown[]) => unknown;
    inject?: Token[];
  }): TestingModuleBuilder {
    this.builder['addOverride']({
      token: this.token,
      provider: {
        provide: this.token,
        useFactory: options.factory,
        inject: options.inject,
      },
    });
    return this.builder;
  }
}

export class TestingModuleBuilder {
  private overrides: OverrideEntry[] = [];

  constructor(private readonly metadata: ModuleOptions) {}

  overrideProvider(token: Token): OverrideBy {
    return new OverrideBy(this, token);
  }

  overrideGuard(guard: Type): OverrideBy {
    return new OverrideBy(this, guard);
  }

  overridePipe(pipe: Type): OverrideBy {
    return new OverrideBy(this, pipe);
  }

  overrideInterceptor(interceptor: Type): OverrideBy {
    return new OverrideBy(this, interceptor);
  }

  overrideFilter(filter: Type): OverrideBy {
    return new OverrideBy(this, filter);
  }

  private addOverride(entry: OverrideEntry): void {
    const idx = this.overrides.findIndex((o) => o.token === entry.token);
    if (idx !== -1) {
      this.overrides[idx] = entry;
    } else {
      this.overrides.push(entry);
    }
  }

  async compile(): Promise<TestingModule> {
    class TestRootModule {}
    MetadataRegistry.setModuleOptions(TestRootModule, {
      imports: this.metadata.imports,
      providers: this.metadata.providers,
      controllers: this.metadata.controllers,
      exports: this.metadata.exports,
    });

    const container = new Container();

    // Replicate bootstrap()'s global token setup so request-pipeline tests
    // can resolve REQUEST_CONTEXT, ModuleRef, and the APP_* sentinel tokens
    // from any module scope. Without this, guards / decorators that inject
    // REQUEST_CONTEXT through ExecutionContext fail with "no provider"
    // when the request enters the pipeline. See vela/src/factory/bootstrap.ts.
    container.register({ provide: Container, useValue: container });
    container.markGlobalToken(Container);

    container.register({
      provide: ModuleRef,
      useFactory: (c: Container) => new ModuleRef(c),
      inject: [Container],
    });
    container.markGlobalToken(ModuleRef);

    for (const t of [APP_GUARD, APP_PIPE, APP_INTERCEPTOR, APP_FILTER, APP_MIDDLEWARE]) {
      container.markGlobalToken(t);
    }

    // REQUEST_CONTEXT is seeded into each per-request child container by
    // RouteManager via setRequestInstance. Registering with a throw-factory
    // here ensures findRegistration succeeds (so the child's cached request
    // instance is returned) while surfacing a clear error if the token is
    // ever resolved outside the request path.
    container.register({
      provide: REQUEST_CONTEXT,
      scope: Scope.REQUEST,
      useFactory: () => {
        throw new Error(
          'REQUEST_CONTEXT can only be resolved inside a request — ' +
            'it is seeded by RouteManager when the request enters the pipeline.',
        );
      },
    });
    container.markGlobalToken(REQUEST_CONTEXT);

    // Pre-register at root so `moduleRef.get(token)` and framework-internal
    // resolves (instantiate(guard, container) with no requestingModuleId) see
    // the override immediately.
    for (const override of this.overrides) {
      container.register(override.provider);
    }

    const routeManager = new RouteManager(container);
    ComponentManager.init(container);

    const loader = new ModuleLoader(container, routeManager);
    loader.load(TestRootModule);

    // Force-apply overrides into every module bucket that already holds the
    // token. Without this, controller constructor-injection (which passes
    // requestingModuleId to findRegistration) finds the module's own
    // registration first and never consults the root override. Re-registering
    // with the module's id overwrites the bucket entry.
    //
    // Reaches into Container internals (the `providers` map) until vela
    // exposes a public "force replace across all scopes" API. The shape is
    // stable in vela 1.6.x; if this breaks under a future vela version, raise
    // a vela API request before working around again.
    const providersMap = (
      container as unknown as {
        providers: Map<string, Map<Token, unknown>>;
      }
    ).providers;
    for (const override of this.overrides) {
      for (const [moduleId, bucket] of providersMap) {
        if (moduleId === '__root__') continue;
        if (bucket.has(override.token)) {
          container.register(override.provider, moduleId);
        }
      }
    }

    bindAppProviders(routeManager, container, loader);

    const app = new VelaApplication(container, routeManager);
    const instances = await loader.resolveAllInstances();
    app.setInstances(instances);

    await app.callOnModuleInit();
    await app.callOnApplicationBootstrap();
    await app.initRoutes();

    return new TestingModule(app, container);
  }
}
