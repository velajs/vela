import {
  defineProvider,
  type CanActivate,
  type DependencyToken,
  type DynamicModule,
  type ExceptionFilter,
  type ModuleOptions,
  type NestInterceptor,
  type PipeTransform,
  type ProviderDefinition,
  type Token,
  type Type,
  type VelaCreateOptions,
} from '@velajs/vela';
import type { FactoryInject, InferToken, InferTokens } from '@velajs/vela/module-kit';
import { applyRuntimeAdapters, bootstrap, finalizeApplication } from '@velajs/vela/internal';
import { MetadataRegistry } from '@velajs/vela/module-kit';
import { TestingModule } from './testing-module.js';

/**
 * Runtime inputs for a testing module: exactly what `VelaFactory.create`
 * takes. `env` is seeded as the application's ENV (bindings, variables,
 * secrets) and sent as `c.env` with every request from `fetch()` and the HTTP
 * and SSE builders; pass the same object to an adapter that binds requests to
 * it, such as `cloudflareAdapter({ env })`. Runtime adapters, the global
 * prefix, security options and middleware apply as in production.
 */
export interface TestingModuleOptions extends VelaCreateOptions {}

/** Supplies a value for a dependency no provider satisfies (see `useMocker`). */
export type MockFactory = (token: Token) => unknown;

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

/** The replacement half of `overrideModule(module)`. */
export class OverrideModule {
  constructor(
    private readonly commit: (replacement: Type | DynamicModule) => TestingModuleBuilder,
  ) {}

  /** Load `replacement` wherever the graph imports the overridden module. */
  useModule(replacement: Type | DynamicModule): TestingModuleBuilder {
    return this.commit(replacement);
  }
}

export class TestingModuleBuilder {
  #overrides: OverrideEntry[] = [];
  readonly #moduleOverrides = new Map<Type | DynamicModule, Type | DynamicModule>();
  #mocker: MockFactory | undefined;
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

  /**
   * Replace a module wherever the graph imports it: the class itself, any
   * `DynamicModule` of that class, or exactly the `DynamicModule` object
   * passed. The module's metadata is not modified.
   */
  overrideModule(module: Type | DynamicModule): OverrideModule {
    return new OverrideModule((replacement) => {
      this.#moduleOverrides.set(module, replacement);
      return this;
    });
  }

  /**
   * Supply the dependencies no provider satisfies. `mocker(token)` runs once
   * per missing token, before anything is constructed, and its value is
   * registered in each module that injects the token; optional parameters and
   * provided or overridden tokens never reach it. A falsy result supplies
   * nothing: the token stays unresolved and `compile()` rejects with
   * `UnresolvedDependencyError`, as in Nest.
   */
  useMocker(mocker: MockFactory): this {
    this.#mocker = mocker;
    return this;
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
    const { adapters = [], ...options } = this.#options;
    const prepared = await bootstrap(TestRootModule, applyRuntimeAdapters(options, adapters), {
      moduleOverrides: this.#moduleOverrides,
    });
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
    // After the overrides, so only what nothing provides is mocked.
    if (this.#mocker) container.supplyMissingDependencies(this.#mocker);

    const app = await finalizeApplication(prepared, adapters);

    return new TestingModule(app, container, options.env);
  }
}
