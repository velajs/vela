import 'reflect-metadata';
import { type Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HttpMethod, ParamType } from '../constants';
import type { Container } from '../container/container';
import type { Type } from '../container/types';
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
  private globalMiddleware: NestMiddleware[] = [];
  private globalPipes: PipeTransform[] = [];
  private globalGuards: CanActivate[] = [];
  private globalInterceptors: NestInterceptor[] = [];
  private globalFilters: ExceptionFilter[] = [];
  private globalPrefix = '';

  constructor(private container: Container) {}

  setGlobalPrefix(prefix: string): this {
    this.globalPrefix = prefix && !prefix.startsWith('/') ? `/${prefix}` : prefix;
    return this;
  }

  useGlobalMiddleware(...middleware: MiddlewareType[]): this {
    for (const mw of middleware) {
      this.globalMiddleware.push(this.instantiate<NestMiddleware>(mw));
    }
    return this;
  }

  useGlobalPipes(...pipes: PipeType[]): this {
    for (const pipe of pipes) {
      this.globalPipes.push(this.instantiate<PipeTransform>(pipe));
    }
    return this;
  }

  useGlobalGuards(...guards: GuardType[]): this {
    for (const guard of guards) {
      this.globalGuards.push(this.instantiate<CanActivate>(guard));
    }
    return this;
  }

  useGlobalInterceptors(...interceptors: InterceptorType[]): this {
    for (const interceptor of interceptors) {
      this.globalInterceptors.push(this.instantiate<NestInterceptor>(interceptor));
    }
    return this;
  }

  useGlobalFilters(...filters: FilterType[]): this {
    for (const filter of filters) {
      this.globalFilters.push(this.instantiate<ExceptionFilter>(filter));
    }
    return this;
  }

  private instantiate<T>(classOrInstance: Type<T> | T): T {
    if (typeof classOrInstance !== 'function') {
      return classOrInstance as T;
    }
    if (this.container.has(classOrInstance as Type<T>)) {
      return this.container.resolve(classOrInstance as Type<T>);
    }
    return new (classOrInstance as Type<T>)();
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
      app.use('*', (c, next) => mw.use(c, next));
    }

    // First pass: register all custom routes (must come before CRUD /:id routes)
    for (const { controller, metadata, routes } of this.controllers) {
      if (routes.length > 0) {
        const instance = this.container.resolve(controller);
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
          const resolvedMw = ComponentManager.resolveMiddleware(middlewareItems);

          const handler = this.createHandler(instance, route, controller, allParamMetadata);

          for (const fullPath of versionedPaths) {
            for (const mw of resolvedMw) {
              app.use(fullPath, (c, next) => mw.use(c, next));
            }
            this.registerRoute(app, route.method, fullPath, handler);
          }
        }
      }
    }

    // Second pass: mount CRUD sub-apps (/:id routes registered last)
    for (const { controller, metadata } of this.controllers) {
      const crudConfig = this.getCrudConfig(controller);
      if (crudConfig) {
        await this.buildCrudRoutes(app, controller, metadata.prefix, crudConfig);
      }
    }

    return app;
  }

  private getCrudConfig(controller: Type): import('../crud/types').CrudConfig | undefined {
    return Reflect.getMetadata('vela:crud', controller);
  }

  private async buildCrudRoutes(
    app: Hono,
    controller: Type,
    prefix: string,
    crudConfig: import('../crud/types').CrudConfig,
  ): Promise<void> {
    // Dynamic import of optional peer dependencies
    let fromHono: Function;
    let registerCrud: Function;
    let defineEndpoints: Function;
    let OpenAPIHono: new () => unknown;

    try {
      const [honoCrud, honoZodOpenapi] = await Promise.all([
        import('hono-crud'),
        import('@hono/zod-openapi'),
      ]);
      fromHono = honoCrud.fromHono;
      registerCrud = honoCrud.registerCrud;
      defineEndpoints = honoCrud.defineEndpoints;
      OpenAPIHono = honoZodOpenapi.OpenAPIHono;
    } catch {
      throw new Error(
        `@Crud() requires 'hono-crud' and '@hono/zod-openapi' as dependencies. ` +
        `Install them: bun add hono-crud @hono/zod-openapi`,
      );
    }

    // Determine which CRUD operations to enable
    const allEndpoints: import('../crud/types').CrudEndpointName[] =
      ['create', 'list', 'read', 'update', 'delete'];

    let enabledEndpoints = allEndpoints;
    if (crudConfig.only) {
      enabledEndpoints = crudConfig.only;
    } else if (crudConfig.except) {
      enabledEndpoints = allEndpoints.filter((e) => !crudConfig.except!.includes(e));
    }

    // Build config for defineEndpoints
    const endpointsDef: Record<string, unknown> = { meta: crudConfig.meta };
    for (const name of enabledEndpoints) {
      endpointsDef[name] = crudConfig.endpoints?.[name] ?? {};
    }

    // Generate endpoint classes via hono-crud
    const endpoints = defineEndpoints(endpointsDef, crudConfig.adapters);

    // Convert vela guards → Hono middleware for CRUD routes
    const guardItems = ComponentManager.getComponents('guard', controller, '' as string | symbol);
    const guards = ComponentManager.resolveGuards(guardItems);
    const middlewares: Function[] = [];

    if (guards.length > 0 || this.globalGuards.length > 0) {
      const allGuards = [...this.globalGuards, ...guards];

      const guardMiddleware = async (c: Context, next: Function) => {
        const executionContext: ExecutionContext = {
          getClass: () => controller,
          getHandler: () => 'crud',
          getContext: <T = Context>() => c as T,
          getRequest: () => c.req.raw,
        };

        for (const guard of allGuards) {
          const canActivate = await guard.canActivate(executionContext);
          if (!canActivate) {
            return c.json({ statusCode: 403, message: 'Forbidden' }, 403);
          }
        }

        return next();
      };

      middlewares.push(guardMiddleware);
    }

    // Create OpenAPIHono sub-app, proxy it via fromHono, register CRUD endpoints
    const subApp = fromHono(new OpenAPIHono());
    registerCrud(subApp, '', endpoints, {
      middlewares: middlewares.length > 0 ? middlewares : undefined,
    });

    // Mount sub-app at controller prefix
    const mountPath = this.joinPaths(this.globalPrefix, prefix) || '/';
    app.route(mountPath, subApp);
  }

  private createExecutionContext(
    c: Context,
    controller: Type,
    route: RouteMetadata,
  ): ExecutionContext {
    return {
      getClass: () => controller,
      getHandler: () => route.handlerName,
      getContext: <T = Context>() => c as T,
      getRequest: () => c.req.raw,
    };
  }

  private createHandler(
    instance: object,
    route: RouteMetadata,
    controller: Type,
    allParamMetadata: Map<string | symbol, import('../registry/types').ParameterMetadata[]>,
  ): (c: Context) => Response | Promise<Response> {
    const paramMetadata = (allParamMetadata.get(route.handlerName) || [])
      .sort((a, b) => a.index - b.index) as ParamMetadata[];

    // Pre-resolve controller + method level components at build time
    const methodGuards = ComponentManager.getComponents('guard', controller, route.handlerName);
    const methodPipes = ComponentManager.getComponents('pipe', controller, route.handlerName);
    const methodInterceptors = ComponentManager.getComponents('interceptor', controller, route.handlerName);
    const methodFilters = ComponentManager.getComponents('filter', controller, route.handlerName);

    const resolvedMethodGuards = ComponentManager.resolveGuards(methodGuards);
    const resolvedMethodPipes = ComponentManager.resolvePipes(methodPipes);
    const resolvedMethodInterceptors = ComponentManager.resolveInterceptors(methodInterceptors);
    // Filters: reverse order (handler → controller → global) — closest to handler runs first
    const resolvedMethodFilters = ComponentManager.resolveFilters([...methodFilters].reverse());

    // Read response decorators at build time
    const httpCode = getHttpCode(controller, route.handlerName);
    const responseHeaders = getResponseHeaders(controller, route.handlerName);
    const redirect = getRedirect(controller, route.handlerName);

    return async (c: Context) => {
      // Create a child container for request-scoped providers
      const requestContainer = this.container.createChild();
      c.set('container', requestContainer);

      // Combine global + method at request time (allows post-create registration)
      const guards = [...this.globalGuards, ...resolvedMethodGuards];
      const pipes = [...this.globalPipes, ...resolvedMethodPipes];
      const interceptors = [...this.globalInterceptors, ...resolvedMethodInterceptors];
      const filters = [...resolvedMethodFilters, ...this.globalFilters];

      const executionContext = this.createExecutionContext(c, controller, route);

      try {
        // 1. Extract args + run pipes
        const args = await this.extractArguments(c, paramMetadata, pipes);

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
        metatype: undefined,
      };

      // Run shared pipes (global + controller + method)
      for (const pipe of pipes) {
        value = await pipe.transform(value, metadata);
      }

      // Run param-level pipes
      if (param.pipes && param.pipes.length > 0) {
        for (const paramPipe of param.pipes) {
          const pipeInstance = this.instantiate<PipeTransform>(paramPipe);
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

  getControllers(): ControllerRegistration[] {
    return [...this.controllers];
  }
}
