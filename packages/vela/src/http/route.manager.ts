import { type Next, Hono } from 'hono';
import type {
  VelaContext as Context,
  VelaHono as HonoApp,
  VelaHonoEnv,
  VelaMiddlewareHandler as MiddlewareHandler,
} from './hono.types';
import { bodyLimit as honoBodyLimit } from 'hono/body-limit';
import { contextStorage } from 'hono/context-storage';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HttpMethod } from '../constants';
import { HttpException } from '../errors/http-exception';
import { getMetadata } from '../metadata';
import type { Container } from '../container/container';
import type { Token, TypedToken, Type } from '../container/types';
import type { MiddlewareRouteDefinition } from '../module/middleware';
import { joinPaths } from '../registry/paths';
import { ArgumentResolver } from './argument-resolver';
import { getRouteContributors } from './route-contributor';
import { buildMiddlewareExecutionContext } from './execution-context';
import { HandlerExecutor } from './handler-executor';
import { instantiate, instantiateMany } from './instantiate';
import { REQUEST_CONTEXT, createRequestContext } from './request-context';
import { findRequestContainer, setRequestContainer } from './request-container';
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
import {
  DEFAULT_QUERY_BYTES_LIMIT,
  DEFAULT_QUERY_DEPTH_LIMIT,
  DEFAULT_QUERY_PARAMETER_LIMIT,
  queryKeyDepth,
  warnRelaxedSecurityLimit,
  validatePositiveLimit,
  type VelaBodyLimitOverride,
  type VelaSecurityOptions,
} from './security-options';

type MethodRegistrar = (app: HonoApp, path: string, handler: MiddlewareHandler) => void;

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
  /** Stable container module bucket that declares the controller. */
  moduleId: string;
  version?: number;
  /** Route name (`@Get(path, { name })`) — the URL-generation / `operationId` key. */
  name?: string;
}

export interface RouteManagerOptions {
  /**
   * Trusted runtime client-address resolver. Never read X-Forwarded-For or
   * X-Real-IP here unless a trusted proxy has authenticated and sanitized it.
   * Runtime adapters (for example Cloudflare) should provide this.
   */
  getClientIp?: (c: Context) => string | null;
  middleware?: MiddlewareHandler[];
  globalPrefix?: string;
  /**
   * Opt into ambient request-container access (`getCurrentContainer()` /
   * `getCurrentRequestContext()`). Registers Hono's `contextStorage()` as the
   * first middleware. Off by default — the explicit child container is unchanged.
   */
  ambientContainer?: boolean;
  /**
   * Maximum request-body size in bytes. Applied before application middleware,
   * scoped middleware, guards, pipes, and signed-body hashing. Defaults to
   * {@link DEFAULT_BODY_LIMIT_BYTES}. Set `false` only when an outer trusted
   * proxy enforces an equivalent limit.
   */
  bodyLimit?: number | false;
  /** Unified request parsing limits. Prefer this over the legacy `bodyLimit`. */
  security?: VelaSecurityOptions;
}

/** Secure default request-body ceiling for every runtime (1 MiB). */
export const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

// Forwarding headers are user-controlled unless a runtime adapter attests
// them. Core therefore has no default client identity.
const defaultGetClientIp = (_c: Context): string | null => null;

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
    [HttpMethod.GET, (app, p, handler) => app.get(p, handler)],
    [HttpMethod.POST, (app, p, handler) => app.post(p, handler)],
    [HttpMethod.PUT, (app, p, handler) => app.put(p, handler)],
    [HttpMethod.PATCH, (app, p, handler) => app.patch(p, handler)],
    [HttpMethod.DELETE, (app, p, handler) => app.delete(p, handler)],
    [HttpMethod.OPTIONS, (app, p, handler) => app.options(p, handler)],
    [
      HttpMethod.HEAD,
      // Hono dispatches HEAD through GET. Every member of a HEAD chain must
      // skip ordinary GET requests, including its scoped middleware.
      (app, p, handler) =>
        app.get(p, (c, next) => (c.req.method === 'HEAD' ? handler(c, next) : next())),
    ],
    [HttpMethod.ALL, (app, p, handler) => app.all(p, handler)],
  ]);

  private controllers: ControllerRegistration[] = [];
  private globalMiddleware: Array<MiddlewareType | TypedToken<NestMiddleware>> = [];
  private globalPipes: Array<PipeType | TypedToken<PipeTransform>> = [];
  private globalGuards: Array<GuardType | TypedToken<CanActivate>> = [];
  private globalInterceptors: Array<InterceptorType | TypedToken<NestInterceptor>> = [];
  private globalFilters: Array<FilterType | TypedToken<ExceptionFilter>> = [];
  private globalPrefix = '';
  private consumerMiddlewareDefinitions: MiddlewareRouteDefinition[] = [];
  private routeDescriptions: RouteDescription[] = [];

  private readonly handlerExecutor: HandlerExecutor;
  private readonly ambientContainer: boolean;
  private readonly bodyLimit: number | false;
  private readonly bodyLimitOverrides: VelaBodyLimitOverride[];
  private readonly queryMaxParameters: number | false;
  private readonly queryMaxDepth: number | false;
  private readonly queryMaxBytes: number | false;
  private readonly clientIpResolver: (c: Context) => string | null;

  constructor(
    private container: Container,
    options: RouteManagerOptions = {},
  ) {
    this.ambientContainer = options.ambientContainer ?? false;
    if (options.bodyLimit !== undefined && options.security?.body?.maxBytes !== undefined) {
      throw new Error('Configure either bodyLimit or security.body.maxBytes, not both');
    }
    this.bodyLimit =
      options.security?.body?.maxBytes ?? options.bodyLimit ?? DEFAULT_BODY_LIMIT_BYTES;
    validatePositiveLimit('bodyLimit', this.bodyLimit);
    this.bodyLimitOverrides = (options.security?.body?.streamingOverrides ?? []).map(
      (override) => ({
        ...override,
        ...(override.methods
          ? { methods: override.methods.map((method) => method.toUpperCase()) }
          : {}),
      }),
    );
    for (const override of this.bodyLimitOverrides) this.validateBodyLimitOverride(override);

    this.queryMaxParameters =
      options.security?.query?.maxParameters ?? DEFAULT_QUERY_PARAMETER_LIMIT;
    this.queryMaxDepth = options.security?.query?.maxDepth ?? DEFAULT_QUERY_DEPTH_LIMIT;
    this.queryMaxBytes = options.security?.query?.maxBytes ?? DEFAULT_QUERY_BYTES_LIMIT;
    validatePositiveLimit('security.query.maxParameters', this.queryMaxParameters);
    validatePositiveLimit('security.query.maxDepth', this.queryMaxDepth);
    validatePositiveLimit('security.query.maxBytes', this.queryMaxBytes);
    warnRelaxedSecurityLimit('security.body.maxBytes', this.bodyLimit, DEFAULT_BODY_LIMIT_BYTES);
    warnRelaxedSecurityLimit(
      'security.query.maxParameters',
      this.queryMaxParameters,
      DEFAULT_QUERY_PARAMETER_LIMIT,
    );
    warnRelaxedSecurityLimit(
      'security.query.maxDepth',
      this.queryMaxDepth,
      DEFAULT_QUERY_DEPTH_LIMIT,
    );
    warnRelaxedSecurityLimit(
      'security.query.maxBytes',
      this.queryMaxBytes,
      DEFAULT_QUERY_BYTES_LIMIT,
    );
    for (const override of this.bodyLimitOverrides) {
      if (override.maxBytes === false) {
        warnRelaxedSecurityLimit(
          `security.body.streamingOverrides[${override.path}]`,
          false,
          DEFAULT_BODY_LIMIT_BYTES,
        );
      }
    }
    this.clientIpResolver = options.getClientIp ?? defaultGetClientIp;
    const argumentResolver = new ArgumentResolver((c) => this.resolveClientIp(c));
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
    guards: Array<GuardType | TypedToken<CanActivate>>;
    pipes: Array<PipeType | TypedToken<PipeTransform>>;
    interceptors: Array<InterceptorType | TypedToken<NestInterceptor>>;
    filters: Array<FilterType | TypedToken<ExceptionFilter>>;
  } {
    return {
      guards: this.globalGuards,
      pipes: this.globalPipes,
      interceptors: this.globalInterceptors,
      filters: this.globalFilters,
    };
  }

  /** Resolve a runtime-attested client address; spoofable forwarding headers are never read here. */
  resolveClientIp(c: Context): string | null {
    const resolved = this.clientIpResolver(c);
    if (typeof resolved !== 'string') return null;
    const normalized = resolved.trim();
    if (
      normalized.length === 0 ||
      normalized.length > 128 ||
      /[\u0000-\u001f\u007f]/.test(normalized)
    ) {
      return null;
    }
    return normalized;
  }

  private validateBodyLimitOverride(override: VelaBodyLimitOverride): void {
    if (
      (override.path !== '*' && !override.path.startsWith('/')) ||
      override.path.includes('?') ||
      override.path.includes('#') ||
      override.path.slice(0, -1).includes('*')
    ) {
      throw new Error(
        `security.body.streamingOverrides path must be absolute with only an optional trailing '*': ${override.path}`,
      );
    }
    if (override.methods?.length === 0) {
      throw new Error('security.body.streamingOverrides methods must not be empty');
    }
    for (const method of override.methods ?? []) {
      if (!/^[A-Z]+$/.test(method)) {
        throw new Error(`Invalid streaming body-limit method: ${method}`);
      }
    }
    validatePositiveLimit('security.body.streamingOverrides.maxBytes', override.maxBytes);
  }

  private resolveBodyLimit(path: string, method: string): number | false {
    for (const override of this.bodyLimitOverrides) {
      if (override.methods && !override.methods.includes(method.toUpperCase())) continue;
      const matches =
        override.path === '*' ||
        (override.path.endsWith('*')
          ? path.startsWith(override.path.slice(0, -1))
          : path === override.path);
      if (matches) return override.maxBytes;
    }
    return this.bodyLimit;
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

  useGlobalMiddlewareTokens(...middlewareTokens: Array<TypedToken<NestMiddleware>>): this {
    this.globalMiddleware.push(...middlewareTokens);
    return this;
  }

  useGlobalPipes(...pipes: PipeType[]): this {
    this.globalPipes.push(...pipes);
    return this;
  }

  useGlobalPipeTokens(...pipeTokens: Array<TypedToken<PipeTransform>>): this {
    this.globalPipes.push(...pipeTokens);
    return this;
  }

  useGlobalGuards(...guards: GuardType[]): this {
    this.globalGuards.push(...guards);
    return this;
  }

  useGlobalGuardTokens(...guardTokens: Array<TypedToken<CanActivate>>): this {
    this.globalGuards.push(...guardTokens);
    return this;
  }

  useGlobalInterceptors(...interceptors: InterceptorType[]): this {
    this.globalInterceptors.push(...interceptors);
    return this;
  }

  useGlobalInterceptorTokens(...interceptorTokens: Array<TypedToken<NestInterceptor>>): this {
    this.globalInterceptors.push(...interceptorTokens);
    return this;
  }

  useGlobalFilters(...filters: FilterType[]): this {
    this.globalFilters.push(...filters);
    return this;
  }

  useGlobalFilterTokens(...filterTokens: Array<TypedToken<ExceptionFilter>>): this {
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
        entry as MiddlewareType | TypedToken<NestMiddleware>,
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
    const existing = findRequestContainer(c);
    if (existing) {
      return existing;
    }

    const child = this.container.createChild();
    child.setRequestInstance(REQUEST_CONTEXT, createRequestContext(c));
    setRequestContainer(c, child);
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
    const moduleId = this.container.getOwnerModuleIds(controller)[0];
    if (!moduleId) {
      throw new Error(`Cannot register controller ${controller.name}: no declaring module bucket`);
    }

    this.controllers.push({
      controller,
      moduleId,
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

  async build(): Promise<HonoApp> {
    const app = new Hono<VelaHonoEnv>();
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
        const child = findRequestContainer(c);
        if (child?.hasDisposables()) {
          const body = threw ? null : (c.res?.body ?? null);
          if (body) {
            // Defer disposal to when the runtime finishes reading the body.
            c.res = new Response(
              disposeStreamWhenDone(body, () => void child.dispose()),
              {
                status: c.res.status,
                statusText: c.res.statusText,
                headers: c.res.headers,
              },
            );
          } else {
            // No body (or error path) — nothing streaming, dispose now.
            await child.dispose();
          }
        }
      }
    });

    // Security boundary: reject oversized input before any user middleware,
    // argument extraction, validation pipe, guard, or signed-body capture can
    // buffer/hash it. Hono also counts streaming bodies without Content-Length.
    app.use('*', (c, next) => {
      const maxSize = this.resolveBodyLimit(c.req.path, c.req.method);
      return maxSize === false ? next() : honoBodyLimit({ maxSize })(c, next);
    });

    // Bound query parsing before user middleware or handler decorators see it.
    app.use('*', async (c, next) => {
      const rawUrl = c.req.raw.url;
      const queryStart = rawUrl.indexOf('?');
      const fragmentStart = queryStart < 0 ? -1 : rawUrl.indexOf('#', queryStart + 1);
      const rawQuery =
        queryStart < 0
          ? ''
          : rawUrl.slice(queryStart + 1, fragmentStart < 0 ? undefined : fragmentStart);
      if (this.queryMaxBytes !== false && rawQuery.length > this.queryMaxBytes) {
        return c.json(
          { error: { code: 'bad_request', message: 'Query string exceeds the configured limit' } },
          400,
        );
      }
      if (rawQuery.length > 0) {
        let count = 0;
        for (const [key] of new URL(c.req.raw.url).searchParams) {
          count++;
          if (this.queryMaxParameters !== false && count > this.queryMaxParameters) {
            return c.json(
              {
                error: {
                  code: 'bad_request',
                  message: 'Query parameter count exceeds the configured limit',
                },
              },
              400,
            );
          }
          if (this.queryMaxDepth !== false && queryKeyDepth(key) > this.queryMaxDepth) {
            return c.json(
              {
                error: {
                  code: 'bad_request',
                  message: 'Query parameter depth exceeds the configured limit',
                },
              },
              400,
            );
          }
        }
      }
      await next();
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
      .sort((a, b) => a.priority - b.priority || a.index - b.index);

    for (const { entry } of sortedGlobal) {
      app.use(
        '*',
        this.wrapMiddlewareWithFilters((c, next) => {
          const requestContainer = this.getRequestContainer(c);
          const resolved = instantiate<NestMiddleware>(entry, requestContainer);
          return resolved.use(c, next);
        }),
      );
    }

    const sortedConsumer = this.consumerMiddlewareDefinitions
      .map((def, index) => ({ def, index, priority: def.priority ?? 0 }))
      .sort((a, b) => a.priority - b.priority || a.index - b.index);

    for (const { def } of sortedConsumer) {
      const matchRoute = this.compileRouteMatcher(def.routes);
      const matchExclude = this.compileRouteMatcher(def.excludes);

      app.use(
        '*',
        this.wrapMiddlewareWithFilters((c, next) => {
          const path = c.req.path;
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
        }),
      );
    }

    // First pass: register all custom routes (must come before CRUD /:id routes).
    for (const { controller, moduleId, metadata, routes } of this.controllers) {
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
          const middlewareItems = ComponentManager.getScopedComponents(
            'middleware',
            controller,
            route.handlerName,
          );
          const handler = this.handlerExecutor.create(
            route,
            controller,
            moduleId,
            allParamMetadata,
          );

          const middleware = middlewareItems.map((middlewareItem) =>
            this.wrapMiddlewareWithFilters((c, next) => {
              const requestContainer = this.getRequestContainer(c);
              const resolved = instantiate<NestMiddleware>(middlewareItem, requestContainer);
              return resolved.use(c, next);
            }),
          );

          for (const [pathIndex, fullPath] of versionedPaths.entries()) {
            // Register the onion with its method and terminal handler. A
            // path-only app.use() also matches sibling methods/controllers.
            this.registerRoute(app, route.method, fullPath, ...middleware, handler);
            this.routeDescriptions.push({
              method: String(route.method),
              path: fullPath || '/',
              controller: controller.name,
              handler: String(route.handlerName),
              moduleId,
              version: versionsForPaths[pathIndex],
              ...(route.name !== undefined ? { name: route.name } : {}),
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
    for (const { controller, metadata, routes } of this.controllers) {
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

      // DX warning for stale setups: @Crud() metadata but nothing produced a
      // route — native @velajs/crud (>=1.18) stamps real routes at decoration
      // time, and legacy bridges register a claiming contributor.
      if (
        getMetadata('vela:crud', controller) !== undefined &&
        routes.length === 0 &&
        !contributors.some((c) => c.claimsMetaKey === 'vela:crud')
      ) {
        console.warn(
          `[vela] ${controller.name} carries @Crud() metadata but produced no routes — ` +
            "install and import '@velajs/crud' (>=1.18), or remove the decorator.",
        );
      }
    }

    return app;
  }

  private registerRoute(
    app: HonoApp,
    method: HttpMethod | string,
    path: string,
    ...handlers: MiddlewareHandler[]
  ): void {
    const normalizedPath = path || '/';
    const registrar = RouteManager.METHOD_REGISTRAR.get(method);
    for (const handler of handlers) {
      if (registrar) {
        registrar(app, normalizedPath, handler);
      } else {
        app.on(method, normalizedPath, handler);
      }
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
      return joinPaths(
        globalPrefix,
        joinPaths(versionSegment, joinPaths(controllerPrefix, routePath)),
      );
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
