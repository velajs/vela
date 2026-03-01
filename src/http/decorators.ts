import { HttpMethod, METADATA_KEYS, ParamType, Scope } from '../constants';
import { defineMetadata, getMetadata } from '../metadata';
import { MetadataRegistry } from '../registry/metadata.registry';
import type { Constructor, PipeType, Type } from '../registry/types';
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
      prefix = prefixOrOptions.path ?? prefixOrOptions.prefix ?? '';
      version = prefixOrOptions.version;
    } else {
      prefix = '';
    }

    MetadataRegistry.setControllerPath(target, normalizePath(prefix));

    if (version !== undefined) {
      MetadataRegistry.setControllerOptions(target, { version });
    }

    MetadataRegistry.markInjectable(target as Constructor);
    MetadataRegistry.setScope(target as Constructor, Scope.SINGLETON);
    // Keep WeakMap write for external package compat
    defineMetadata(METADATA_KEYS.INJECTABLE, true, target);
    defineMetadata(METADATA_KEYS.SCOPE, Scope.SINGLETON, target);
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
export function Version(version: number | number[]): MethodDecorator {
  return (target: object, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
    MetadataRegistry.setRouteVersion(target.constructor as Constructor, propertyKey, version);

    // Keep WeakMap write for compat
    const versionKey = `vela:route-version:${String(propertyKey)}`;
    defineMetadata(versionKey, version, target.constructor);

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
  return MetadataRegistry.getRouteVersion(target, propertyKey) ??
    (getMetadata(`vela:route-version:${String(propertyKey)}`, target) as number | number[] | undefined);
}

function createMethodDecorator(method: HttpMethod) {
  return (path = ''): MethodDecorator => {
    return (target: object, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
      const normalizedPath = normalizePath(path);

      // Check for @Version metadata on this method
      const version: number | number[] | undefined =
        MetadataRegistry.getRouteVersion(target.constructor as Constructor, propertyKey) ??
        (getMetadata(`vela:route-version:${String(propertyKey)}`, target.constructor) as number | number[] | undefined);

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
export const All = createMethodDecorator(HttpMethod.ALL);
export const Sse = createMethodDecorator(HttpMethod.GET);

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
 * Injects the Hono `Context` as the response handle.
 * In Hono, request and response state are unified in the `Context` object,
 * so `@Res()` and `@Req()` both return it.
 *
 * Use `c.header()`, `c.setCookie()`, `c.redirect()`, etc. for response control.
 *
 * @example
 * ```ts
 * @Get('/set-cookie')
 * handle(@Res() c: Context) {
 *   c.setCookie('session', 'abc123', { httpOnly: true });
 *   return { ok: true };
 * }
 * ```
 */
export const Res = createBuiltinParamDecorator(ParamType.RESPONSE);
export const Ip = createBuiltinParamDecorator(ParamType.IP);
export const Cookie = createBuiltinParamDecorator(ParamType.COOKIE);

/**
 * Injects all cookies as a `Record<string, string>`, or a single cookie value by name.
 *
 * - `@Cookie()` — all cookies as an object
 * - `@Cookie('token')` — the value of the `token` cookie
 *
 * @example
 * ```ts
 * @Get('/me')
 * handle(@Cookie('session') session: string) { ... }
 * ```
 */
export const Cookies = Cookie;

/**
 * Injects the raw request body as a `Uint8Array`.
 * Useful for webhook HMAC verification (Stripe, GitHub, etc.) where you
 * need the raw bytes before any JSON parsing.
 *
 * @example
 * ```ts
 * @Post('/webhook')
 * async handle(@RawBody() body: Uint8Array) {
 *   const sig = new TextDecoder().decode(body);
 *   // verify HMAC...
 * }
 * ```
 */
export function RawBody(): ParameterDecorator {
  return (target: object, propertyKey: string | symbol | undefined, parameterIndex: number) => {
    if (propertyKey === undefined) {
      throw new Error('Parameter decorators can only be used on method parameters');
    }
    MetadataRegistry.addParameter(target.constructor, propertyKey, {
      index: parameterIndex,
      type: ParamType.RAW_BODY,
    });
  };
}

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
              getType: <T extends string = 'http'>() => 'http' as T,
              getClass: () => target.constructor as Type,
              getHandler: () => propertyKey,
              getContext: <T>() => honoCtx as T,
              getRequest: () => honoCtx.req.raw,
              switchToHttp: () => ({
                getRequest: <T = Request>() => honoCtx.req.raw as T,
                getResponse: <T>() => honoCtx as T,
              }),
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
    MetadataRegistry.setHandlerHttpMeta(target.constructor as Constructor, propertyKey, { httpCode: statusCode });
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
    MetadataRegistry.setHandlerHttpMeta(target.constructor as Constructor, propertyKey, {
      responseHeaders: [[name, value]],
    });
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
    MetadataRegistry.setHandlerHttpMeta(target.constructor as Constructor, propertyKey, {
      redirect: { url, statusCode },
    });
  };
}

// Metadata readers (used by RouteManager)

export function getHttpCode(target: Constructor, method: string | symbol): number | undefined {
  const meta = MetadataRegistry.getHandlerHttpMeta(target, method);
  if (meta?.httpCode !== undefined) return meta.httpCode;
  return getMetadata(METADATA_KEYS.HTTP_CODE, target, method) as number | undefined;
}

export function getResponseHeaders(target: Constructor, method: string | symbol): Array<[string, string]> {
  const meta = MetadataRegistry.getHandlerHttpMeta(target, method);
  if (meta?.responseHeaders) return meta.responseHeaders;
  return (getMetadata(METADATA_KEYS.RESPONSE_HEADERS, target, method) as Array<[string, string]>) ?? [];
}

export function getRedirect(target: Constructor, method: string | symbol): { url: string; statusCode: number } | undefined {
  const meta = MetadataRegistry.getHandlerHttpMeta(target, method);
  if (meta?.redirect) return meta.redirect;
  return getMetadata(METADATA_KEYS.REDIRECT, target, method) as { url: string; statusCode: number } | undefined;
}

/**
 * Composes multiple decorators into one. Applies them in order (top to bottom),
 * matching how stacked decorators behave when written separately.
 *
 * @example
 * ```ts
 * const Auth = (...roles: string[]) => applyDecorators(
 *   UseGuards(JwtGuard, RolesGuard),
 *   SetMetadata('roles', roles),
 * );
 *
 * @Auth('admin')
 * @Get('/admin')
 * handle() { ... }
 * ```
 */
export function applyDecorators(
  ...decorators: Array<ClassDecorator | MethodDecorator | PropertyDecorator | ParameterDecorator>
): ClassDecorator & MethodDecorator & PropertyDecorator {
  const composed = (
    target: object,
    propertyKey?: string | symbol,
    descriptor?: PropertyDescriptor | number,
  ) => {
    for (const decorator of decorators) {
      if (propertyKey === undefined && typeof descriptor !== 'number') {
        (decorator as ClassDecorator)(target as Function);
      } else if (typeof descriptor === 'number') {
        (decorator as ParameterDecorator)(target, propertyKey!, descriptor);
      } else {
        (decorator as MethodDecorator)(target, propertyKey!, descriptor!);
      }
    }
  };
  return composed as unknown as ClassDecorator & MethodDecorator & PropertyDecorator;
}

// Helpers

export function isController(target: Constructor): boolean {
  return MetadataRegistry.getControllerPath(target) !== '' ||
    MetadataRegistry.getRoutes(target).length > 0;
}
