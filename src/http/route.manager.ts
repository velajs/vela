import { type Context, type MiddlewareHandler, Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HttpMethod, ParamType } from '../constants';
import { getMetadata } from '../metadata';
import type { Container } from '../container/container';
import type { Token, Type } from '../container/types';
import type { MiddlewareRouteDefinition } from '../module/middleware';
import { joinPaths } from '../registry/paths';
import { buildExecutionContext } from './execution-context';
import { REQUEST_CONTEXT, createRequestContext } from './request-context';
import { ForbiddenException, HttpException } from '../errors/http-exception';
import { ComponentManager } from '../pipeline/component.manager';
import { shouldFilterCatch } from '../pipeline/decorators';
import type {
  ArgumentMetadata,
  CanActivate,
  ExceptionFilter,
  ExecutionContext,
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
import { getHttpCode, getRedirect, getResponseHeaders } from './decorators';
import type { ControllerRegistration, ParamMetadata, RouteMetadata } from './types';

interface RedirectOverride {
  url: string;
  statusCode?: number;
}

type MethodRegistrar = (app: Hono, path: string, h: (c: Context) => Response | Promise<Response>) => void;
type ParamExtractor = (c: Context, param: ParamMetadata) => unknown | Promise<unknown>;

export interface RouteManagerOptions {
  getClientIp?: (c: Context) => string | null;
  middleware?: MiddlewareHandler[];
  globalPrefix?: string;
}

const defaultGetClientIp = (c: Context): string | null =>
  c.req.raw.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  ?? c.req.raw.headers.get('x-real-ip')
  ?? null;

function parseRedirectResult(result: unknown): RedirectOverride | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  if (!('url' in result)) return undefined;

  const obj = result as { url: unknown; statusCode?: unknown };
  if (typeof obj.url !== 'string') return undefined;

  return {
    url: obj.url,
    ...(typeof obj.statusCode === 'number' ? { statusCode: obj.statusCode } : {}),
  };
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

  private static readonly PARAM_EXTRACTORS = new Map<ParamType, ParamExtractor>([
    [ParamType.PARAM,    (c, p) => p.name ? c.req.param(p.name) : c.req.param()],
    [ParamType.QUERY,    (c, p) => p.name ? c.req.query(p.name) : c.req.query()],
    [ParamType.BODY,     async (c, p) => {
      let body: unknown;
      try { body = await c.req.json(); } catch { return undefined; }
      return p.name && body !== null && typeof body === 'object'
        ? (body as Record<string, unknown>)[p.name]
        : body;
    }],
    [ParamType.HEADERS,  (c, p) => p.name ? c.req.header(p.name) : c.req.header()],
    [ParamType.REQUEST,  (c) => c],
    [ParamType.RESPONSE, (c) => c],
    [ParamType.COOKIE,   (c, p) => p.name ? getCookie(c, p.name) : getCookie(c)],
    [ParamType.RAW_BODY, async (c) => new Uint8Array(await c.req.arrayBuffer())],
  ]);

  private controllers: ControllerRegistration[] = [];
  private globalMiddleware: Array<MiddlewareType | Token<NestMiddleware>> = [];
  private globalPipes: Array<PipeType | Token<PipeTransform>> = [];
  private globalGuards: Array<GuardType | Token<CanActivate>> = [];
  private globalInterceptors: Array<InterceptorType | Token<NestInterceptor>> = [];
  private globalFilters: Array<FilterType | Token<ExceptionFilter>> = [];
  private globalPrefix = '';
  private consumerMiddlewareDefinitions: MiddlewareRouteDefinition[] = [];

  private readonly ipExtractor: (c: Context) => string | null;

  constructor(private container: Container, options: RouteManagerOptions = {}) {
    this.ipExtractor = options.getClientIp ?? defaultGetClientIp;
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

  private instantiate<T>(classOrInstance: Type<T> | Token<T> | T, container: Container): T {
    if (typeof classOrInstance === 'function') {
      if (container.has(classOrInstance as Type<T>)) {
        return container.resolve(classOrInstance as Type<T>);
      }
      return new (classOrInstance as Type<T>)();
    }

    if (container.has(classOrInstance as Token<T>)) {
      return container.resolve(classOrInstance as Token<T>);
    }

    return classOrInstance as T;
  }

  private instantiateMany<T>(
    items: Array<Type<T> | Token<T> | T>,
    container: Container,
  ): T[] {
    return items.map((item) => this.instantiate(item, container));
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
    try {
      const resolved = this.instantiate<NestMiddleware>(
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

  registerController(controller: Type): this {
    const prefix = MetadataRegistry.getControllerPath(controller);
    const options = MetadataRegistry.getControllerOptions(controller);
    const routes = MetadataRegistry.getRoutes(controller);

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

  async build(): Promise<Hono> {
    const app = new Hono();

    // Sort global middleware by priority (lower runs first) with insertion
    // index as tiebreaker so equal priorities preserve registration order.
    const sortedGlobal = this.globalMiddleware
      .map((entry, index) => ({ entry, index, priority: this.getMiddlewarePriority(entry) }))
      .sort((a, b) => (a.priority - b.priority) || (a.index - b.index));

    // Register global middleware on the Hono app
    for (const { entry } of sortedGlobal) {
      app.use('*', (c, next) => {
        const requestContainer = this.getRequestContainer(c);
        const resolved = this.instantiate<NestMiddleware>(entry, requestContainer);
        return resolved.use(c, next);
      });
    }

    // Sort consumer middleware with the same stable-by-index rule.
    const sortedConsumer = this.consumerMiddlewareDefinitions
      .map((def, index) => ({ def, index, priority: def.priority ?? 0 }))
      .sort((a, b) => (a.priority - b.priority) || (a.index - b.index));

    // Register MiddlewareConsumer-configured middleware
    for (const { def } of sortedConsumer) {
      const matchRoute   = this.compileRouteMatcher(def.routes);
      const matchExclude = this.compileRouteMatcher(def.excludes);

      app.use('*', (c, next) => {
        const path   = c.req.path;
        const method = c.req.method;

        if (!matchRoute(path, method) || matchExclude(path, method)) return next();

        const requestContainer = this.getRequestContainer(c);
        const runChain = (index: number): Promise<void> => {
          if (index >= def.middleware.length) return next();
          const instance = this.instantiate<NestMiddleware>(def.middleware[index]!, requestContainer);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (instance.use(c, () => runChain(index + 1)) as Promise<any>).then(() => {});
        };

        return runChain(0);
      });
    }

    // First pass: register all custom routes (must come before CRUD /:id routes)
    for (const { controller, metadata, routes } of this.controllers) {
      if (routes.length > 0) {
        const allParamMetadata = MetadataRegistry.getParameters(controller);

        for (const route of routes) {
          // Determine effective version: route-level overrides controller-level
          const effectiveVersion = route.version ?? metadata.version;

          // Build versioned paths
          const versionedPaths = this.buildVersionedPaths(
            this.globalPrefix,
            metadata.prefix,
            route.path,
            effectiveVersion,
          );

          // Register per-route middleware as Hono middleware before the handler
          const middlewareItems = ComponentManager.getComponents('middleware', controller, route.handlerName);
          const handler = this.createHandler(route, controller, allParamMetadata);

          for (const fullPath of versionedPaths) {
            for (const middlewareItem of middlewareItems) {
              app.use(fullPath, (c, next) => {
                const requestContainer = this.getRequestContainer(c);
                const resolved = this.instantiate<NestMiddleware>(
                  middlewareItem as Type<NestMiddleware> | NestMiddleware,
                  requestContainer,
                );
                return resolved.use(c, next);
              });
            }
            this.registerRoute(app, route.method, fullPath, handler);
          }
        }
      }
    }

    // Second pass: mount CRUD sub-apps (/:id routes registered last)
    for (const { controller, metadata } of this.controllers) {
      const crudConfig = getMetadata('vela:crud', controller);
      if (crudConfig) {
        try {
          const pkg = '@velajs/crud';
          const { buildCrudRoutes } = await import(pkg);
          await buildCrudRoutes(app, controller, metadata.prefix, crudConfig, {
            globalPrefix: this.globalPrefix,
            globalGuards: this.instantiateMany<CanActivate>(this.globalGuards, this.container),
            joinPaths,
          });
        } catch (err) {
          throw new Error(
            `@Crud() requires '@velajs/crud'. Install it: pnpm add @velajs/crud`,
            { cause: err },
          );
        }
      }
    }

    return app;
  }

  private createExecutionContext(
    c: Context,
    controller: Type,
    route: RouteMetadata,
  ): ExecutionContext {
    return buildExecutionContext(c, controller, route.handlerName);
  }

  private createHandler(
    route: RouteMetadata,
    controller: Type,
    allParamMetadata: Map<string | symbol, import('../registry/types').ParameterMetadata[]>,
  ): (c: Context) => Response | Promise<Response> {
    const paramMetadata = (allParamMetadata.get(route.handlerName) || [])
      .sort((a, b) => a.index - b.index) as ParamMetadata[];

    // Read param types once at build time for metatype population.
    // Routed via Reflect so the polyfill funnels both src-level and dist-level
    // consumers to the same registry (matters in tests that import from dist).
    const paramTypes = Reflect.getMetadata('design:paramtypes', controller.prototype, route.handlerName) as
      | unknown[]
      | undefined;

    // Collect controller + method level components at build time
    const methodGuards = ComponentManager.getComponents('guard', controller, route.handlerName);
    const methodPipes = ComponentManager.getComponents('pipe', controller, route.handlerName);
    const methodInterceptors = ComponentManager.getComponents('interceptor', controller, route.handlerName);
    // Filters: reverse order (handler → controller → global) — closest to handler runs first
    const methodFilters = [...ComponentManager.getComponents('filter', controller, route.handlerName)].reverse();

    // Read response decorators at build time
    const httpCode = getHttpCode(controller, route.handlerName);
    const responseHeaders = getResponseHeaders(controller, route.handlerName);
    const redirect = getRedirect(controller, route.handlerName);

    return async (c: Context) => {
      // Combine global + method at request time (allows post-create registration)
      const requestContainer = this.getRequestContainer(c);
      const guards = [
        ...this.instantiateMany<CanActivate>(this.globalGuards, requestContainer),
        ...this.instantiateMany<CanActivate>(methodGuards, requestContainer),
      ];
      const pipes = [
        ...this.instantiateMany<PipeTransform>(this.globalPipes, requestContainer),
        ...this.instantiateMany<PipeTransform>(methodPipes, requestContainer),
      ];
      const interceptors = [
        ...this.instantiateMany<NestInterceptor>(this.globalInterceptors, requestContainer),
        ...this.instantiateMany<NestInterceptor>(methodInterceptors, requestContainer),
      ];
      const filters = [
        ...this.instantiateMany<ExceptionFilter>(methodFilters, requestContainer),
        ...this.instantiateMany<ExceptionFilter>(this.globalFilters, requestContainer),
      ];

      const executionContext = this.createExecutionContext(c, controller, route);

      try {
        const instance = requestContainer.resolve(controller);

        // 1. Extract args + run pipes
        const args = await this.extractArguments(c, paramMetadata, pipes, requestContainer, paramTypes);

        // 2. Guards (fail-fast)
        for (const guard of guards) {
          const canActivate = await guard.canActivate(executionContext);
          if (!canActivate) {
            throw new ForbiddenException();
          }
        }

        // 3. Get handler method
        const method = Reflect.get(instance, route.handlerName);
        if (typeof method !== 'function') {
          throw new Error(`Method ${String(route.handlerName)} not found on controller`);
        }

        // 4. Build core handler
        const coreHandler = async () => Reflect.apply(method, instance, args);

        // 5. Run interceptor chain
        const result = await ComponentManager.runInterceptorChain(
          interceptors,
          executionContext,
          coreHandler,
        );

        // Handle @Redirect
        if (redirect) {
          const overrides = parseRedirectResult(result);
          const finalUrl = overrides?.url ?? redirect.url;
          const finalStatus = overrides?.statusCode ?? redirect.statusCode;
          return c.redirect(finalUrl, finalStatus as 301 | 302 | 303 | 307 | 308);
        }

        // Build response with @HttpCode and @Header support
        const response = this.createResponse(c, result, httpCode);

        // Apply @Header decorators
        for (const [headerName, headerValue] of responseHeaders) {
          response.headers.set(headerName, headerValue);
        }

        return response;
      } catch (error) {
        // Run exception filters
        for (const filter of filters) {
          if (shouldFilterCatch(filter, error)) {
            try {
              const result = await filter.catch(error, executionContext);
              return this.createResponse(c, result);
            } catch {
              break;
            }
          }
        }

        // Default HttpException handling
        if (error instanceof HttpException) {
          const response = error.getResponse();
          const status = error.getStatus() as ContentfulStatusCode;
          return c.json(response, status);
        }

        // Default 500
        return c.json({ statusCode: 500, message: 'Internal Server Error' }, 500);
      }
    };
  }

  private async extractArguments(
    c: Context,
    paramMetadata: ParamMetadata[],
    pipes: PipeTransform[],
    requestContainer: Container,
    paramTypes?: unknown[],
  ): Promise<unknown[]> {
    if (paramMetadata.length === 0) {
      return [c];
    }

    const maxIndex = paramMetadata.at(-1)!.index;
    const args: unknown[] = new Array(maxIndex + 1).fill(undefined);

    for (const param of paramMetadata) {
      let value = await this.extractParam(c, param);

      const metadata: ArgumentMetadata = {
        type: param.type,
        data: param.name,
        metatype: paramTypes?.[param.index] as Type | undefined,
      };

      // Run shared pipes (global + controller + method)
      for (const pipe of pipes) {
        value = await pipe.transform(value, metadata);
      }

      // Run param-level pipes
      if (param.pipes && param.pipes.length > 0) {
        for (const paramPipe of param.pipes) {
          const pipeInstance = this.instantiate<PipeTransform>(paramPipe, requestContainer);
          value = await pipeInstance.transform(value, metadata);
        }
      }

      args[param.index] = value;
    }

    return args;
  }

  private extractParam(c: Context, param: ParamMetadata): unknown | Promise<unknown> {
    if (param.type === ParamType.IP) return this.ipExtractor(c);
    const extractor = RouteManager.PARAM_EXTRACTORS.get(param.type as ParamType);
    if (extractor) return extractor(c, param);
    return param.factory ? param.factory(param.name, c) : undefined;
  }

  private createResponse(c: Context, result: unknown, statusCode?: number): Response {
    if (result instanceof Response) {
      return result;
    }
    if (result === null || result === undefined) {
      return c.body(null, (statusCode ?? 204) as ContentfulStatusCode);
    }
    if (typeof result === 'string') {
      return c.text(result, (statusCode ?? 200) as ContentfulStatusCode);
    }
    return c.json(result as object, (statusCode ?? 200) as ContentfulStatusCode);
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
