import { type Context, type MiddlewareHandler, Hono } from 'hono';
import { HttpMethod } from '../constants';
import { getMetadata } from '../metadata';
import type { Container } from '../container/container';
import type { Token, Type } from '../container/types';
import type { MiddlewareRouteDefinition } from '../module/middleware';
import { joinPaths } from '../registry/paths';
import { ArgumentResolver } from './argument-resolver';
import { HandlerExecutor } from './handler-executor';
import { instantiate, instantiateMany } from './instantiate';
import { REQUEST_CONTEXT, createRequestContext } from './request-context';
import { ComponentManager } from '../pipeline/component.manager';
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

export interface RouteManagerOptions {
  getClientIp?: (c: Context) => string | null;
  middleware?: MiddlewareHandler[];
  globalPrefix?: string;
}

const defaultGetClientIp = (c: Context): string | null =>
  c.req.raw.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  ?? c.req.raw.headers.get('x-real-ip')
  ?? null;

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

  private readonly handlerExecutor: HandlerExecutor;

  constructor(private container: Container, options: RouteManagerOptions = {}) {
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

    for (const { entry } of sortedGlobal) {
      app.use('*', (c, next) => {
        const requestContainer = this.getRequestContainer(c);
        const resolved = instantiate<NestMiddleware>(entry, requestContainer);
        return resolved.use(c, next);
      });
    }

    const sortedConsumer = this.consumerMiddlewareDefinitions
      .map((def, index) => ({ def, index, priority: def.priority ?? 0 }))
      .sort((a, b) => (a.priority - b.priority) || (a.index - b.index));

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
          const instance = instantiate<NestMiddleware>(def.middleware[index]!, requestContainer);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (instance.use(c, () => runChain(index + 1)) as Promise<any>).then(() => {});
        };

        return runChain(0);
      });
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

          const middlewareItems = ComponentManager.getComponents('middleware', controller, route.handlerName);
          const handler = this.handlerExecutor.create(route, controller, allParamMetadata);

          for (const fullPath of versionedPaths) {
            for (const middlewareItem of middlewareItems) {
              app.use(fullPath, (c, next) => {
                const requestContainer = this.getRequestContainer(c);
                const resolved = instantiate<NestMiddleware>(
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

    // Second pass: mount CRUD sub-apps (/:id routes registered last).
    for (const { controller, metadata } of this.controllers) {
      const crudConfig = getMetadata('vela:crud', controller);
      if (crudConfig) {
        try {
          const pkg = '@velajs/crud';
          const { buildCrudRoutes } = await import(pkg);
          await buildCrudRoutes(app, controller, metadata.prefix, crudConfig, {
            globalPrefix: this.globalPrefix,
            globalGuards: instantiateMany<CanActivate>(this.globalGuards, this.container),
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
