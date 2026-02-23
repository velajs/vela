import {
  Container,
  RouteManager,
  ModuleLoader,
  ComponentManager,
  VelaApplication,
  APP_GUARD,
  APP_PIPE,
  APP_INTERCEPTOR,
  APP_FILTER,
  APP_MIDDLEWARE,
} from '@velajs/vela';
import type { Token, Type, ProviderOptions } from '@velajs/vela';
import { TestingModule } from './testing-module.js';

interface FactoryProvider {
  factory: (...args: unknown[]) => unknown;
  inject?: Token[];
}

interface Override {
  token: Token;
  provider: ProviderOptions;
}

class OverrideByImpl {
  constructor(
    private readonly builder: TestingModuleBuilder,
    private readonly token: Token,
    private readonly overrides: Override[],
  ) {}

  useValue(value: unknown): TestingModuleBuilder {
    this.overrides.push({
      token: this.token,
      provider: { token: this.token, useValue: value },
    });
    return this.builder;
  }

  useClass(cls: Type): TestingModuleBuilder {
    // Container.registerOptions doesn't read useClass from ProviderOptions,
    // so we use useFactory to instantiate the replacement class.
    this.overrides.push({
      token: this.token,
      provider: { token: this.token, useFactory: () => new cls() },
    });
    return this.builder;
  }

  useFactory(options: FactoryProvider): TestingModuleBuilder {
    this.overrides.push({
      token: this.token,
      provider: {
        token: this.token,
        useFactory: options.factory,
        inject: options.inject,
      } as ProviderOptions,
    });
    return this.builder;
  }
}

export class TestingModuleBuilder {
  private overrides: Override[] = [];

  constructor(private readonly rootModule: Type) {}

  overrideProvider(token: Token): OverrideByImpl {
    return new OverrideByImpl(this, token, this.overrides);
  }

  overrideGuard(guard: Type): OverrideByImpl {
    return this.overrideProvider(guard);
  }

  overrideInterceptor(interceptor: Type): OverrideByImpl {
    return this.overrideProvider(interceptor);
  }

  overrideFilter(filter: Type): OverrideByImpl {
    return this.overrideProvider(filter);
  }

  overridePipe(pipe: Type): OverrideByImpl {
    return this.overrideProvider(pipe);
  }

  async compile(): Promise<TestingModule> {
    const container = new Container();
    const routeManager = new RouteManager(container);
    ComponentManager.init(container);

    const loader = new ModuleLoader(container, routeManager);
    loader.load(this.rootModule);

    // Apply overrides — re-register overwrites existing entries in the Map
    for (const override of this.overrides) {
      container.register(override.provider);
    }

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

    // Routes are NOT built here — deferred to createApplication()
    return new TestingModule(app, container);
  }
}
