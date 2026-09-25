/* eslint-disable no-await-in-loop -- Lifecycle hooks run one instance at a time, in order. */
import type { Container } from './container/container';
import { ModuleRef, type ModuleRefContext } from './container/module-ref';
import type { InferToken, Token, Type } from './container/types';
import { defineProvider } from './container/types';
import { DiscoveryService } from './discovery/discovery.service';
import { EntrypointRegistry } from './entrypoint/entrypoint.registry';
import {
  hasBeforeApplicationShutdown,
  hasOnApplicationBootstrap,
  hasOnApplicationShutdown,
  hasOnModuleDestroy,
  hasOnModuleInit,
} from './lifecycle/index';
import { DEFAULT_MODULE_KEY, isDynamicModule } from './module/module-identity';
import { LazyModuleManager } from './module/lazy-modules';
import { ROOT_MODULE } from './module/root-module';
import type { DynamicModule } from './registry/types';

/** How {@link VelaApplicationContext.get} and `resolve` look a token up. */
export interface ApplicationContextLookupOptions {
  /**
   * `false` (default) looks the token up across the whole application.
   * `true` resolves only what the selected module can inject (the root module
   * for the application itself): its own providers, its imports' exports and
   * global tokens.
   */
  readonly strict?: boolean;
}

/** Nest's `NestApplicationContext`: the module graph, its lifecycle and DI, without HTTP. */
export class VelaApplicationContext {
  readonly #container: Container;
  // The context whose lifecycle a selection shares; itself for an application.
  readonly #root: VelaApplicationContext;
  // The module a `select()`ed context resolves strictly from.
  readonly #module: Type | DynamicModule | undefined;
  #moduleId: string | undefined;
  #instances: unknown[] = [];
  // Identity guard for the instance flow: a token registered by BOTH a lazy
  // and an eager module reaches us through the eager pass AND the absorbed
  // batch — without dedup its hooks would run twice.
  readonly #knownInstances = new Set<unknown>();
  readonly #lazyManager: LazyModuleManager | undefined;
  #entrypointRegistry: EntrypointRegistry | undefined;
  #initialization: Promise<void> | undefined;
  #disposal: Promise<void> | undefined;

  /**
   * Created by `VelaFactory`. `select()` passes the context whose lifecycle
   * the selection shares and the module it resolves strictly from.
   */
  constructor(
    container: Container,
    selection?: { readonly root: VelaApplicationContext; readonly module: Type | DynamicModule },
  ) {
    this.#container = container;
    this.#root = selection?.root ?? this;
    this.#module = selection?.module;
    if (selection) return;
    // bootstrap() registers the manager; a hand-built container may not have
    // one (container unit tests) — lazy semantics simply don't engage then.
    this.#lazyManager = container.has(LazyModuleManager)
      ? container.resolve(LazyModuleManager)
      : undefined;
    // Live-phase materializations join the instance flow so close()/dispose()
    // run shutdown hooks over them (LIFO — appended last, destroyed first).
    this.#lazyManager?.setOnMaterialized((instances) => {
      this.#instances.push(...this.#trackNew(instances));
    });
  }

  #trackNew(batch: unknown[]): unknown[] {
    const fresh = batch.filter((i) => !this.#knownInstances.has(i));
    for (const i of fresh) this.#knownInstances.add(i);
    return fresh;
  }

  getContainer(): Container {
    return this.#container;
  }

  getInstances(): unknown[] {
    return this.#root.#instances;
  }

  setInstances(instances: unknown[]): void {
    const root = this.#root;
    root.#instances = instances;
    root.#knownInstances.clear();
    for (const i of instances) root.#knownInstances.add(i);
  }

  /**
   * Return a singleton (or value) provider. Request-scoped providers (declared
   * or bubbled) have no root instance and throw; resolve them in an execution
   * scope with {@link resolve}. `{ strict: true }` resolves as the selected
   * module sees it.
   */
  get<K extends Token>(token: K, options: ApplicationContextLookupOptions = {}): InferToken<K> {
    return this.#container.resolve(token, options.strict ? this.#selectedModuleId() : undefined);
  }

  /**
   * Resolve any provider, awaiting async factories. Transient providers are
   * constructed anew on each call; request-scoped providers resolve in the
   * execution scope `context` identifies (an `ExecutionContext`, a
   * Vela-managed Hono `Context`, or an execution-scope container), and throw
   * without one.
   */
  resolve<K extends Token>(
    token: K,
    context?: ModuleRefContext,
    options: ApplicationContextLookupOptions = {},
  ): Promise<InferToken<K>> {
    const strict = options.strict === true;
    const moduleRef = new ModuleRef(this.#container, strict ? this.#selectedModuleId() : '');
    return moduleRef.resolve(token, context, { strict });
  }

  /**
   * A context over one module instance of this application: `get`/`resolve`
   * with `{ strict: true }` resolve as that module sees them. It shares this
   * application's lifecycle. Pass the `DynamicModule` to select one keyed
   * instance of a module imported several times.
   */
  select(module: Type | DynamicModule): VelaApplicationContext {
    const selected = new VelaApplicationContext(this.#container, { root: this.#root, module });
    selected.#moduleId = moduleIdOf(this.#container, module);
    return selected;
  }

  #selectedModuleId(): string {
    this.#moduleId ??= moduleIdOf(
      this.#container,
      this.#module ?? this.#container.resolve(ROOT_MODULE),
    );
    return this.#moduleId;
  }

  /**
   * Run `onModuleInit` and `onApplicationBootstrap` once and assemble the
   * entrypoints. `VelaFactory` initializes every context it creates, so this
   * resolves at once for them.
   */
  async init(): Promise<this> {
    const root = this.#root;
    root.#initialization ??= (async () => {
      await root.callOnModuleInit();
      await root.callOnApplicationBootstrap();
    })();
    await root.#initialization;
    return this;
  }

  /**
   * Pull instances materialized during the bootstrap phase (lazy modules
   * dragged in by eager consumers) into the front of the instance list —
   * dependency-before-consumer: a group absorbed because an eager provider
   * injected it must be initialized before that consumer's hooks read it.
   */
  #absorbLazyInstances(prepend: boolean): unknown[] {
    const batch = this.#trackNew(this.#lazyManager?.takeAbsorbed() ?? []);
    if (batch.length === 0) return batch;
    if (prepend) {
      this.#instances = [...batch, ...this.#instances];
    } else {
      this.#instances.push(...batch);
    }
    return batch;
  }

  async callOnModuleInit(): Promise<void> {
    const root = this.#root;
    root.#absorbLazyInstances(true);
    // Index loop: hooks can trigger further absorptions, which append —
    // the loop naturally covers them.
    for (let i = 0; i < root.#instances.length; i++) {
      const instance = root.#instances[i];
      if (hasOnModuleInit(instance)) {
        await instance.onModuleInit();
      }
      root.#absorbLazyInstances(false);
    }
  }

  async callOnApplicationBootstrap(): Promise<void> {
    const root = this.#root;
    for (let i = 0; i < root.#instances.length; i++) {
      const instance = root.#instances[i];
      if (hasOnApplicationBootstrap(instance)) {
        await instance.onApplicationBootstrap();
      }
      // Instances absorbed mid-phase already missed the init pass — run
      // onModuleInit now; the loop then reaches them for the bootstrap hook.
      for (const late of root.#absorbLazyInstances(false)) {
        if (hasOnModuleInit(late)) await late.onModuleInit();
      }
    }

    // Computed-entrypoint contributors (ContributesEntrypoints) in lazy
    // modules must exist before the snapshot below — materialize them now
    // (the documented cost of contributing computed entrypoints), then run
    // their hooks through the same absorb loop.
    const lazyManager = root.#lazyManager;
    if (lazyManager) {
      await lazyManager.materializeContributors();
      let batch: unknown[];
      while ((batch = root.#absorbLazyInstances(false)).length > 0) {
        for (const late of batch) {
          if (hasOnModuleInit(late)) await late.onModuleInit();
        }
        for (const late of batch) {
          if (hasOnApplicationBootstrap(late)) await late.onApplicationBootstrap();
        }
      }
      // From here on, materializations replay their hooks at the trigger.
      lazyManager.setPhaseLive();
    }

    // Build the per-app entrypoint registry AFTER the hooks: dispatchers that
    // implement ContributesEntrypoints (WsDispatcher) finish their own
    // discovery inside onApplicationBootstrap. Built here — not with the
    // HTTP routes — so contexts that never build routes (a Durable Object's)
    // still get `entrypoints`. Lazy-pending providers of declared kinds yield
    // metadata-only entries (instance: undefined) — dispatchers re-resolve by
    // token per event, which materializes the owning module at dispatch time.
    const container = this.#container;
    const discovery = container.has(DiscoveryService)
      ? container.resolve(DiscoveryService)
      : new DiscoveryService(container);
    const registry = await EntrypointRegistry.build(discovery, root.#instances, {
      deferLazy: true,
    });
    root.#entrypointRegistry = registry;

    // Make the per-app registry injectable (global token): providers that
    // dispatch entrypoints themselves (the queue module's in-process driver
    // binding) resolve it instead of needing a back-reference to the app.
    // Registered AFTER build so anything resolving it sees the final registry;
    // pre-bootstrap resolution attempts fail the `has()` probe and defer.
    container.register(defineProvider(EntrypointRegistry, { useValue: registry }));
    container.markGlobalToken(EntrypointRegistry);
  }

  /**
   * Materialize every still-pending lazy module (async-safe): construct the
   * groups, replay their lifecycle hooks, and add their instances to the
   * shutdown flow. Warmup escape hatch for tests and node runtimes that want
   * eager-everything semantics back after bootstrap.
   */
  async materializeLazyModules(): Promise<void> {
    await this.#root.#lazyManager?.materializeAll();
  }

  /**
   * Every entrypoint contributed by the module graph, grouped by kind —
   * what runtime adapters/transports query instead of re-scanning providers:
   * `app.entrypoints.ofKind('websocket')`.
   */
  get entrypoints(): EntrypointRegistry {
    const registry = this.#root.#entrypointRegistry;
    if (!registry) {
      throw new Error(
        'Entrypoints are not built yet — they are assembled at the end of ' +
          'callOnApplicationBootstrap(). Finish bootstrapping before querying them.',
      );
    }
    return registry;
  }

  /** Run the shutdown lifecycle hooks (`beforeApplicationShutdown`, `onModuleDestroy`, `onApplicationShutdown`). */
  async close(signal?: string): Promise<void> {
    const reversed = this.#root.#instances.toReversed();

    for (const instance of reversed) {
      if (hasBeforeApplicationShutdown(instance)) {
        await instance.beforeApplicationShutdown(signal);
      }
    }

    for (const instance of reversed) {
      if (hasOnModuleDestroy(instance)) {
        await instance.onModuleDestroy();
      }
    }

    for (const instance of reversed) {
      if (hasOnApplicationShutdown(instance)) {
        await instance.onApplicationShutdown(signal);
      }
    }
  }

  /**
   * Full teardown: run shutdown lifecycle hooks ({@link close}) then dispose
   * container-held instances (LIFO) and clear cached singletons. Use for
   * graceful shutdown and dev HMR so old and new DI graphs never coexist.
   *
   * On runtimes/TS supporting explicit resource management this is also exposed
   * as `Symbol.asyncDispose`, enabling `await using app = await VelaFactory.create(...)`.
   */
  dispose(signal?: string): Promise<void> {
    const root = this.#root;
    // Share completion, including a failure, with every concurrent shutdown caller.
    root.#disposal ??= Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      try {
        await root.close(signal);
      } catch (error) {
        failures.push(error);
      }
      try {
        await root.#container.dispose();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, 'Application cleanup failed', {
          cause: failures[0],
        });
      return undefined;
    });
    return root.#disposal;
  }
}

/** The id of the one module instance `module` names in the container's graph. */
function moduleIdOf(container: Container, module: Type | DynamicModule): string {
  const moduleClass = isDynamicModule(module) ? module.module : module;
  const key = isDynamicModule(module) ? (module.key ?? DEFAULT_MODULE_KEY) : undefined;
  const instances: { moduleId: string; key: string }[] = [];
  for (const { moduleId } of container.getModuleDescriptions()) {
    const scope = container.getModuleScope(moduleId);
    if (scope?.moduleClass === moduleClass) {
      instances.push({ moduleId, key: scope.moduleKey ?? DEFAULT_MODULE_KEY });
    }
  }
  const withKey = (wanted: string) => instances.filter((instance) => instance.key === wanted);
  // A bare class names its only instance, or its unkeyed one among several.
  const candidates =
    key !== undefined
      ? withKey(key)
      : instances.length > 1 && withKey(DEFAULT_MODULE_KEY).length === 1
        ? withKey(DEFAULT_MODULE_KEY)
        : instances;
  const [found, ...others] = candidates;
  if (found && others.length === 0) return found.moduleId;
  const name = moduleClass.name || 'the module';
  throw new Error(
    others.length > 0
      ? `${name} is imported with several keys; select one by the DynamicModule that imports it.`
      : `${name} is not part of this application's module graph.`,
  );
}

// Attach the well-known async-dispose symbol at runtime (it is not in the
// ES2022 lib the project compiles against) so `await using` works where
// supported, without a type dependency on esnext.disposable.
const ASYNC_DISPOSE: symbol | undefined = (Symbol as { asyncDispose?: symbol }).asyncDispose;
if (ASYNC_DISPOSE) {
  (VelaApplicationContext.prototype as unknown as Record<PropertyKey, unknown>)[ASYNC_DISPOSE] =
    function (this: VelaApplicationContext): Promise<void> {
      return this.dispose();
    };
}
