import {
  defineProvider,
  type CanActivate,
  type DependencyToken,
  type ExceptionFilter,
  type InferToken,
  type InferTokens,
  type ModuleOptions,
  type NestInterceptor,
  type PipeTransform,
  type ProviderDefinition,
  type Token,
  type Type,
} from '@velajs/vela';
import { MetadataRegistry, bootstrap, finalizeApplication } from '@velajs/vela/internal';
import { TestingModule } from './testing-module.js';

interface OverrideEntry {
  token: Token;
  provider: ProviderDefinition;
}

// Keep the same token proof required by core provider authoring. An erased
// registry identity can be resolved, but cannot authorize a typed replacement.
type OverrideToken<Key extends Token> = Parameters<typeof defineProvider<Key>>[0];

export class OverrideBy<Key extends Token> {
  constructor(
    private readonly commit: (provider: ProviderDefinition) => TestingModuleBuilder,
    private readonly token: OverrideToken<Key>,
  ) {}

  useValue(value: NoInfer<InferToken<Key>>): TestingModuleBuilder {
    return this.commit(defineProvider<Key>(this.token, { useValue: value }));
  }

  useClass(cls: Type<NoInfer<InferToken<Key>>>): TestingModuleBuilder {
    return this.commit(defineProvider<Key>(this.token, { useClass: cls }));
  }

  useFactory<const Inject extends readonly DependencyToken[] = readonly []>(options: {
    factory: (
      ...args: InferTokens<Inject>
    ) => NoInfer<InferToken<Key>> | Promise<NoInfer<InferToken<Key>>>;
    inject: Inject;
  }): TestingModuleBuilder {
    return this.commit(
      defineProvider<Key, Inject>(this.token, {
        useFactory: options.factory,
        inject: options.inject,
      }),
    );
  }
}

export class TestingModuleBuilder {
  #overrides: OverrideEntry[] = [];
  readonly #metadata: ModuleOptions;

  constructor(metadata: ModuleOptions) {
    this.#metadata = metadata;
  }

  overrideProvider<const Key extends Token>(token: OverrideToken<Key>): OverrideBy<Key> {
    return new OverrideBy<Key>((provider) => {
      this.addOverride({ token, provider });
      return this;
    }, token);
  }

  overrideGuard<const Guard extends Type<CanActivate>>(
    guard: OverrideToken<Guard>,
  ): OverrideBy<Guard> {
    return this.overrideProvider<Guard>(guard);
  }

  overridePipe<const Pipe extends Type<PipeTransform>>(
    pipe: OverrideToken<Pipe>,
  ): OverrideBy<Pipe> {
    return this.overrideProvider<Pipe>(pipe);
  }

  overrideInterceptor<const Interceptor extends Type<NestInterceptor>>(
    interceptor: OverrideToken<Interceptor>,
  ): OverrideBy<Interceptor> {
    return this.overrideProvider<Interceptor>(interceptor);
  }

  overrideFilter<const Filter extends Type<ExceptionFilter>>(
    filter: OverrideToken<Filter>,
  ): OverrideBy<Filter> {
    return this.overrideProvider<Filter>(filter);
  }

  private addOverride(entry: OverrideEntry): void {
    const idx = this.#overrides.findIndex((o) => o.token === entry.token);
    if (idx !== -1) {
      this.#overrides[idx] = entry;
    } else {
      this.#overrides.push(entry);
    }
  }

  async compile(): Promise<TestingModule> {
    class TestRootModule {}
    MetadataRegistry.setModuleOptions(TestRootModule, {
      imports: this.#metadata.imports,
      providers: this.#metadata.providers,
      controllers: this.#metadata.controllers,
      exports: this.#metadata.exports,
    });

    // Use the framework's single bootstrap primitive. Hand-copying its
    // registrations caused test applications to drift from production (most
    // critically REQUEST_CONTEXT token/request-child behavior).
    const prepared = await bootstrap(TestRootModule);
    const { container } = prepared;

    // Force-apply overrides into every module bucket that already holds the
    // token (plus root). Without this, controller constructor-injection (which
    // passes requestingModuleId to findRegistration) finds the module's own
    // registration first and never consults the root override. The default
    // 'all-existing' buckets replace every non-root bucket holding the token
    // and re-register at root — the supported form of the old private loop.
    for (const override of this.#overrides) {
      container.replaceProvider(override.provider);
    }

    const app = await finalizeApplication(prepared);

    return new TestingModule(app, container);
  }
}
