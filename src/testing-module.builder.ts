import { type ModuleOptions, type ProviderOptions, type Token, type Type } from '@velajs/vela';
import { MetadataRegistry, VelaApplication, bootstrap } from '@velajs/vela/internal';
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

    // Use the framework's single bootstrap primitive. Hand-copying its
    // registrations caused test applications to drift from production (most
    // critically REQUEST_CONTEXT token/request-child behavior).
    const { container, routeManager, loader } = await bootstrap(TestRootModule);

    // Force-apply overrides into every module bucket that already holds the
    // token (plus root). Without this, controller constructor-injection (which
    // passes requestingModuleId to findRegistration) finds the module's own
    // registration first and never consults the root override. The default
    // 'all-existing' buckets replace every non-root bucket holding the token
    // and re-register at root — the supported form of the old private loop.
    for (const override of this.overrides) {
      container.replaceProvider(override.provider);
    }

    const app = new VelaApplication(container, routeManager);
    const instances = await loader.resolveAllInstances();
    app.setInstances(instances);

    await app.callOnModuleInit();
    await app.callOnApplicationBootstrap();
    await app.initRoutes();

    return new TestingModule(app, container);
  }
}
