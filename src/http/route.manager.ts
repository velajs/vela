import { type Context, type MiddlewareHandler, type Next, Hono } from 'hono';
import { contextStorage } from 'hono/context-storage';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HttpMethod } from '../constants';
import { HttpException } from '../errors/http-exception';
import { getMetadata } from '../metadata';
import type { Container } from '../container/container';
import type { Token, Type } from '../container/types';
import type { MiddlewareRouteDefinition } from '../module/middleware';
import { joinPaths } from '../registry/paths';
import { ArgumentResolver } from './argument-resolver';
import { getRouteContributors } from './route-contributor';
import { buildMiddlewareExecutionContext } from './execution-context';
import { HandlerExecutor } from './handler-executor';
import { instantiate, instantiateMany } from './instantiate';
import { REQUEST_CONTEXT, createRequestContext } from './request-context';
import { mapResponse } from './response-mapper';
import { ComponentManager } from '../pipeline/component.manager';
import { shouldFilterCatch } from '../pipeline/decorators';
import type {
  CanActivate,
  ExceptionFilter,
  NestInterceptor,
  NestMiddleware,
  PipeTransform,
} from '../pipeline/types';
import { MetadataRegistry } from '../registry/metadata.registry';
import type {
  FilterType,
  GuardType,
  InterceptorType,
  MiddlewareType,
  PipeType,
} from '../registry/types';
import type { ControllerRegistration, RouteMetadata } from './types';

type MethodRegistrar = (app: Hono, path: string, h: (c: Context) => Response | Promise<Response>) => void;

/**
 * One explicit controller route as the framework registered it — recorded by
 * `build()` with the SAME composed path handed to Hono (global prefix +
 * version segment + controller prefix + route path), so introspection tooling
 * (`vela route list`) never re-derives composition. Contributed routes
 * (`RouteContributor`, e.g. `@velajs/crud`) mount directly on the Hono app
 * and are not described here — diff `app.getHonoApp().routes` for those.
 */
export interface RouteDescription {
  /** As declared on the handler — `@Head()` reports HEAD (Hono serves it under GET). */
  method: string;
  /** Fully composed path exactly as registered. */
  path: string;
  controller: string;
  handler: string;
  version?: number;
}

export interface RouteManagerOptions {
  getClientIp?: (c: Context) => string | null;
  middleware?: MiddlewareHandler[];
  globalPrefix?: string;
  /**
   * Opt into ambient request-container access (`getCurrentContainer()` /
   * `getCurrentRequestContext()`). Registers Hono's `contextStorage()` as the
   * first middleware. Off by default — the explicit child container is unchanged.
   */
  ambientContainer?: boolean;
}

const defaultGetClientIp = (c: Context): string | null =>
  c.req.raw.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  ?? c.req.raw.headers.get('x-real-ip')
  ?? null;

// Mirror a response body stream, invoking `onDone` exactly once when it is fully
// read, errors, or is cancelled. Lets request-scoped resources be disposed only
// after the body has drained — never mid-stream.
function disposeStreamWhenDone(
  body: ReadableStream<Uint8Array>,
  onDone: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let finished = false;
  const finish = (): void => {
    if (!finished) {
      finished = true;
      onDone();
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          finish();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
        finish();
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });
}

export class RouteManager {
  private static readonly METHOD_REGISTRAR = new Map<string, MethodRegistrar>([
    [HttpMethod.GET,     (app, p, h) => app.get(p, h)],
    [HttpMethod.POST,    (app, p, h) => app.post(p, h)],
    [HttpMethod.PUT,     (app, p, h) => app.put(p, h)],
    [HttpMethod.PATCH,   (app, p, h) => app.patch(p, h)],
    [HttpMethod.DELETE,  (app, p, h) => app.delete(p, h)],
    [HttpMethod.OPTIONS, (app, p, h) => app.options(p, h)],
    [HttpMethod.HEAD,    (app, p, h) => app.get(p, (c, next) => (c.req.method === 'HEAD' ? h(c) : next()))],
    [HttpMethod.ALL,     (app, p, h) => app.all(p, h)],
  ]);

  private controllers: ControllerRegistration[] = [];
  private globalMiddleware: Array<MiddlewareType | Token<NestMiddleware>> = [];
  private globalPipes: Array<PipeType | Token<PipeTransform>> = [];
  private globalGuards: Array<GuardType | Token<CanActivate>> = [];
  private globalInterceptors: Array<InterceptorType | Token<NestInterceptor>> = [];
  private globalFilters: Array<FilterType | Token<ExceptionFilter>> = [];
  private globalPrefix = '';
  private consumerMiddlewareDefinitions: MiddlewareRouteDefinition[] = [];
  private routeDescriptions: RouteDescription[] = [];

  private readonly handlerExecutor: HandlerExecutor;
  private readonly ambientContainer: boolean;

  constructor(private container: Container, options: RouteManagerOptions = {}) {
    this.ambientContainer = options.ambientContainer ?? false;
    const argumentResolver = new ArgumentResolver(options.getClientIp ?? defaultGetClientIp);
    this.handlerExecutor = new HandlerExecutor(
      argumentResolver,
      () => ({
        guards: this.globalGuards,
        pipes: this.globalPipes,
        interceptors: this.globalInterceptors,
        filters: this.globalFilters,
      }),
      (c) => this.getRequestContainer(c),
    );
  }

  /**
   * The global-tier components (`APP_*` provider tokens + imperative
   * `app.useGlobalX()` instances). Exposed so non-HTTP transports (the
   * WebSocket dispatcher) can apply the same app-wide guards/pipes/interceptors/
   * filters as HTTP routes, read live so late registrations propagate.
   */
  getGlobalComponents(): {
    guards: Array<GuardType | Token<CanActivate>>;
    pipes: Array<PipeType | Token<PipeTransform>>;
    interceptors: Array<InterceptorType | Token<NestInterceptor>>;
    filters: Array<FilterType | Token<ExceptionFilter>>;
  } {
    return {
      guards: this.globalGuards,
      pipes: this.globalPipes,
      interceptors: this.globalInterceptors,
      filters: this.globalFilters,
    };
  }

  registerConsumerMiddleware(definitions: MiddlewareRouteDefinition[]): this {
    this.consumerMiddlewareDefinitions.push(...definitions);
    return this;
  }

  setGlobalPrefix(prefix: string): this {
    this.globalPrefix = prefix && !prefix.startsWith('/') ? `/${prefix}` : prefix;
    return this;
  }

  useGlobalMiddleware(...middleware: MiddlewareType[]): this {
    this.globalMiddleware.push(...middleware);
    return this;
  }

  useGlobalMiddlewareTokens(...middlewareTokens: Array<Token<NestMiddleware>>): this {
    this.globalMiddleware.push(...middlewareTokens);
    return this;
  }

  useGlobalPipes(...pipes: PipeType[]): this {
    this.globalPipes.push(...pipes);
    return this;
  }

  useGlobalPipeTokens(...pipeTokens: Array<Token<PipeTransform>>): this {
    this.globalPipes.push(...pipeTokens);
    return this;
  }

  useGlobalGuards(...guards: GuardType[]): this {
    this.globalGuards.push(...guards);
    return this;
  }

  useGlobalGuardTokens(...guardTokens: Array<Token<CanActivate>>): this {
    this.globalGuards.push(...guardTokens);
    return this;
  }

  useGlobalInterceptors(...interceptors: InterceptorType[]): this {
    this.globalInterceptors.push(...interceptors);
    return this;
  }

  useGlobalInterceptorTokens(...interceptorTokens: Array<Token<NestInterceptor>>): this {
    this.globalInterceptors.push(...interceptorTokens);
    return this;
  }

  useGlobalFilters(...filters: FilterType[]): this {
    this.globalFilters.push(...filters);
    return this;
  }

  useGlobalFilterTokens(...filterTokens: Array<Token<ExceptionFilter>>): this {
    this.globalFilters.push(...filterTokens);
    return this;
  }

  private getMiddlewarePriority(entry: unknown): number {
    if (entry == null) return 0;
    if (typeof entry === 'function') {
      const p = (entry as { priority?: unknown }).priority;
      if (typeof p === 'number') return p;
    }
    if (typeof entry === 'object') {
      const inst = entry as { priority?: unknown; constructor?: { priority?: unknown } };
      if (typeof inst.priority === 'number') return inst.priority;
      if (typeof inst.constructor?.priority === 'number') return inst.constructor.priority;
    }
    // A token owned exclusively by unmaterialized lazy modules must not be
    // instantiate-probed here — the probe at route build would defeat the
    // module's deferral (i18n's APP_MIDDLEWARE). Default priority instead;
    // the middleware still materializes on its first request.
    if (this.container.isLazyPending(entry as Token)) return 0;
    try {
      const resolved = instantiate<NestMiddleware>(
        entry as MiddlewareType | Token<NestMiddleware>,
        this.container,
      );
      if (resolved && typeof resolved === 'object') {
        const p = (resolved as { priority?: unknown }).priority;
        if (typeof p === 'number') return p;
        const cp = (resolved as { constructor?: { priority?: unknown } }).constructor?.priority;
        if (typeof cp === 'number') return cp;
      }
    } catch {
      // Unresolvable at build time (e.g. request-scoped) — default 0
    }
    return 0;
  }

  private getRequestContainer(c: Context): Container {
    const existing = c.get('container') as Container | undefined;
    if (existing) {
      return existing;
    }

    const child = this.container.createChild();
    child.setRequestInstance(REQUEST_CONTEXT, createRequestContext(c));
    c.set('container', child);
    return child;
  }

  // Wraps an attached middleware so a thrown error flows through the
  // exception-filter chain instead of bypassing it on the way to Hono's
  // outer error handler. Mirrors the catch tail in HandlerExecutor — global
  // filters are the only scope reachable here, since per-handler filters
  // require a controller call frame that the middleware boundary lacks.
  // Non-throwing middleware paths (returning a Response, calling `next()`,
  // resolving a promise) are byte-identical to before — the wrapper only
  // intercepts thrown / rejected values.
  private wrapMiddlewareWithFilters(handler: MiddlewareHandler): MiddlewareHandler {
    return async (c, next) => {
      try {
        return await handler(c, next);
      } catch (error) {
        const response = await this.mapMiddlewareError(c, error);
        // Force-replace any handler-set response. A middleware that throws
        // *after* `await next()` has the handler's body already attached
        // to `c.res`; without overwriting it, Hono would emit the
        // pre-throw success response and the filter's render would be
        // dropped.
        c.res = response;
        return response;
      }
    };
  }

  private async mapMiddlewareError(c: Context, error: unknown): Promise<Response> {
    const requestContainer = this.getRequestContainer(c);
    const filters = instantiateMany<ExceptionFilter>(this.globalFilters, requestContainer);
    const host = buildMiddlewareExecutionContext(c);

    for (const filter of filters) {
      if (shouldFilterCatch(filter, error)) {
        try {
          const filtered = await filter.catch(error, host);
          return mapResponse(c, filtered);
        } catch {
          // Filter itself threw — fall through to default error mapping.
          break;
        }
      }
    }

    if (error instanceof HttpException) {
      const response = error.getResponse();
      const status = error.getStatus() as ContentfulStatusCode;
      return c.json(response, status);
    }

    // Non-HttpException with no catching filter: re-throw so Hono's
    // outer error handler produces the same default-500 response it
    // produced before this wrapping was introduced.
    throw error;
  }

  registerController(controller: Type): this {
    const prefix = MetadataRegistry.getControllerPath(controller);
    const options = MetadataRegistry.getControllerOptions(controller);
    const routes = MetadataRegistry.getRoutes(controller);

    // The ModuleLoader registers controllers in their owning module's bucket;
    // fall back to a `__root__` registration only for controllers that arrive
    // here outside the module-loading flow (test harnesses, custom adapters).
    if (!this.container.has(controller)) {
      this.container.register(controller);
    }

    this.controllers.push({
      controller,
      metadata: { prefix, version: options.version },
      routes: routes as RouteMetadata[],
    });

    return this;
  }

  /** The explicit controller routes recorded by the last `build()`. */
  getRouteDescriptions(): RouteDescription[] {
    return [...this.routeDescriptions];
  }

  /** The global prefix in effect (set at bootstrap; '' when none). */
  getGlobalPrefix(): string {
    return this.globalPrefix;
  }

  async build(): Promise<Hono> {
    const app = new Hono();
    this.routeDescriptions = [];

    // Outermost: dispose the per-request child container once the request is
    // fully done. Fast-paths out when the child has no request-scoped
    // disposables (the common case → zero overhead / no behavior change).
    // Streaming-safe: when a response body is present, disposal is deferred
    // until the body is fully read (or errors/cancels), never mid-stream.
    app.use('*', async (c: Context, next: Next) => {
      let threw = false;
      try {
        await next();
      } catch (error) {
        threw = true;
        throw error;
      } finally {
        const child = c.get('container') as Container | undefined;
        if (child?.hasDisposables()) {
          const body = threw ? null : (c.res?.body ?? null);
          if (body) {
            // Defer disposal to when the runtime finishes reading the body.
            c.res = new Response(disposeStreamWhenDone(body, () => void child.dispose()), {
              status: c.res.status,
              statusText: c.res.statusText,
              headers: c.res.headers,
            });
          } else {
            // No body (or error path) — nothing streaming, dispose now.
            await child.dispose();
          }
        }
      }
    });

    // Opt-in ambient container: contextStorage() must be an early middleware so
    // getContext() is available to everything downstream.
    if (this.ambientContainer) {
      app.use('*', contextStorage());
    }

    // Sort global middleware by priority (lower runs first) with insertion
    // index as tiebreaker so equal priorities preserve registration order.
    const sortedGlobal = this.globalMiddleware
      .map((entry, index) => ({ entry, index, priority: this.getMiddlewarePriority(entry) }))
      .sort((a, b) => (a.priority - b.priority) || (a.index - b.index));

    for (const { entry } of sortedGlobal) {
      app.use('*', this.wrapMiddlewareWithFilters((c, next) => {
        const requestContainer = this.getRequestContainer(c);
        const resolved = instantiate<NestMiddleware>(entry, requestContainer);
        return resolved.use(c, next);
      }));
    }

    const sortedConsumer = this.consumerMiddlewareDefinitions
      .map((def, index) => ({ def, index, priority: def.priority ?? 0 }))
      .sort((a, b) => (a.priority - b.priority) || (a.index - b.index));

    for (const { def } of sortedConsumer) {
      const matchRoute   = this.compileRouteMatcher(def.routes);
      const matchExclude = this.compileRouteMatcher(def.excludes);

      app.use('*', this.wrapMiddlewareWithFilters((c, next) => {
        const path   = c.req.path;
        const method = c.req.method;

        if (!matchRoute(path, method) || matchExclude(path, method)) return next();

        const requestContainer = this.getRequestContainer(c);
        const runChain = (index: number): Promise<void> => {
          if (index >= def.middleware.length) return next();
          const instance = instantiate<NestMiddleware>(def.middleware[index]!, requestContainer);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (instance.use(c, () => runChain(index + 1)) as Promise<any>).then(() => {});
        };

        return runChain(0);
      }));
    }

    // First pass: register all custom routes (must come before CRUD /:id routes).
    for (const { controller, metadata, routes } of this.controllers) {
      if (routes.length > 0) {
        const allParamMetadata = MetadataRegistry.getParameters(controller);

        for (const route of routes) {
          const effectiveVersion = route.version ?? metadata.version;

          const versionedPaths = this.buildVersionedPaths(
            this.globalPrefix,
            metadata.prefix,
            route.path,
            effectiveVersion,
          );
          // Parallel to versionedPaths: buildVersionedPaths maps versions to
          // paths 1:1 in order, so index i of both arrays belongs together.
          const versionsForPaths: Array<number | undefined> =
            effectiveVersion === undefined
              ? [undefined]
              : Array.isArray(effectiveVersion)
                ? effectiveVersion
                : [effectiveVersion];

          // Scoped (controller/handler) middleware only — global middleware is
          // applied once by this manager's own global pass, never re-read here.
          const middlewareItems = ComponentManager.getScopedComponents('middleware', controller, route.handlerName);
          const handler = this.handlerExecutor.create(route, controller, allParamMetadata);

          for (const [pathIndex, fullPath] of versionedPaths.entries()) {
            for (const middlewareItem of middlewareItems) {
              app.use(fullPath, this.wrapMiddlewareWithFilters((c, next) => {
                const requestContainer = this.getRequestContainer(c);
                const resolved = instantiate<NestMiddleware>(
                  middlewareItem as Type<NestMiddleware> | NestMiddleware,
                  requestContainer,
                );
                return resolved.use(c, next);
              }));
            }
            this.registerRoute(app, route.method, fullPath, handler);
            this.routeDescriptions.push({
              method: String(route.method),
              path: fullPath || '/',
              controller: controller.name,
              handler: String(route.handlerName),
              version: versionsForPaths[pathIndex],
            });
          }
        }
      }
    }

    // Second pass: route contributors (generated routes registered last, so a
    // contributor's `/:id` catch-alls never shadow explicit routes). Each
    // contributor claims controllers by class-level metadata; `@velajs/crud`
    // registers one as an import side effect. The registry contract (instead
    // of dynamic `import()`) exists because esbuild leaves
    // `await import(variable)` as a runtime import Cloudflare Workers cannot
    // resolve.
    const contributors = getRouteContributors();
    for (const { controller, metadata } of this.controllers) {
      for (const contributor of contributors) {
        const meta = getMetadata(contributor.claimsMetaKey, controller);
        if (meta === undefined) continue;

        await contributor.buildRoutes(app, {
          controller,
          controllerPrefix: metadata.prefix,
          meta,
          globalPrefix: this.globalPrefix,
          globalGuards: instantiateMany<CanActivate>(this.globalGuards, this.container),
          container: this.container,
          joinPaths,
        });
      }

      // DX guard for the common mistake: @Crud() metadata present but the
      // contributor package never imported.
      if (
        getMetadata('vela:crud', controller) !== undefined &&
        !contributors.some((c) => c.claimsMetaKey === 'vela:crud')
      ) {
        throw new Error(
          "@Crud() requires '@velajs/crud'. Install it: pnpm add @velajs/crud",
        );
      }
    }

    return app;
  }

  private registerRoute(
    app: Hono,
    method: HttpMethod | string,
    path: string,
    handler: (c: Context) => Response | Promise<Response>,
  ): void {
    const normalizedPath = path || '/';
    const registrar = RouteManager.METHOD_REGISTRAR.get(method);
    if (registrar) {
      registrar(app, normalizedPath, handler);
    } else {
      app.on(method, normalizedPath, handler);
    }
  }

  private buildVersionedPaths(
    globalPrefix: string,
    controllerPrefix: string,
    routePath: string,
    version?: number | number[],
  ): string[] {
    if (version === undefined) {
      return [joinPaths(globalPrefix, joinPaths(controllerPrefix, routePath))];
    }

    const versions = Array.isArray(version) ? version : [version];
    return versions.map((v) => {
      const versionSegment = `/v${v}`;
      return joinPaths(globalPrefix, joinPaths(versionSegment, joinPaths(controllerPrefix, routePath)));
    });
  }

  private compilePathMatcher(routePath: string): (reqPath: string) => boolean {
    if (routePath === '*') return () => true;
    const norm = routePath.startsWith('/') ? routePath : `/${routePath}`;
    if (norm.endsWith('*')) {
      const prefix = norm.slice(0, -1);
      return (p) => p.startsWith(prefix);
    }
    return (p) => p === norm || p.startsWith(`${norm}/`);
  }

  private compileRouteMatcher(
    routes: Array<{ path: string; method?: HttpMethod }>,
  ): (path: string, method: string) => boolean {
    const matchers = routes.map((route) => {
      const matchPath = this.compilePathMatcher(route.path);
      return (path: string, method: string): boolean => {
        if (!matchPath(path)) return false;
        if (route.method && route.method !== HttpMethod.ALL) return method === route.method;
        return true;
      };
    });
    if (matchers.length === 0) return () => false;
    if (matchers.length === 1) return matchers[0]!;
    return (path, method) => matchers.some((m) => m(path, method));
  }

  getControllers(): ControllerRegistration[] {
    return [...this.controllers];
  }
}
