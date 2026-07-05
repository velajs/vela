import { Scope } from '../constants';
import { Container } from '../container/container';
import { ModuleRef } from '../container/module-ref';
import { DiscoveryService } from '../discovery/discovery.service';
import type { Diagnostics, Type } from '../container/types';
import { REQUEST_CONTEXT } from '../http/request-context';
import { RouteManager } from '../http/route.manager';
import type { RouteManagerOptions } from '../http/route.manager';
import { UrlGeneratorService } from '../http/url/url-generator.service';
import { SignedUrlGuard } from '../http/url/signed-url.guard';
import { ModuleLoader } from '../module/module-loader';
import { bindAppProviders } from '../pipeline/app-providers';
import { ComponentManager } from '../pipeline/component.manager';
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_MIDDLEWARE,
  APP_PIPE,
} from '../pipeline/tokens';
import type { NestMiddleware } from '../pipeline/types';

export interface BootstrapOptions extends RouteManagerOptions {
  diagnostics?: Diagnostics;
}

export interface BootstrapResult {
  container: Container;
  routeManager: RouteManager;
  loader: ModuleLoader;
}

/**
 * Wire the DI graph for `rootModule` and prepare the route manager — without
 * running lifecycle hooks or building the Hono app. The single primitive
 * shared by `VelaFactory.create` (HTTP), `@velajs/testing` (test), and any
 * non-HTTP consumer (CLI tools, custom runtimes).
 *
 * Framework-internal tokens (`Container`, `ModuleRef`, `APP_*`) are marked
 * global so they are resolvable from any module.
 */
export async function bootstrap(
  rootModule: Type,
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const container = new Container({
    diagnostics: options.diagnostics,
  });

  container.register({ provide: Container, useValue: container });
  container.markGlobalToken(Container);

  container.register({
    provide: ModuleRef,
    useFactory: (c: Container) => new ModuleRef(c),
    inject: [Container],
  });
  container.markGlobalToken(ModuleRef);

  // Decorator-driven discovery — global so any provider can inject it.
  container.register({
    provide: DiscoveryService,
    useFactory: (c: Container) => new DiscoveryService(c),
    inject: [Container],
  });
  container.markGlobalToken(DiscoveryService);

  for (const t of [APP_GUARD, APP_PIPE, APP_INTERCEPTOR, APP_FILTER, APP_MIDDLEWARE]) {
    container.markGlobalToken(t);
  }

  // REQUEST_CONTEXT is seeded into each request-scoped child by RouteManager
  // before any handler resolves it (see route.manager.ts:getRequestContainer).
  // The factory throws so misuse outside the request path surfaces immediately
  // instead of materializing a phantom context.
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

  const routeManager = new RouteManager(container, options);
  // Resolvable so non-HTTP transports (the WebSocket dispatcher) can read the
  // same global-tier components (APP_* + app.useGlobalX()).
  container.register({ provide: RouteManager, useValue: routeManager });
  container.markGlobalToken(RouteManager);

  // Named-route URL generation + signed-URL verification are app-level
  // singletons: injectable from any module, and (for the guard) instantiable by
  // the pipeline when a route opts in via `@SignedUrl()`. Both read their secret
  // lazily and never force controllers/lazy modules to materialize.
  container.register(UrlGeneratorService);
  container.markGlobalToken(UrlGeneratorService);
  container.register(SignedUrlGuard);
  container.markGlobalToken(SignedUrlGuard);

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
