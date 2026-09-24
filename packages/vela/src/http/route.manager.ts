import { type Next, Hono } from 'hono';
import type {
  VelaContext as Context,
  VelaHono as HonoApp,
  VelaHonoEnv,
  VelaMiddlewareHandler as MiddlewareHandler,
} from './hono.types';
import { bodyLimit as honoBodyLimit } from 'hono/body-limit';
import { contextStorage } from 'hono/context-storage';
import { baseRoutePath, matchedRoutes, routePath } from 'hono/route';
import { TrieRouter } from 'hono/router/trie-router';
import { splitRoutingPath } from 'hono/utils/url';
import { HttpMethod, Scope } from '../constants';
import {
  BadRequestException,
  NotFoundException,
  PayloadTooLargeException,
} from '../errors/http-exception';
import { createExecutionScope, finishExecutionScope } from '../entrypoint/execution-scope';
import { resolveErrorReporter } from '../exceptions/reporter';
import { getMetadata } from '../metadata';
import type { Container } from '../container/container';
import { reportDiagnostic } from '../container/diagnostics';
import { InjectionToken } from '../container/types';
import type { ProviderSnapshot, Token, TypedToken, Type } from '../container/types';
import type { MiddlewareRouteDefinition, RouteInfo } from '../module/middleware';
import { joinPaths } from '../registry/paths';
import { ArgumentResolver } from './argument-resolver';
import { getRouteContributors } from './route-contributor';
import {
  matchTarget,
  parseTarget,
  samplePaths,
  segmentsBeneath,
  segmentsUnder,
  type RouteTarget,
} from './route-target';
import {
  createRouteComposer,
  normalizeGlobalPrefix,
  type GlobalPrefixOptions,
  type RoutePathOptions,
  type VersioningOptions,
} from './route-paths';
import { buildMiddlewareExecutionContext } from './execution-context';
import { mapFilterResult, sendHttpError } from './error-response';
import { HandlerExecutor } from './handler-executor';
import { instantiate, instantiateMany, instantiateAsync } from './instantiate';
import { REQUEST_CONTEXT, createRequestContext } from './request-context';
import { findRequestContainer, setRequestContainer } from './request-container';
import type { HttpRequestCompletion, HttpRequestObserver } from './request-observer';
import { shouldFilterCatch } from '../pipeline/decorators';
import { getScopedComponents } from '../pipeline/scoped-components';
import {
  declaredField,
  FEATURE_PHASE_RANK,
  guardPhaseRank,
  orderGuardsByPhase,
} from '../pipeline/guard-phase';
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
  /** Prefix for every controller route, as Nest's `app.setGlobalPrefix(prefix)`. */
  globalPrefix?: string;
  /** Routes served without the global prefix (`{ exclude }`). */
  globalPrefixOptions?: GlobalPrefixOptions;
  /** URI versioning: the version segment prefix (default `'v'`). */
  versioning?: VersioningOptions;
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

function priorityOf(value: unknown): number | undefined {
  const priority = declaredField(value, 'priority');
  return typeof priority === 'number' ? priority : undefined;
}

// The entry `owners` has for a handler Hono matched. A parent app that mounts
// this one with route() wraps its handlers.
function findOwner<T>(owners: Map<unknown, T>, handler: unknown): T | undefined {
  for (; typeof handler === 'function'; handler = Reflect.get(handler, '__COMPOSED_HANDLER')) {
    const owner = owners.get(handler);
    if (owner !== undefined) return owner;
  }
  return undefined;
}

// Whether Hono routes a request with `method` to a route or middleware
// registered for `registered`: only its own method or ALL, and HEAD to GET. A
// request's method token 'ALL' is not a wildcard.
function methodReaches(method: string, registered: string): boolean {
  return (
    registered === HttpMethod.ALL ||
    registered === method ||
    (method === HttpMethod.HEAD && registered === HttpMethod.GET)
  );
}

// A resolved path target and the method it accepts. No target matches every path.
interface PathTarget {
  method: string;
  target?: RouteTarget;
}

function isTokenEntry(entry: unknown): entry is Token {
  return (
    typeof entry === 'function' ||
    typeof entry === 'string' ||
    typeof entry === 'symbol' ||
    entry instanceof InjectionToken
  );
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
  private globalPrefixOptions: GlobalPrefixOptions = {};
  private readonly versioning: VersioningOptions;
  private consumerMiddlewareDefinitions: MiddlewareRouteDefinition[] = [];
  // The Hono handler that ends each controller route, with its controller and
  // method, for forRoutes(Controller).
  private readonly routeOwners = new Map<unknown, [Constructor, string]>();
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
    this.versioning = options.versioning ?? {};
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

  /** As Nest's `app.setGlobalPrefix(prefix, { exclude })`; takes effect at the next build. */
  setGlobalPrefix(prefix: string, options: GlobalPrefixOptions = {}): this {
    this.globalPrefix = normalizeGlobalPrefix(prefix);
    this.globalPrefixOptions = options;
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
    return this.addGlobalGuards(guards);
  }

  useGlobalGuardTokens(...guardTokens: Array<TypedToken<CanActivate>>): this {
    return this.addGlobalGuards(guardTokens);
  }

  // Keeps global guards ordered by phase (see GuardPhase), then registration.
  private addGlobalGuards(guards: Array<GuardType | TypedToken<CanActivate>>): this {
    const ranked = [...this.globalGuards, ...guards].map((entry, index) => ({
      entry,
      index,
      rank: this.registeredPhaseRank(entry),
    }));
    this.globalGuards = ranked
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map(({ entry }) => entry);
    return this;
  }

  // A token's registered target declares the phase without being constructed.
  // A factory's guard declares it only once built; transports re-sort the
  // constructed guards (orderGuardsByPhase), so it still runs in its phase.
  private registeredPhaseRank(entry: GuardType | TypedToken<CanActivate>): number {
    const declared = guardPhaseRank(entry);
    if (declared !== undefined || !isTokenEntry(entry)) return declared ?? FEATURE_PHASE_RANK;
    const target = this.componentTarget(entry);
    return guardPhaseRank(target?.instance?.value ?? target?.useClass) ?? FEATURE_PHASE_RANK;
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
    const declared = priorityOf(entry);
    if (declared !== undefined) return declared;
    if (!isTokenEntry(entry)) return 0;

    // A token's registered target (useClass, useExisting, useValue) carries
    // its priority without being constructed, which also keeps request-scoped
    // middleware off the root container.
    const target = this.componentTarget(entry);
    const targetPriority = priorityOf(target?.instance?.value ?? target?.useClass);
    if (targetPriority !== undefined) return targetPriority;
    // A token owned exclusively by unmaterialized lazy modules must not be
    // instantiate-probed here — the probe at route build would defeat the
    // module's deferral (i18n's APP_MIDDLEWARE). Default priority instead;
    // the middleware still materializes on its first request.
    if (this.container.isLazyPending(entry)) return 0;
    if (this.container.getResolvedScope(entry) === Scope.REQUEST) {
      const name = target?.useClass?.name ?? String(entry);
      reportDiagnostic(
        this.container.getDiagnostics(),
        `[vela] Middleware ${name} is request-scoped and declares no static priority, so it ` +
          'sorts at priority 0 among global middleware. Declare `static priority` on the class ' +
          'to order it.',
      );
      return 0;
    }
    try {
      const resolved = instantiate<NestMiddleware>(
        entry as MiddlewareType | TypedToken<NestMiddleware>,
        this.container,
      );
      return priorityOf(resolved) ?? 0;
    } catch {
      // Unresolvable at build time — default 0; the request path reports it.
    }
    return 0;
  }

  // The registration a component token resolves to, following useExisting
  // aliases from their declaring module. Inspection never constructs.
  private componentTarget(token: Token): ProviderSnapshot | undefined {
    const seen = new Set<Token>();
    let current: Token | undefined = token;
    let requester: string | undefined;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const [snapshot] = this.container.getVisibleProviderSnapshots(current, requester);
      if (snapshot?.kind !== 'existing') return snapshot;
      current = snapshot.useExisting;
      requester = snapshot.moduleId;
    }
    return undefined;
  }

  // The first '*' middleware of every request seeds its container. A parent
  // app can serve a route without the app's '*' middleware (Hono's TrieRouter
  // does under a mount base whose '{regex}' parameter must span '/'), which
  // would skip body limits and consumer middleware, so the request fails.
  private getRequestContainer(c: Context): Container {
    const container = findRequestContainer(c);
    if (container) return container;
    throw new Error('Vela middleware chain did not run — unsupported mount');
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
          const filtered = mapFilterResult(c, await filter.catch(error, host), error);
          if (filtered) return filtered;
          break;
        }
      } catch (filterError) {
        reporter.report(filterError, { edge: 'http', source, note: 'middleware filter failed' });
        break;
      }
    }

    return sendHttpError(c, error, reporter, host);
  }

  // Framework rejections (request limits, unmatched routes) are expected
  // client faults: rendered through the application's render hook and the
  // shared renderer, but never reported or offered to exception filters, so
  // a catch-all filter cannot turn them into a success.
  private rejectRequest(c: Context, error: unknown): Response {
    const container = findRequestContainer(c) ?? this.container;
    return sendHttpError(
      c,
      error,
      resolveErrorReporter(container),
      buildMiddlewareExecutionContext(c),
    );
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

  /** How controller routes compose into served paths, for OpenAPI documents. */
  getRoutePathOptions(): RoutePathOptions {
    return {
      globalPrefix: this.globalPrefix,
      globalPrefixOptions: this.globalPrefixOptions,
      versioning: this.versioning,
    };
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
    const composeRoutePaths = createRouteComposer(this.getRoutePathOptions());

    // HTTP owns one lifetime through both response transmission and managed
    // deferred work. Native waitUntil also retains asynchronous disposal.
    app.use('*', async (c: Context, next: Next) => {
      // Adapter-mounted routes share this same child even without controllers.
      // Start the lifetime before input validation, but snapshot REQUEST_CONTEXT
      // only after the body limiter has normalized the raw Request.
      const { container: child } = createExecutionScope(this.container, {
        signal: c.req.raw.signal,
      });
      setRequestContainer(c, child);
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
          : await honoBodyLimit({
              maxSize,
              onError: (limited) => this.rejectRequest(limited, new PayloadTooLargeException()),
            })(c, normalizedNext);
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
        return this.rejectRequest(
          c,
          new BadRequestException('Query string exceeds the configured limit'),
        );
      }
      if (rawQuery.length > 0) {
        let count = 0;
        for (const [key] of new URL(c.req.raw.url).searchParams) {
          count++;
          if (this.queryMaxParameters !== false && count > this.queryMaxParameters) {
            return this.rejectRequest(
              c,
              new BadRequestException('Query parameter count exceeds the configured limit'),
            );
          }
          if (this.queryMaxDepth !== false && queryKeyDepth(key) > this.queryMaxDepth) {
            return this.rejectRequest(
              c,
              new BadRequestException('Query parameter depth exceeds the configured limit'),
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
      const matches = this.compileTargets(def);
      app.use(
        '*',
        this.wrapMiddlewareWithFilters((c, next) => {
          if (!matches(c)) return next();

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

    // Every registration from here on serves a route (controllers, then contributors).
    const firstRoute = app.routes.length;

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

          for (const { path: fullPath, version } of composeRoutePaths(
            metadata.prefix,
            route,
            metadata.version,
          )) {
            // Register the onion with its method and terminal handler. A
            // path-only app.use() also matches sibling methods/controllers.
            this.registerRoute(app, route.method, fullPath, ...middleware, handler);
            this.routeOwners.set(app.routes.at(-1)!.handler, [controller, route.method]);
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
      orderGuardsByPhase(instantiateMany<CanActivate>(this.globalGuards, this.container));
    for (const { controller, metadata, routes } of this.controllers) {
      for (const contributor of contributors) {
        const meta = getMetadata(contributor.claimsMetaKey, controller);
        if (meta === undefined) continue;

        await contributor.buildRoutes(app, {
          controller,
          controllerPrefix: metadata.prefix,
          meta,
          globalPrefix: this.globalPrefix,
          routePathOptions: this.getRoutePathOptions(),
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

    this.checkMiddlewareTargets(app.routes.slice(firstRoute));
    app.notFound((c) => this.rejectRequest(c, new NotFoundException()));
    return app;
  }

  // Relative path targets resolve under the global prefix, so a target for a
  // route served outside it (a contributor's RPC endpoint, say) would match
  // nothing and leave that route without its middleware. Checked once this
  // build has registered every route: a target that reaches no route under the
  // prefix but reaches one outside it throws. A forRoutes() target that
  // reaches no route at all is reported, because the route may still be added
  // to the Hono app after startup (mountOpenApi(), WebSocket upgrades, raw Hono
  // routes). A target reaches a route through a concrete path, shaped like
  // either of them, that the target and Hono's TrieRouter both match, with
  // each constrained route parameter read as a plain ':name' segment so no
  // sample has to satisfy its '{regex}'. These samples only drive this check,
  // never a request's decision.
  private checkMiddlewareTargets(
    registered: ReadonlyArray<{ method: string; path: string }>,
  ): void {
    if (this.consumerMiddlewareDefinitions.length === 0) return;
    // A contributor's own app.use('*') middleware serves no route of its own.
    const routes = registered.filter(
      ({ method, path }) => method !== HttpMethod.ALL || (path !== '*' && path !== '/*'),
    );
    const router = new TrieRouter<{ method: string; path: string }>();
    // A constrained route parameter reads as one segment, whatever its value.
    for (const route of routes) {
      router.add(
        HttpMethod.ALL,
        `/${splitRoutingPath(route.path)
          .map((part) => part.replace(/^(:[^{}]+)\{.*\}$/s, '$1'))
          .join('/')}`,
        route,
      );
    }
    const prefix = this.globalPrefix.replace(/\/+$/, '');
    const served = (target: RouteTarget, method: string, outside?: boolean): boolean => {
      const shape = `/${[...target.parts, ...(target.tail ? [target.tail === '*' ? '*' : ':_'] : [])].join('/')}`;
      const reaches = (route: { method: string; path: string }) =>
        !(outside && (route.path === prefix || route.path.startsWith(`${prefix}/`))) &&
        (method === HttpMethod.ALL || methodReaches(method, route.method));
      return routes.some(
        (route) =>
          reaches(route) &&
          [...samplePaths(shape, route.path), ...samplePaths(route.path, shape)].some(
            (sample) =>
              matchTarget(target, segmentsBeneath(sample.split('/'), 1)!) &&
              router.match(HttpMethod.ALL, sample)[0].some(([other]) => reaches(other)),
          ),
      );
    };

    for (const definition of this.consumerMiddlewareDefinitions) {
      const targets = [
        ...definition.routes.map((target) => ({ target, forRoutes: true })),
        ...definition.excludes.map((target) => ({ target, forRoutes: false })),
      ];
      for (const { target, forRoutes } of targets) {
        if (typeof target === 'function' || target.absolute) continue;
        const { method, target: resolved } = this.resolveTarget(target, forRoutes);
        // `'*'`, `'/*'` and `'{*splat}'` match every request.
        if (!resolved || served(resolved, method)) continue;
        const path = `/${target.path.replace(/^\//, '')}`;
        const pattern = joinPaths(prefix, path);
        const outside = this.resolveTarget({ ...target, absolute: true }, forRoutes).target!;
        if (prefix && served(outside, method, true)) {
          throw new Error(
            `Middleware route '${target.path}' resolves to '${pattern}' under the global prefix ` +
              `'${prefix}', which serves no route, but '${path}' is served outside the prefix. ` +
              `Pass { path: '${path}', absolute: true } to match it as written.`,
          );
        }
        if (!forRoutes) continue;
        reportDiagnostic(
          this.container.getDiagnostics(),
          `[vela] Middleware route '${target.path}' resolves to '${pattern}', which matches no ` +
            'route registered at startup, so the middleware never runs for it. For a route added ' +
            'to the Hono app later (mountOpenApi(), WebSocket upgrades, app.getHonoApp()), pass ' +
            `the path it is served on with absolute: true, such as { path: '${pattern}', ` +
            'absolute: true }.',
        );
      }
    }
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

  // Whether a consumer middleware definition applies to the request. A
  // controller target matches when one of its handlers serves the request: the
  // first controller route after the running middleware in the chain Hono
  // matched (a HEAD route is registered on GET and passes GET requests on). A
  // path target (see route-target.ts) matches the request path beneath the
  // base a parent app mounted this app under, with a method it accepts. When
  // that base cannot be measured, path targets count as matching for
  // forRoutes() and as not matching for exclude(), so the middleware runs.
  private compileTargets({ routes, excludes }: MiddlewareRouteDefinition): (c: Context) => boolean {
    const controllers = new Set<Constructor>();
    const included: PathTarget[] = [];
    for (const target of routes) {
      if (typeof target !== 'function') {
        included.push(this.resolveTarget(target, true));
      } else if (MetadataRegistry.getRoutes(target).length === 0) {
        throw new Error(
          `Cannot apply middleware to ${target.name}: ${target.name} declares no routes. ` +
            'Target contributed routes by path instead.',
        );
      } else {
        controllers.add(target);
      }
    }
    const excluded = excludes.map((target) => this.resolveTarget(target, false));

    return (c) => {
      const method = c.req.method;
      let measured = false;
      let segments: string[] | undefined;
      const hit = ({ method: accepted, target }: PathTarget, forRoutes: boolean): boolean => {
        if (!methodReaches(method, accepted)) return false;
        if (!target) return true;
        if (!measured) {
          measured = true;
          segments = segmentsUnder(c.req.path, baseRoutePath(c) || '/', (name) =>
            c.req.param(name),
          );
        }
        return segments ? matchTarget(target, segments, forRoutes) : forRoutes;
      };
      let matched = included.some((target) => hit(target, true));
      if (!matched && controllers.size) {
        for (const route of matchedRoutes(c).slice(c.req.routeIndex + 1)) {
          const owner = findOwner(this.routeOwners, route.handler);
          if (owner && (owner[1] !== HttpMethod.HEAD || method === HttpMethod.HEAD)) {
            matched = controllers.has(owner[0]);
            break;
          }
        }
      }
      return matched && !excluded.some((target) => hit(target, false));
    };
  }

  // A path target under the global prefix unless it is absolute, covering the
  // paths beneath it for forRoutes(). `'*'`, `'/*'` and `'{*splat}'` match
  // every path, never under the prefix. Nest 11 reads a trailing `(.*)` as
  // `{*path}`, so in forRoutes() it also covers its parent path, and a lone
  // `(.*)` matches every path; exclude() keeps the strict reading.
  private resolveTarget(
    { path, method = HttpMethod.ALL, absolute }: RouteInfo,
    forRoutes: boolean,
  ): PathTarget {
    const legacy = forRoutes && path.endsWith('(.*)');
    let target = parseTarget(path);
    if (!target.parts.length && (legacy || target.tail === '*')) return { method };
    const prefix = this.globalPrefix.replace(/\/+$/, '');
    if (prefix && !absolute) {
      const written = `/${path.replace(/^\//, '')}`;
      // A relative target that repeats the prefix would resolve to
      // '<prefix><prefix>/...' and never match, leaving its routes unguarded.
      if (written === prefix || written.startsWith(`${prefix}/`)) {
        throw new Error(
          `Middleware route '${written}' already includes the global prefix '${prefix}'. ` +
            `Remove '${prefix}' from the route, or pass { path: '${written}', absolute: true } ` +
            'to match it as written.',
        );
      }
      target = parseTarget(joinPaths(prefix, written));
    }
    // A forRoutes() target also covers every path beneath it, and a trailing
    // '/' covers the same paths as its parent.
    const { parts, tail } = target;
    return {
      method,
      target:
        forRoutes && (!tail || legacy)
          ? { parts: parts.at(-1) === '' ? parts.slice(0, -1) : parts, tail: '*' }
          : target,
    };
  }

  getControllers(): ControllerRegistration[] {
    return [...this.controllers];
  }
}
