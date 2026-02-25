import { VelaApplication } from '../application';
import { METADATA_KEYS } from '../constants';
import { Container } from '../container/container';
import type { ProviderOptions, Token, Type } from '../container/types';
import { RouteManager } from '../http/route.manager';
import { defineMetadata } from '../metadata';
import { ModuleLoader } from '../module/module-loader';
import type { ModuleOptions } from '../module/types';
import { ComponentManager } from '../pipeline/component.manager';
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_MIDDLEWARE,
  APP_PIPE,
} from '../pipeline/tokens';
import { MetadataRegistry } from '../registry/metadata.registry';
import { TestingModule } from './testing.module';

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
    this.builder['addOverride']({ token: this.token, provider: { token: this.token, useValue: value } });
    return this.builder;
  }

  useClass(cls: Type): TestingModuleBuilder {
    this.builder['addOverride']({ token: this.token, provider: { token: this.token, useFactory: () => new cls() } });
    return this.builder;
  }

  useFactory(options: { factory: (...args: unknown[]) => unknown; inject?: Token[] }): TestingModuleBuilder {
    this.builder['addOverride']({
      token: this.token,
      provider: { token: this.token, useFactory: options.factory, inject: options.inject },
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
    // Replace existing override for same token if any
    const idx = this.overrides.findIndex((o) => o.token === entry.token);
    if (idx !== -1) {
      this.overrides[idx] = entry;
    } else {
      this.overrides.push(entry);
    }
  }

  async compile(): Promise<TestingModule> {
    // Create a temporary module class with the provided metadata
    class TestRootModule {}
    MetadataRegistry.setModuleOptions(TestRootModule, {
      imports: this.metadata.imports,
      providers: this.metadata.providers,
      controllers: this.metadata.controllers,
      exports: this.metadata.exports,
    });
    defineMetadata(METADATA_KEYS.MODULE, true, TestRootModule);

    // Bootstrap (mirrors VelaFactory.create)
    const container = new Container();
    container.register({ token: Container, useValue: container });

    // Register overrides BEFORE module loading so ModuleLoader skips originals
    for (const override of this.overrides) {
      container.register(override.provider);
    }

    const routeManager = new RouteManager(container);
    ComponentManager.init(container);

    const loader = new ModuleLoader(container, routeManager);
    loader.load(TestRootModule);

    // Resolve APP_* tokens
    if (container.has(APP_GUARD)) {
      routeManager.useGlobalGuards(container.resolve(APP_GUARD));
    }
    if (container.has(APP_PIPE)) {
      routeManager.useGlobalPipes(container.resolve(APP_PIPE));
    }
    if (container.has(APP_INTERCEPTOR)) {
      routeManager.useGlobalInterceptors(container.resolve(APP_INTERCEPTOR));
    }
    if (container.has(APP_FILTER)) {
      routeManager.useGlobalFilters(container.resolve(APP_FILTER));
    }
    if (container.has(APP_MIDDLEWARE)) {
      routeManager.useGlobalMiddleware(container.resolve(APP_MIDDLEWARE));
    }

    const app = new VelaApplication(container, routeManager);
    const instances = loader.resolveAllInstances();
    app.setInstances(instances);

    await app.callOnModuleInit();
    await app.callOnApplicationBootstrap();
    await app.initRoutes();

    return new TestingModule(app);
  }
}

export class Test {
  static createTestingModule(metadata: ModuleOptions): TestingModuleBuilder {
    return new TestingModuleBuilder(metadata);
  }
}
