import type { ModuleOptions, ProviderOptions, Token, Type } from '@velajs/vela';
import {
  ComponentManager,
  Container,
  MetadataRegistry,
  ModuleLoader,
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
    container.register({ provide: Container, useValue: container });

    // Register overrides BEFORE module loading so ModuleLoader skips originals.
    for (const override of this.overrides) {
      container.register(override.provider);
    }

    const routeManager = new RouteManager(container);
    ComponentManager.init(container);

    const loader = new ModuleLoader(container, routeManager);
    loader.load(TestRootModule);

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
