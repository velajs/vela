import 'reflect-metadata';
import { HttpMethod, METADATA_KEYS, ParamType, Scope } from '../constants';
import { MetadataRegistry } from '../registry/metadata.registry';
import type { Constructor, PipeType } from '../registry/types';
import type { ControllerOptions } from './types';
import type { ExecutionContext } from '../pipeline/types';

function normalizePath(path: string): string {
  return path && !path.startsWith('/') ? `/${path}` : path;
}

/**
 * Marks a class as a controller.
 * Accepts a prefix string or an options object with prefix and version.
 *
 * @example
 * ```ts
 * @Controller('/users')
 * @Controller({ prefix: '/users', version: 1 })
 * @Controller({ prefix: '/users', version: [1, 2] })
 * ```
 */
export function Controller(prefixOrOptions?: string | ControllerOptions): ClassDecorator {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  return (target: Function) => {
    let prefix: string;
    let version: number | number[] | undefined;

    if (typeof prefixOrOptions === 'string') {
      prefix = prefixOrOptions;
    } else if (prefixOrOptions) {
      prefix = prefixOrOptions.prefix ?? '';
      version = prefixOrOptions.version;
    } else {
      prefix = '';
    }

    MetadataRegistry.setControllerPath(target, normalizePath(prefix));

    if (version !== undefined) {
      MetadataRegistry.setControllerOptions(target, { version });
    }

    Reflect.defineMetadata(METADATA_KEYS.INJECTABLE, true, target);
    Reflect.defineMetadata(METADATA_KEYS.SCOPE, Scope.SINGLETON, target);
  };
}

/**
 * Override the version for a specific route method.
 *
 * @example
 * ```ts
 * @Controller({ prefix: '/users', version: 1 })
 * class UserController {
 *   @Get()
 *   listV1() { ... }          // GET /v1/users
 *
 *   @Version(2)
 *   @Get()
 *   listV2() { ... }          // GET /v2/users
 * }
 * ```
 */
const ROUTE_VERSION_PREFIX = 'vela:route-version:';

export function Version(version: number | number[]): MethodDecorator {
  return (target: object, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
    const versionKey = `${ROUTE_VERSION_PREFIX}${String(propertyKey)}`;
    Reflect.defineMetadata(versionKey, version, target.constructor);

    // If route was already registered (decorator ran after @Get), patch it
    const routes = MetadataRegistry.getRoutes(target.constructor);
    const route = routes.find((r) => r.handlerName === propertyKey);
    if (route) {
      route.version = version;
    }
  };
}

export function getRouteVersion(
  target: Constructor,
  propertyKey: string | symbol,
): number | number[] | undefined {
  const versionKey = `${ROUTE_VERSION_PREFIX}${String(propertyKey)}`;
  return Reflect.getMetadata(versionKey, target);
}

function createMethodDecorator(method: HttpMethod) {
  return (path = ''): MethodDecorator => {
    return (target: object, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
      const normalizedPath = normalizePath(path);

      // Check for @Version metadata on this method
      const versionKey = `vela:route-version:${String(propertyKey)}`;
      const version: number | number[] | undefined =
        Reflect.getMetadata(versionKey, target.constructor);

      MetadataRegistry.addRoute(target.constructor, {
        method: method as string,
        path: normalizedPath,
        handlerName: propertyKey,
        ...(version !== undefined ? { version } : {}),
      });
    };
  };
}

export const Get = createMethodDecorator(HttpMethod.GET);
export const Post = createMethodDecorator(HttpMethod.POST);
export const Put = createMethodDecorator(HttpMethod.PUT);
export const Patch = createMethodDecorator(HttpMethod.PATCH);
export const Delete = createMethodDecorator(HttpMethod.DELETE);
export const Options = createMethodDecorator(HttpMethod.OPTIONS);
export const Head = createMethodDecorator(HttpMethod.HEAD);

// Parameter decorators

const CUSTOM_PARAM_TYPE = 'custom';

function createBuiltinParamDecorator(type: ParamType) {
  return (nameOrPipe?: string | PipeType, ...pipes: PipeType[]): ParameterDecorator => {
    return (target: object, propertyKey: string | symbol | undefined, parameterIndex: number) => {
      if (propertyKey === undefined) {
        throw new Error('Parameter decorators can only be used on method parameters');
      }

      let name: string | undefined;
      let allPipes: PipeType[];

      if (typeof nameOrPipe === 'string') {
        name = nameOrPipe;
        allPipes = pipes;
      } else if (nameOrPipe !== undefined) {
        name = undefined;
        allPipes = [nameOrPipe, ...pipes];
      } else {
        name = undefined;
        allPipes = pipes;
      }

      MetadataRegistry.addParameter(
        target.constructor,
        propertyKey,
        {
          index: parameterIndex,
          type,
          name,
          ...(allPipes.length > 0 ? { pipes: allPipes } : {}),
        },
      );
    };
  };
}

export const Param = createBuiltinParamDecorator(ParamType.PARAM);
export const Query = createBuiltinParamDecorator(ParamType.QUERY);
export const Body = createBuiltinParamDecorator(ParamType.BODY);
export const Headers = createBuiltinParamDecorator(ParamType.HEADERS);
export const Req = createBuiltinParamDecorator(ParamType.REQUEST);

/**
 * Factory for creating custom parameter decorators.
 *
 * @example
 * ```ts
 * const CurrentUser = createParamDecorator(
 *   (data: unknown, ctx: ExecutionContext) => {
 *     const req = ctx.getRequest();
 *     return req.headers.get('x-user-id');
 *   }
 * );
 *
 * // Usage:
 * @Get()
 * handle(@CurrentUser() userId: string) { ... }
 *
 * // With data argument:
 * const Header = createParamDecorator(
 *   (data: string, ctx: ExecutionContext) => {
 *     return ctx.getRequest().headers.get(data);
 *   }
 * );
 *
 * @Get()
 * handle(@Header('x-request-id') requestId: string) { ... }
 * ```
 */
export function createParamDecorator<TData = unknown>(
  factory: (data: TData, ctx: ExecutionContext) => unknown,
): (data?: TData, ...pipes: PipeType[]) => ParameterDecorator {
  return (data?: TData, ...pipes: PipeType[]): ParameterDecorator => {
    return (target: object, propertyKey: string | symbol | undefined, parameterIndex: number) => {
      if (propertyKey === undefined) {
        throw new Error('Parameter decorators can only be used on method parameters');
      }

      MetadataRegistry.addParameter(
        target.constructor,
        propertyKey,
        {
          index: parameterIndex,
          type: CUSTOM_PARAM_TYPE,
          name: undefined,
          factory: (_unused: unknown, ctx: unknown) => {
            const honoCtx = ctx as import('hono').Context;
            const execCtx: ExecutionContext = {
              getClass: () => target.constructor as import('../container/types').Type,
              getHandler: () => propertyKey,
              getContext: <T>() => honoCtx as T,
              getRequest: () => honoCtx.req.raw,
            };
            return factory(data as TData, execCtx);
          },
          ...(pipes.length > 0 ? { pipes } : {}),
        },
      );
    };
  };
}

// Response decorators

/**
 * Override the HTTP status code for a handler's response.
 *
 * @example
 * ```ts
 * @Post()
 * @HttpCode(201)
 * create(@Body() data: CreateDto) { return data; }
 * ```
 */
export function HttpCode(statusCode: number): MethodDecorator {
  return (target: object, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(METADATA_KEYS.HTTP_CODE, statusCode, target.constructor, propertyKey);
  };
}

/**
 * Set a response header declaratively.
 * Can be applied multiple times to set multiple headers.
 *
 * @example
 * ```ts
 * @Get()
 * @Header('Cache-Control', 'no-cache')
 * @Header('X-Custom', 'value')
 * handle() { return { ok: true }; }
 * ```
 */
export function Header(name: string, value: string): MethodDecorator {
  return (target: object, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
    const existing: Array<[string, string]> =
      Reflect.getMetadata(METADATA_KEYS.RESPONSE_HEADERS, target.constructor, propertyKey) ?? [];
    existing.push([name, value]);
    Reflect.defineMetadata(METADATA_KEYS.RESPONSE_HEADERS, existing, target.constructor, propertyKey);
  };
}

/**
 * Redirect to another URL. The handler's return value can override the URL.
 *
 * @example
 * ```ts
 * @Get('/old')
 * @Redirect('/new', 301)
 * handleOld() {}
 *
 * // Dynamic redirect — return { url, statusCode? } to override
 * @Get('/go')
 * @Redirect('/default')
 * handleGo(@Query('to') to?: string) {
 *   if (to) return { url: to };
 * }
 * ```
 */
export function Redirect(url: string, statusCode = 302): MethodDecorator {
  return (target: object, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(METADATA_KEYS.REDIRECT, { url, statusCode }, target.constructor, propertyKey);
  };
}

// Metadata readers (used by RouteManager)

export function getHttpCode(target: Constructor, method: string | symbol): number | undefined {
  return Reflect.getMetadata(METADATA_KEYS.HTTP_CODE, target, method);
}

export function getResponseHeaders(target: Constructor, method: string | symbol): Array<[string, string]> {
  return Reflect.getMetadata(METADATA_KEYS.RESPONSE_HEADERS, target, method) ?? [];
}

export function getRedirect(target: Constructor, method: string | symbol): { url: string; statusCode: number } | undefined {
  return Reflect.getMetadata(METADATA_KEYS.REDIRECT, target, method);
}

// Helpers

export function isController(target: Constructor): boolean {
  return MetadataRegistry.getControllerPath(target) !== '' ||
    MetadataRegistry.getRoutes(target).length > 0;
}
