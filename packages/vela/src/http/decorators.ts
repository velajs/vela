import { CUSTOM_PARAM_TYPE, HttpMethod, ParamType, Scope } from '../constants';
import type { RedirectStatusCode, StatusCode } from 'hono/utils/http-status';
import { MetadataRegistry } from '../registry/metadata.registry';
import { normalizePath } from '../registry/paths';
import type { Constructor, PipeType, Type } from '../registry/types';
import type { ControllerOptions } from './types';
import type { ExecutionContext } from '../pipeline/types';
import { buildExecutionContext } from './execution-context';

/**
 * Marks a class as a controller.
 * Accepts a path string or an options object with `path` and `version`.
 *
 * @example
 * ```ts
 * @Controller('/users')
 * @Controller({ path: '/users', version: 1 })
 * @Controller({ path: '/users', version: [1, 2] })
 * ```
 */
export function Controller(pathOrOptions?: string | ControllerOptions): ClassDecorator {
  return (target) => {
    const ctor = target as unknown as Constructor;
    const path = typeof pathOrOptions === 'string' ? pathOrOptions : (pathOrOptions?.path ?? '');
    const version = typeof pathOrOptions === 'object' ? pathOrOptions?.version : undefined;

    MetadataRegistry.setControllerPath(ctor, normalizePath(path));

    if (version !== undefined) {
      MetadataRegistry.setControllerOptions(ctor, { version });
    }

    MetadataRegistry.markInjectable(ctor);
    MetadataRegistry.setScope(ctor, Scope.SINGLETON);
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
    const ctor = target.constructor as Constructor;
    MetadataRegistry.setRouteVersion(ctor, propertyKey, version);

    // If route was already registered (decorator ran after @Get), patch it.
    const route = MetadataRegistry.getRoutes(ctor).find((r) => r.handlerName === propertyKey);
    if (route) {
      route.version = version;
    }
  };
}

export function getRouteVersion(
  target: Constructor,
  propertyKey: string | symbol,
): number | number[] | undefined {
  return MetadataRegistry.getRouteVersion(target, propertyKey);
}

/** Per-route options for the HTTP method decorators (`@Get`, `@Post`, …). */
export interface RouteOptions {
  /**
   * A stable, human-readable name for this route. Enables URL generation
   * (`UrlGeneratorService.urlFor(name, …)`), surfaces on `app.describeRoutes()`,
   * and — when set — becomes the OpenAPI `operationId`.
   */
  name?: string;
}

function createMethodDecorator(method: HttpMethod) {
  return (path = '', options?: RouteOptions): MethodDecorator => {
    return (target: object, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
      const ctor = target.constructor as Constructor;
      const normalizedPath = normalizePath(path);
      const version = MetadataRegistry.getRouteVersion(ctor, propertyKey);

      MetadataRegistry.addRoute(ctor, {
        method: method as string,
        path: normalizedPath,
        handlerName: propertyKey,
        ...(version !== undefined ? { version } : {}),
        ...(options?.name !== undefined ? { name: options.name } : {}),
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

      MetadataRegistry.addParameter(target.constructor as Constructor, propertyKey, {
        index: parameterIndex,
        type,
        name,
        ...(allPipes.length > 0 ? { pipes: allPipes } : {}),
      });
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
    MetadataRegistry.addParameter(target.constructor as Constructor, propertyKey, {
      index: parameterIndex,
      type: ParamType.RAW_BODY,
    });
  };
}

/**
 * Factory for creating custom parameter decorators.
 * Data may be omitted only when the factory accepts `undefined`.
 * Factories run after guards and before parameter pipes.
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
export type CustomParamDecorator<TData> = (
  ...args: undefined extends TData
    ? [data?: TData, ...pipes: PipeType[]]
    : [data: TData, ...pipes: PipeType[]]
) => ParameterDecorator;

export function createParamDecorator<TData = unknown>(
  factory: (data: TData, ctx: ExecutionContext) => unknown,
): CustomParamDecorator<TData>;
export function createParamDecorator<TData>(
  factory: (data: TData, ctx: ExecutionContext) => unknown,
): (data: TData, ...pipes: PipeType[]) => ParameterDecorator {
  return (data: TData, ...pipes: PipeType[]): ParameterDecorator => {
    return (target: object, propertyKey: string | symbol | undefined, parameterIndex: number) => {
      if (propertyKey === undefined) {
        throw new Error('Parameter decorators can only be used on method parameters');
      }

      MetadataRegistry.addParameter(target.constructor as Constructor, propertyKey, {
        index: parameterIndex,
        type: CUSTOM_PARAM_TYPE,
        name: undefined,
        factory: (_unused, ctx) => {
          const execCtx = buildExecutionContext(ctx, target.constructor as Type, propertyKey);
          return factory(data, execCtx);
        },
        ...(pipes.length > 0 ? { pipes } : {}),
      });
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
export function HttpCode(statusCode: StatusCode): MethodDecorator {
  return (target: object, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
    MetadataRegistry.setHandlerHttpMeta(target.constructor as Constructor, propertyKey, {
      httpCode: statusCode,
    });
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
export function Redirect(url: string, statusCode: RedirectStatusCode = 302): MethodDecorator {
  return (target: object, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
    MetadataRegistry.setHandlerHttpMeta(target.constructor as Constructor, propertyKey, {
      redirect: { url, statusCode },
    });
  };
}

// Metadata readers (used by RouteManager)

export function getHttpCode(target: Constructor, method: string | symbol): StatusCode | undefined {
  return MetadataRegistry.getHandlerHttpMeta(target, method)?.httpCode;
}

export function getResponseHeaders(
  target: Constructor,
  method: string | symbol,
): Array<[string, string]> {
  return MetadataRegistry.getHandlerHttpMeta(target, method)?.responseHeaders ?? [];
}

export function getRedirect(
  target: Constructor,
  method: string | symbol,
): { url: string; statusCode: RedirectStatusCode } | undefined {
  return MetadataRegistry.getHandlerHttpMeta(target, method)?.redirect;
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
// Polymorphic signature: matches the shape of every decorator slot
// (class, method, property, parameter) so a single composition can be applied
// at any of them. TypeScript can't express "this is one of N decorator types"
// natively; the union shape below is what every decorator definition reduces to.
export type ComposedDecorator = <T>(
  target: T,
  propertyKey?: string | symbol,
  descriptor?: PropertyDescriptor | number,
) => void;

export function applyDecorators(
  ...decorators: Array<ClassDecorator | MethodDecorator | PropertyDecorator | ParameterDecorator>
): ComposedDecorator {
  return ((
    target: object,
    propertyKey?: string | symbol,
    descriptor?: PropertyDescriptor | number,
  ) => {
    for (const decorator of decorators) {
      if (propertyKey === undefined && typeof descriptor !== 'number') {
        (decorator as ClassDecorator)(target as never);
      } else if (typeof descriptor === 'number') {
        (decorator as ParameterDecorator)(target, propertyKey!, descriptor);
      } else {
        (decorator as MethodDecorator)(target, propertyKey!, descriptor!);
      }
    }
  }) as ComposedDecorator;
}

// Helpers

export function isController(target: Constructor): boolean {
  return (
    MetadataRegistry.getControllerPath(target) !== '' ||
    MetadataRegistry.getRoutes(target).length > 0
  );
}
