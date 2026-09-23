import { Scope } from '../constants';
import { Container } from '../container/container';
import { DiscoveryService } from '../discovery/discovery.service';
import type { Diagnostics, Type } from '../container/types';
import { defineProvider } from '../container/types';
import { InternalDispatcher } from '../dispatch/internal-dispatcher';
import { MemoryNonceStore } from '../dispatch/nonce-store';
import { SignedInvocationGuard } from '../dispatch/signed-invocation.guard';
import { NONCE_STORE } from '../dispatch/tokens';
import { EXECUTION_LIFETIME } from '../entrypoint/execution-scope';
import { ENV, assertEnvironment } from '../env';
import type { VelaEnv } from '../env';
import { REQUEST_CONTEXT } from '../http/request-context';
import { RouteManager } from '../http/route.manager';
import type { RouteManagerOptions } from '../http/route.manager';
import { UrlGeneratorService } from '../http/url/url-generator.service';
import { SignedUrlGuard } from '../http/url/signed-url.guard';
import { ModuleLoader } from '../module/module-loader';
import { ROOT_MODULE } from '../module/root-module';
import type { DynamicModule } from '../registry/types';
import { bindAppProviders } from '../pipeline/app-providers';
import { Reflector } from '../pipeline/reflector';
import {
  APP_EXCEPTION_HANDLER,
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_MIDDLEWARE,
  APP_PIPE,
  ERROR_CATALOG,
} from '../pipeline/tokens';
import type { NestMiddleware } from '../pipeline/types';

export interface BootstrapOptions extends RouteManagerOptions {
  diagnostics?: Diagnostics;
  /**
   * The runtime environment seeded as {@link ENV}: bindings, variables and
   * secrets. Runtime-neutral; a Node host may pass `process.env` from its own
   * entrypoint. Runtime adapters may seed ENV in `configureContainer` instead.
   */
  env?: VelaEnv;
  /** Configure platform/application providers before modules load or construct providers. */
  configureContainer?(container: Container): void | Promise<void>;
}

export interface BootstrapResult {
  container: Container;
  routeManager: RouteManager;
  loader: ModuleLoader;
}

/**
 * Wire the DI graph for `rootModule` (a module class or a `DynamicModule`) and
 * prepare the route manager — without running lifecycle hooks or building the
 * Hono app. The single primitive shared by `VelaFactory.create` (HTTP),
 * `@velajs/testing` (test), and any non-HTTP consumer (CLI tools, custom
 * runtimes).
 *
 * Framework-internal tokens (`Container`, `ROOT_MODULE`, `APP_*`) are marked
 * global so they are resolvable from any module. `ModuleRef` needs no
 * registration: the container builds one per injecting module.
 */
export async function bootstrap(
  rootModule: Type | DynamicModule,
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const container = new Container({
    diagnostics: options.diagnostics,
  });

  container.register(defineProvider(Container, { useValue: container }));
  container.markGlobalToken(Container);
  container.register(defineProvider(ROOT_MODULE, { useValue: rootModule }));
  container.markGlobalToken(ROOT_MODULE);

  // ENV is global but has no default: seeded here from `options.env`, or by a
  // runtime adapter's configureContainer below. Readers of optional values
  // (signing secrets, Studio) inject it with @Optional().
  if (options.env !== undefined) {
    assertEnvironment(options.env);
    container.register(defineProvider(ENV, { useValue: options.env }));
  }
  container.markGlobalToken(ENV);

  // Decorator-driven discovery — global so any provider can inject it.
  container.register(
    defineProvider(DiscoveryService, {
      useFactory: (c) => new DiscoveryService(c),
      inject: [Container],
    }),
  );
  container.markGlobalToken(DiscoveryService);

  // Stateless metadata reader for guards and interceptors, as in Nest.
  container.register(Reflector);
  container.markGlobalToken(Reflector);

  for (const t of [
    APP_GUARD,
    APP_PIPE,
    APP_INTERCEPTOR,
    APP_FILTER,
    APP_MIDDLEWARE,
    APP_EXCEPTION_HANDLER,
    ERROR_CATALOG,
  ]) {
    container.markGlobalToken(t);
  }

  // REQUEST_CONTEXT is seeded into each request-scoped child by RouteManager
  // before any handler resolves it (see route.manager.ts:getRequestContainer).
  // The factory throws so misuse outside the request path surfaces immediately
  // instead of materializing a phantom context.
  container.register(
    defineProvider(REQUEST_CONTEXT, {
      scope: Scope.REQUEST,
      useFactory: () => {
        throw new Error(
          'REQUEST_CONTEXT can only be resolved inside a request — ' +
            'it is seeded by RouteManager when the request enters the pipeline.',
        );
      },
    }),
  );
  container.markGlobalToken(REQUEST_CONTEXT);

  container.register(
    defineProvider(EXECUTION_LIFETIME, {
      scope: Scope.REQUEST,
      useFactory: () => {
        throw new Error('EXECUTION_LIFETIME can only be resolved inside a managed invocation');
      },
    }),
  );
  container.markGlobalToken(EXECUTION_LIFETIME);

  const routeManager = new RouteManager(container, options);
  // Resolvable so non-HTTP transports (the WebSocket dispatcher) can read the
  // same global-tier components (APP_* + app.useGlobalX()).
  container.register(defineProvider(RouteManager, { useValue: routeManager }));
  container.markGlobalToken(RouteManager);

  // Named-route URL generation + signed-URL verification are app-level
  // singletons: injectable from any module, and (for the guard) instantiable by
  // the pipeline when a route opts in via `@SignedUrl()`. Both read their secret
  // lazily and never force controllers/lazy modules to materialize.
  container.register(UrlGeneratorService);
  container.markGlobalToken(UrlGeneratorService);
  container.register(SignedUrlGuard);
  container.markGlobalToken(SignedUrlGuard);

  // Internal-dispatch seam (`ctx.run`): the dispatcher + its signed-invocation
  // guard are app-level singletons injectable from any queue/cron/entrypoint
  // handler. The transport the dispatcher resolves (INVOCATION_TRANSPORT) is
  // registered later by VelaFactory, once the Hono app exists. The nonce store
  // defaults to the per-isolate MemoryNonceStore and stays overridable (an
  // adapter can provide a shared DO/KV-backed store for cross-isolate reuse).
  container.register(InternalDispatcher);
  container.markGlobalToken(InternalDispatcher);
  container.register(SignedInvocationGuard);
  container.markGlobalToken(SignedInvocationGuard);
  container.register(defineProvider(NONCE_STORE, { useClass: MemoryNonceStore }));
  container.markGlobalToken(NONCE_STORE);

  await options.configureContainer?.(container);

  const loader = new ModuleLoader(container, routeManager);
  // loader.load() also arms the deferred-init seam (LazyModuleManager) — kept
  // inside the loader so hand-rolled bootstrap paths that never call this
  // function (@velajs/testing's TestingModuleBuilder.compile) get identical
  // lazy semantics.
  loader.load(rootModule);

  bindAppProviders(routeManager, container, loader);
  routeManager.registerConsumerMiddleware(loader.getConsumerMiddlewareDefinitions());

  if (options.globalPrefix) {
    routeManager.setGlobalPrefix(options.globalPrefix);
  }

  for (const handler of options.middleware ?? []) {
    const mw: NestMiddleware = { use: handler };
    routeManager.useGlobalMiddleware(mw);
  }

  // All providers are registered — compute request-scope bubbling so effective
  // scopes are known before eager instantiation and request resolution.
  container.computeEffectiveScopes();

  return { container, routeManager, loader };
}
