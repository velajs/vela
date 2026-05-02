import { Container } from '../container/container';
import { ModuleRef } from '../container/module-ref';
import type { Diagnostics, Type } from '../container/types';
import { RouteManager } from '../http/route.manager';
import type { RouteManagerOptions } from '../http/route.manager';
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
  strict?: boolean;
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
 * global so they are resolvable from any module in strict mode.
 */
export async function bootstrap(
  rootModule: Type,
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const container = new Container({
    strict: options.strict,
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

  for (const t of [APP_GUARD, APP_PIPE, APP_INTERCEPTOR, APP_FILTER, APP_MIDDLEWARE]) {
    container.markGlobalToken(t);
  }

  const routeManager = new RouteManager(container, options);
  ComponentManager.init(container);

  const loader = new ModuleLoader(container, routeManager);
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

  return { container, routeManager, loader };
}
