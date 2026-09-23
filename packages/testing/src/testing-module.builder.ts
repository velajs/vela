import {
  defineProvider,
  type CanActivate,
  type DependencyToken,
  type ExceptionFilter,
  type FactoryInject,
  type InferToken,
  type InferTokens,
  type ModuleOptions,
  type NestInterceptor,
  type PipeTransform,
  type ProviderDefinition,
  type RuntimeAdapter,
  type Token,
  type Type,
  type VelaEnv,
} from '@velajs/vela';
import {
  MetadataRegistry,
  applyRuntimeAdapters,
  bootstrap,
  finalizeApplication,
} from '@velajs/vela/internal';
import { TestingModule } from './testing-module.js';

/** Runtime inputs for a testing module, as `VelaFactory.create` takes them. */
export interface TestingModuleOptions {
  /**
   * Seeded as the application's ENV (bindings, variables, secrets), and sent
   * as `c.env` with every request from `fetch()` and the HTTP and SSE builders.
   * Pass the same object to an adapter that binds requests to it, such as
   * `cloudflareAdapter({ env })`.
   */
  env?: VelaEnv;
  /** Runtime adapters bound exactly as in production. */
  adapters?: RuntimeAdapter[];
}

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

  /** A factory without parameters may omit `inject`. */
  useFactory<const Inject extends readonly DependencyToken[] = readonly []>(
    options: {
      factory: (
        ...args: InferTokens<Inject>
      ) => NoInfer<InferToken<Key>> | Promise<NoInfer<InferToken<Key>>>;
    } & FactoryInject<Inject>,
  ): TestingModuleBuilder {
    return this.commit(
      defineProvider<Key, Inject>(this.token, { ...options, useFactory: options.factory }),
    );
  }
}

export class TestingModuleBuilder {
  #overrides: OverrideEntry[] = [];
  readonly #metadata: ModuleOptions;
  readonly #options: TestingModuleOptions;

  constructor(metadata: ModuleOptions, options: TestingModuleOptions = {}) {
    this.#metadata = metadata;
    this.#options = options;
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
    // critically REQUEST_CONTEXT token/request-child behavior). ENV and
    // runtime adapters bind through the same path as VelaFactory.create.
    const { env, adapters = [] } = this.#options;
    const prepared = await bootstrap(TestRootModule, applyRuntimeAdapters({ env }, adapters));
    const { container } = prepared;

    // Force-apply overrides into every module bucket that already holds the
    // token (plus root). Without this, controller constructor-injection (which
    // passes requestingModuleId to findRegistration) finds the module's own
    // registration first and never consults the root override. The default
    // 'all-existing' buckets replace every non-root bucket holding the token
    // and re-register at root — the supported form of the old private loop.
    // An ENV override lands at root, where the global ENV is read.
    for (const override of this.#overrides) {
      container.replaceProvider(override.provider);
    }

    const app = await finalizeApplication(prepared, adapters);

    return new TestingModule(app, container, env);
  }
}
