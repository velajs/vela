import { type Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HttpMethod, ParamType } from '../constants';
import { getMetadata } from '../metadata';
import type { Container } from '../container/container';
import type { Token, Type } from '../container/types';
import type { MiddlewareRouteDefinition } from './middleware-consumer';
import { RequestMethod } from './middleware-consumer';
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
  private controllers: ControllerRegistration[] = [];
  private globalMiddleware: Array<MiddlewareType | Token<NestMiddleware>> = [];
  private globalPipes: Array<PipeType | Token<PipeTransform>> = [];
  private globalGuards: Array<GuardType | Token<CanActivate>> = [];
  private globalInterceptors: Array<InterceptorType | Token<NestInterceptor>> = [];
  private globalFilters: Array<FilterType | Token<ExceptionFilter>> = [];
  private globalPrefix = '';
  private consumerMiddlewareDefinitions: MiddlewareRouteDefinition[] = [];

  constructor(private container: Container) {}

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

  private getRequestContainer(c: Context): Container {
    const existing = c.get('container') as Container | undefined;
    if (existing) {
      return existing;
    }

    const child = this.container.createChild();
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

    // Register global middleware on the Hono app
    for (const mw of this.globalMiddleware) {
      app.use('*', (c, next) => {
        const requestContainer = this.getRequestContainer(c);
        const resolved = this.instantiate<NestMiddleware>(mw, requestContainer);
        return resolved.use(c, next);
      });
    }

    // Register MiddlewareConsumer-configured middleware
    for (const def of this.consumerMiddlewareDefinitions) {
      app.use('*', (c, next) => {
        const reqPath = c.req.path;
        const reqMethod = c.req.method;

        const matches = def.routes.some((route) => {
          if (!this.matchesConsumerPath(reqPath, route.path)) return false;
          if (route.method && route.method !== RequestMethod.ALL) {
            if (reqMethod !== route.method) return false;
          }
          return true;
        });

        if (!matches) return next();

        const excluded = def.excludes.some((exclude) => {
          if (!this.matchesConsumerPath(reqPath, exclude.path)) return false;
          if (exclude.method && exclude.method !== RequestMethod.ALL) {
            if (reqMethod !== exclude.method) return false;
          }
          return true;
        });

        if (excluded) return next();

        const requestContainer = this.getRequestContainer(c);
        const runChain = (index: number): Promise<Response | void> => {
          if (index >= def.middleware.length) return next();
          const instance = this.instantiate<NestMiddleware>(def.middleware[index]!, requestContainer);
          return instance.use(c, () => runChain(index + 1));
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
            joinPaths: this.joinPaths.bind(this),
          });
        } catch {
          throw new Error(
            `@Crud() requires '@velajs/crud'. Install it: bun add @velajs/crud`,
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
    return {
      getType: <T extends string = 'http'>() => 'http' as T,
      getClass: () => controller,
      getHandler: () => route.handlerName,
      getContext: <T = Context>() => c as T,
      getRequest: () => c.req.raw,
    };
  }

  private createHandler(
    route: RouteMetadata,
    controller: Type,
    allParamMetadata: Map<string | symbol, import('../registry/types').ParameterMetadata[]>,
  ): (c: Context) => Response | Promise<Response> {
    const paramMetadata = (allParamMetadata.get(route.handlerName) || [])
      .sort((a, b) => a.index - b.index) as ParamMetadata[];

    // Read param types once at build time for metatype population
    const paramTypes = Reflect.getMetadata(
      'design:paramtypes',
      controller.prototype,
      route.handlerName,
    ) as unknown[] | undefined;

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

    const maxIndex = Math.max(...paramMetadata.map((p) => p.index));
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

  private async extractParam(c: Context, param: ParamMetadata): Promise<unknown> {
    switch (param.type) {
      case ParamType.PARAM:
        return param.name ? c.req.param(param.name) : c.req.param();

      case ParamType.QUERY:
        return param.name ? c.req.query(param.name) : c.req.query();

      case ParamType.BODY:
        try {
          return await c.req.json();
        } catch {
          return undefined;
        }

      case ParamType.HEADERS:
        if (param.name) {
          return c.req.header(param.name);
        }
        const headers: Record<string, string> = {};
        c.req.raw.headers.forEach((value, key) => {
          headers[key] = value;
        });
        return headers;

      case ParamType.REQUEST:
        return c;

      case ParamType.IP:
        return c.req.raw.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
          c.req.raw.headers.get('x-real-ip') ??
          null;

      default:
        // Custom param decorator — use factory if available
        if (param.factory) {
          return param.factory(param.name, c);
        }
        return undefined;
    }
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
    method: string | HttpMethod,
    path: string,
    handler: (c: Context) => Response | Promise<Response>,
  ): void {
    const normalizedPath = path || '/';
    switch (method) {
      case HttpMethod.GET:
        app.get(normalizedPath, handler);
        break;
      case HttpMethod.POST:
        app.post(normalizedPath, handler);
        break;
      case HttpMethod.PUT:
        app.put(normalizedPath, handler);
        break;
      case HttpMethod.PATCH:
        app.patch(normalizedPath, handler);
        break;
      case HttpMethod.DELETE:
        app.delete(normalizedPath, handler);
        break;
      case HttpMethod.OPTIONS:
        app.options(normalizedPath, handler);
        break;
      case HttpMethod.HEAD:
        app.on('HEAD', normalizedPath, handler);
        break;
      default:
        app.on(method.toUpperCase(), normalizedPath, handler);
    }
  }

  private buildVersionedPaths(
    globalPrefix: string,
    controllerPrefix: string,
    routePath: string,
    version?: number | number[],
  ): string[] {
    if (version === undefined) {
      return [this.joinPaths(globalPrefix, this.joinPaths(controllerPrefix, routePath))];
    }

    const versions = Array.isArray(version) ? version : [version];
    return versions.map((v) => {
      const versionSegment = `/v${v}`;
      return this.joinPaths(globalPrefix, this.joinPaths(versionSegment, this.joinPaths(controllerPrefix, routePath)));
    });
  }

  private joinPaths(prefix: string, path: string): string {
    const cleanPrefix = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    const cleanPath = path && !path.startsWith('/') ? `/${path}` : path;
    return `${cleanPrefix}${cleanPath}` || '/';
  }

  private matchesConsumerPath(reqPath: string, routePath: string): boolean {
    if (routePath === '*') return true;
    const normalized = routePath.startsWith('/') ? routePath : `/${routePath}`;
    if (reqPath === normalized) return true;
    if (reqPath.startsWith(`${normalized}/`)) return true;
    if (normalized.endsWith('*')) {
      return reqPath.startsWith(normalized.slice(0, -1));
    }
    return false;
  }

  getControllers(): ControllerRegistration[] {
    return [...this.controllers];
  }
}
