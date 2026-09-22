import { type Next, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { toErrorBody } from '@velajs/errors';
import type {
  VelaContext as Context,
  VelaHono as HonoApp,
  VelaHonoEnv,
  VelaMiddlewareHandler as MiddlewareHandler,
} from './hono.types';
import { bodyLimit as honoBodyLimit } from 'hono/body-limit';
import { contextStorage } from 'hono/context-storage';
import { basePath, routePath } from 'hono/route';
import { TrieRouter } from 'hono/router/trie-router';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HttpMethod } from '../constants';
import { HttpException } from '../errors/http-exception';
import { createExecutionScope, finishExecutionScope } from '../entrypoint/execution-scope';
import { httpExceptionBody } from '../exceptions/http-exception-body';
import { resolveErrorReporter } from '../exceptions/reporter';
import { getMetadata } from '../metadata';
import type { Container } from '../container/container';
import type { Token, TypedToken, Type } from '../container/types';
import type { MiddlewareRouteDefinition, RouteInfo } from '../module/middleware';
import { joinPaths, normalizePath } from '../registry/paths';
import { ArgumentResolver } from './argument-resolver';
import { getRouteContributors } from './route-contributor';
import { buildMiddlewareExecutionContext } from './execution-context';
import { HandlerExecutor } from './handler-executor';
import { instantiate, instantiateMany, instantiateAsync } from './instantiate';
import { REQUEST_CONTEXT, createRequestContext } from './request-context';
import { findRequestContainer, setRequestContainer } from './request-container';
import type { HttpRequestCompletion, HttpRequestObserver } from './request-observer';
import { mapResponse } from './response-mapper';
import { shouldFilterCatch } from '../pipeline/decorators';
import { getScopedComponents } from '../pipeline/scoped-components';
import type {
  CanActivate,
  ExceptionFilter,
  NestInterceptor,
  NestMiddleware,
  PipeTransform,
} from '../pipeline/types';
import { MetadataRegistry } from '../registry/metadata.registry';
import type {
  Constructor,
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

// Track the transmitted body without owning the invocation's deferred work.
// Cancellation finishes only after the producer's cancellation settles, so it
// can still use request-scoped resources while releasing its own handles.
function trackResponseStream(
  body: ReadableStream<Uint8Array>,
  onFinish: (outcome: HttpRequestCompletion['outcome']) => void,
): {
  body: ReadableStream<Uint8Array>;
  done: Promise<void>;
} {
  const reader = body.getReader();
  const completion = Promise.withResolvers<void>();
  let finished = false;
  let cancelling = false;
  const finish = (outcome: HttpRequestCompletion['outcome']): void => {
    if (finished) return;
    finished = true;
    reader.releaseLock();
    onFinish(outcome);
    completion.resolve();
  };
  return {
    done: completion.promise,
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            if (!cancelling) {
              controller.close();
              finish('success');
            }
          } else {
            controller.enqueue(value);
          }
        } catch (error) {
          if (!cancelling) {
            controller.error(error);
            finish('error');
          }
        }
      },
      async cancel(reason) {
        cancelling = true;
        try {
          await reader.cancel(reason);
        } catch (error) {
          finish('error');
          throw error;
        } finally {
          finish('cancelled');
        }
      },
    }),
  };
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
  private readonly requestObservers = new Set<HttpRequestObserver>();

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
      container,
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

    const child = this.createRequestContainer(c);
    child.setRequestInstance(REQUEST_CONTEXT, createRequestContext(c));
    return child;
  }

  private createRequestContainer(c: Context): Container {
    const { container: child } = createExecutionScope(this.container, { signal: c.req.raw.signal });
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
    const host = buildMiddlewareExecutionContext(c);
    const reporter = resolveErrorReporter(requestContainer);
    const source = `${c.req.method} ${c.req.path}`;
    reporter.report(error, { edge: 'http', source, note: 'middleware failed' });

    for (const entry of this.globalFilters) {
      try {
        const filter = await instantiateAsync<ExceptionFilter>(entry, requestContainer);
        if (shouldFilterCatch(filter, error)) {
          return mapResponse(c, await filter.catch(error, host));
        }
      } catch (filterError) {
        reporter.report(filterError, { edge: 'http', source, note: 'middleware filter failed' });
        break;
      }
    }

    const rendered = reporter.render(error, host);
    if (rendered instanceof Response) return rendered;
    if (rendered) return c.json(rendered.body, rendered.status as ContentfulStatusCode);

    if (error instanceof HttpException) {
      const { body, status } = httpExceptionBody(error, reporter.catalog);
      return c.json(body, status as ContentfulStatusCode);
    }
    if (error instanceof HTTPException) {
      if (error.status < 500) return error.getResponse();
      return c.json(
        { error: { code: 'internal', message: 'Internal Server Error' } },
        error.status as ContentfulStatusCode,
      );
    }
    const { body, status } = toErrorBody(error, { catalog: reporter.catalog });
    return c.json(body, status as ContentfulStatusCode);
  }

  registerController(controller: Type, moduleId?: string): this {
    const prefix = MetadataRegistry.getControllerPath(controller);
    const options = MetadataRegistry.getControllerOptions(controller);
    const routes = MetadataRegistry.getRoutes(controller);

    // The ModuleLoader registers controllers in their owning module's bucket;
    // fall back to a `__root__` registration only for controllers that arrive
    // here outside the module-loading flow (test harnesses, custom adapters).
    if (moduleId === undefined && !this.container.has(controller)) {
      this.container.register(controller);
    }
    const owners = this.container.getOwnerModuleIds(controller);
    if (moduleId === undefined) {
      if (owners.length !== 1) {
        throw new Error(
          `Cannot register controller ${controller.name}: specify its declaring module ` +
            `(found ${owners.length} owners)`,
        );
      }
      moduleId = owners[0]!;
    } else if (!owners.includes(moduleId)) {
      throw new Error(`Controller ${controller.name} is not registered in module ${moduleId}`);
    }

    const mounted = this.controllers.find((entry) => entry.controller === controller);
    if (mounted && mounted.moduleId !== moduleId) {
      throw new Error(
        `Controller ${controller.name} is already mounted by module ${mounted.moduleId}; ` +
          `cannot mount the same routes for module ${moduleId}. Use distinct controller classes.`,
      );
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

  /** Observe the existing request lifetime without taking ownership of its resources. */
  observeRequests(observer: HttpRequestObserver): () => void {
    this.requestObservers.add(observer);
    return () => {
      this.requestObservers.delete(observer);
    };
  }

  async build(): Promise<HonoApp> {
    const app = new Hono<VelaHonoEnv>();
    this.routeDescriptions = [];

    // HTTP owns one lifetime through both response transmission and managed
    // deferred work. Native waitUntil also retains asynchronous disposal.
    app.use('*', async (c: Context, next: Next) => {
      // Adapter-mounted routes share this same child even without controllers.
      // Start the lifetime before input validation, but snapshot REQUEST_CONTEXT
      // only after the body limiter has normalized the raw Request.
      const child = this.createRequestContainer(c);
      const startedAt = performance.now();
      const observations = [...this.requestObservers].flatMap((observer) => {
        try {
          const observation = observer(c, child);
          if (observation && 'then' in observation) {
            // JavaScript consumers can return a Promise despite the synchronous contract.
            void Promise.resolve(observation).catch(() => {});
            return [];
          }
          return observation ? [observation] : [];
        } catch {
          // Instrumentation must not change application behavior.
          return [];
        }
      });
      let failed = false;
      try {
        await next();
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        const response = c.res;
        const route = routePath(c);
        const streamsResponse =
          c.req.method !== 'HEAD' && response.body !== null && response.status !== 101;
        let status = failed ? undefined : response.status;
        let outcome: HttpRequestCompletion['outcome'] = 'success';
        const finish = async (waitFor?: Promise<unknown>): Promise<void> => {
          try {
            await finishExecutionScope(child, waitFor);
          } catch (error) {
            failed = true;
            // A bodyless response can still be replaced by the outer error handler.
            // Its eventual status is not known at this completion boundary.
            if (!streamsResponse) status = undefined;
            throw error;
          } finally {
            const completion: HttpRequestCompletion = Object.freeze({
              status,
              route: route && route !== '*' ? route : undefined,
              outcome:
                failed || outcome === 'error' || response.status >= 500
                  ? 'error'
                  : outcome === 'cancelled' || c.req.raw.signal.aborted
                    ? 'cancelled'
                    : 'success',
              durationMs: Math.max(0, performance.now() - startedAt),
            });
            for (const observation of observations) {
              try {
                // Async functions are assignable to void callbacks. Observe accidental
                // rejections without extending the already-finished request lifetime.
                void Promise.resolve(observation.complete(completion)).catch(() => {});
              } catch {
                // Observer failures cannot replace a response or a completion error.
              }
            }
          }
        };
        // Hono suppresses HEAD bodies outside the middleware chain. Cancel
        // the untransmitted producer here instead of awaiting a drain that
        // can never happen. Native upgrades must retain their Response.
        if (c.req.method === 'HEAD' && response.body && response.status !== 101) {
          await finish(response.body.cancel());
        } else if (response.body && response.status !== 101) {
          const stream = trackResponseStream(response.body, (result) => {
            outcome = result;
          });
          c.res = new Response(stream.body, response);
          const reporter = resolveErrorReporter(child);
          const completion = finish(stream.done);
          // Observe failures on portable runtimes as well as Workers. Keep
          // the original rejecting promise for the native lifetime owner.
          void completion.catch((error: unknown) => {
            reporter.report(error, {
              edge: 'http',
              source: `${c.req.method} ${c.req.path}`,
              note: 'request completion failed',
            });
          });
          let executionCtx;
          try {
            executionCtx = c.executionCtx;
          } catch {
            // Hono throws when invoked without a native execution context.
          }
          executionCtx?.waitUntil(completion);
        } else {
          await finish();
        }
      }
    });

    // Security boundary: reject oversized input before any user middleware,
    // argument extraction, validation pipe, guard, or signed-body capture can
    // buffer/hash it. Hono also counts streaming bodies without Content-Length.
    app.use('*', async (c, next) => {
      let seeded = false;
      const seedContext = (): void => {
        if (seeded) return;
        this.getRequestContainer(c).setRequestInstance(REQUEST_CONTEXT, createRequestContext(c));
        seeded = true;
      };
      const normalizedNext = async (): Promise<void> => {
        // Hono replaces bodyful requests without Content-Length. Guards,
        // middleware, and injected context must share that exact Request.
        seedContext();
        await next();
      };
      try {
        const maxSize = this.resolveBodyLimit(c.req.path, c.req.method);
        return maxSize === false
          ? await normalizedNext()
          : await honoBodyLimit({ maxSize })(c, normalizedNext);
      } finally {
        // A rejected/failed body never reaches next(). Seed its original
        // request before Hono's error reporter runs inside the active lifetime.
        // Never replace a context already exposed to application code.
        seedContext();
      }
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
        this.wrapMiddlewareWithFilters(async (c, next) => {
          const requestContainer = this.getRequestContainer(c);
          const resolved = await instantiateAsync<NestMiddleware>(entry, requestContainer);
          return resolved.use(c, next);
        }),
      );
    }

    const sortedConsumer = this.consumerMiddlewareDefinitions
      .map((def, index) => ({ def, index, priority: def.priority ?? 0 }))
      .sort((a, b) => a.priority - b.priority || a.index - b.index);

    for (const { def } of sortedConsumer) {
      const matchRoute = this.compileRouteMatcher(def.routes, true);
      const matchExclude = this.compileRouteMatcher(def.excludes, false);

      app.use(
        '*',
        this.wrapMiddlewareWithFilters((c, next) => {
          // Match the path this app routes, not the base of a parent app that
          // mounted it with `parent.route(base, app)`.
          const base = basePath(c);
          const path = base === '/' ? c.req.path : c.req.path.slice(base.length) || '/';
          const method = c.req.method;

          if (!matchRoute(path, method) || matchExclude(path, method)) return next();

          const requestContainer = this.getRequestContainer(c);
          const runChain = async (index: number): Promise<void> => {
            if (index >= def.middleware.length) return next();
            const instance = await instantiateAsync<NestMiddleware>(
              def.middleware[index]!,
              requestContainer,
              def.moduleId,
            );
            const response = await instance.use(c, () => runChain(index + 1));
            if (response instanceof Response) c.res = response;
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
          // Scoped (controller/handler) middleware only — global middleware is
          // applied once by this manager's own global pass, never re-read here.
          const middlewareItems = getScopedComponents(
            'middleware',
            controller,
            route.handlerName,
            this.container,
            moduleId,
          );
          const handler = this.handlerExecutor.create(
            route,
            controller,
            moduleId,
            allParamMetadata,
          );

          const middleware = middlewareItems.map((middlewareItem) =>
            this.wrapMiddlewareWithFilters(async (c, next) => {
              const requestContainer = this.getRequestContainer(c);
              const resolved = await instantiateAsync<NestMiddleware>(
                middlewareItem,
                requestContainer,
                moduleId,
              );
              return resolved.use(c, next);
            }),
          );

          for (const { path: fullPath, version } of this.composeRoutePaths(
            metadata.prefix,
            route,
            metadata.version,
          )) {
            // Register the onion with its method and terminal handler. A
            // path-only app.use() also matches sibling methods/controllers.
            this.registerRoute(app, route.method, fullPath, ...middleware, handler);
            this.routeDescriptions.push({
              method: String(route.method),
              path: fullPath || '/',
              controller: controller.name,
              handler: String(route.handlerName),
              moduleId,
              version,
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
    const resolveGlobalGuards = () =>
      instantiateMany<CanActivate>(this.globalGuards, this.container);
    for (const { controller, metadata, routes } of this.controllers) {
      for (const contributor of contributors) {
        const meta = getMetadata(contributor.claimsMetaKey, controller);
        if (meta === undefined) continue;

        await contributor.buildRoutes(app, {
          controller,
          controllerPrefix: metadata.prefix,
          meta,
          globalPrefix: this.globalPrefix,
          get globalGuards() {
            return resolveGlobalGuards();
          },
          getGlobalComponents: () => this.getGlobalComponents(),
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

  // Every path one route is served on: global prefix, then each version
  // segment, then controller prefix and route path.
  private composeRoutePaths(
    controllerPrefix: string,
    route: { path: string; version?: number | number[] },
    controllerVersion?: number | number[],
  ): Array<{ path: string; version?: number }> {
    const localPath = joinPaths(controllerPrefix, route.path);
    const version = route.version ?? controllerVersion;
    if (version === undefined) return [{ path: joinPaths(this.globalPrefix, localPath) }];
    return (Array.isArray(version) ? version : [version]).map((v) => ({
      path: joinPaths(this.globalPrefix, joinPaths(`/v${v}`, localPath)),
      version: v,
    }));
  }

  // Consumer targets compile into a Hono router so they match with the same
  // `:param` / `*` semantics that route the request. A controller expands to
  // its composed routes; a pattern resolves under the global prefix unless it
  // is `absolute` and, for forRoutes(), also covers the paths beneath it.
  // `'*'` matches everything.
  private compileRouteMatcher(
    targets: Array<RouteInfo | Constructor>,
    coverDescendants: boolean,
  ): (path: string, method: string) => boolean {
    if (targets.length === 0) return () => false;
    const router = new TrieRouter<true>();
    const add = (method: string, pattern: string): void => {
      router.add(method, pattern, true);
      // Hono serves HEAD requests with the GET handler.
      if (method === HttpMethod.GET) router.add(HttpMethod.HEAD, pattern, true);
    };

    for (const target of targets) {
      if (typeof target === 'function') {
        const routes = MetadataRegistry.getRoutes(target);
        if (routes.length === 0) {
          throw new Error(
            `Cannot apply middleware to ${target.name}: ${target.name} declares no routes. ` +
              'Target contributed routes by path instead.',
          );
        }
        const prefix = MetadataRegistry.getControllerPath(target);
        const { version } = MetadataRegistry.getControllerOptions(target);
        for (const route of routes) {
          for (const { path } of this.composeRoutePaths(prefix, route, version)) {
            add(route.method, path);
          }
        }
        continue;
      }

      const method = target.method ?? HttpMethod.ALL;
      if (target.path === '*' || target.path === '/*') {
        add(method, '*');
        continue;
      }
      const path = normalizePath(target.path);
      const prefix = this.globalPrefix.replace(/\/+$/, '');
      // A relative target that repeats the prefix would resolve to
      // '<prefix><prefix>/...' and never match, leaving its routes unguarded.
      if (!target.absolute && prefix && (path === prefix || path.startsWith(`${prefix}/`))) {
        throw new Error(
          `Middleware route '${path}' already includes the global prefix '${prefix}'. ` +
            `Remove '${prefix}' from the route, or pass { path: '${path}', absolute: true } ` +
            'to match it as written.',
        );
      }
      const pattern = target.absolute ? path || '/' : joinPaths(this.globalPrefix, path);
      add(method, pattern);
      if (coverDescendants && !pattern.endsWith('*')) add(method, joinPaths(pattern, '/*'));
    }

    return (path, method) => router.match(method, path)[0].length > 0;
  }

  getControllers(): ControllerRegistration[] {
    return [...this.controllers];
  }
}
