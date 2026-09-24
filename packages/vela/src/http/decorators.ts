import { ParamType, type HttpMethod } from '../constants';
import type { RedirectStatusCode, StatusCode } from 'hono/utils/http-status';
import { declareScope } from '../container/decorators';
import { MetadataRegistry } from '../registry/metadata.registry';
import { normalizePath } from '../registry/paths';
import type { Constructor, PipeType, Type } from '../registry/types';
import type { ControllerOptions } from './types';
import type { ExecutionContext } from '../pipeline/types';
import { isValidationSchema, type ValidationSchema } from '../validation/parse-schema';
import { isStandardSchema } from '../validation/standard-schema';
import { ValidationPipe } from '../validation/validation.pipe';
import { buildExecutionContext } from './execution-context';

/**
 * Marks a class as a controller.
 * Accepts a path string or an options object with `path`, `version` and `scope`.
 * Without a scope here or on `@Injectable`, the controller is a singleton.
 *
 * @example
 * ```ts
 * @Controller('/users')
 * @Controller({ path: '/users', version: 1 })
 * @Controller({ path: '/users', version: [1, 2] })
 * @Controller({ path: '/users', scope: Scope.REQUEST })
 * ```
 */
export function Controller(pathOrOptions?: string | ControllerOptions): ClassDecorator {
  return (target) => {
    const ctor = target as unknown as Constructor;
    const options = typeof pathOrOptions === 'object' ? pathOrOptions : undefined;
    const path = typeof pathOrOptions === 'string' ? pathOrOptions : (options?.path ?? '');

    MetadataRegistry.setControllerPath(ctor, normalizePath(path));

    if (options?.version !== undefined) {
      MetadataRegistry.setControllerOptions(ctor, { version: options.version });
    }

    MetadataRegistry.markInjectable(ctor);
    if (options?.scope !== undefined) declareScope(ctor, options.scope);
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

// Pure calls with literal arguments, so a bundle drops every decorator it never
// uses. A member access such as `HttpMethod.GET` could run a getter, which keeps
// an annotated call alive; pure-annotations.test.ts enforces the literals.
export const Get = /* @__PURE__ */ createMethodDecorator('GET');
export const Post = /* @__PURE__ */ createMethodDecorator('POST');
export const Put = /* @__PURE__ */ createMethodDecorator('PUT');
export const Patch = /* @__PURE__ */ createMethodDecorator('PATCH');
export const Delete = /* @__PURE__ */ createMethodDecorator('DELETE');
export const Options = /* @__PURE__ */ createMethodDecorator('OPTIONS');
export const Head = /* @__PURE__ */ createMethodDecorator('HEAD');
export const All = /* @__PURE__ */ createMethodDecorator('ALL');
export const Sse = /* @__PURE__ */ createMethodDecorator('GET');

// Parameter decorators

const CUSTOM_PARAM_TYPE = 'custom';

/**
 * A parameter decorator for a request value. A schema argument (a Standard Schema such
 * as Zod, a `parse()` parser, or a `defineDto` descriptor) validates the value with
 * `ValidationPipe`: invalid input is a 400, OpenAPI documents the schema, and pipes
 * written after it receive the schema's parsed output.
 *
 * @example
 * ```ts
 * create(@Body(CreateUser) body: SchemaOutput<typeof CreateUser>) {}
 * list(@Query('page', z.coerce.number().int().min(1)) page: number) {}
 * show(@Param('id', z.uuid()) id: string) {}
 * ```
 */
export interface SchemaParamDecorator {
  (schema: ValidationSchema, ...pipes: PipeType[]): ParameterDecorator;
  (name: string, schema: ValidationSchema, ...pipes: PipeType[]): ParameterDecorator;
  (nameOrPipe?: string | PipeType, ...pipes: PipeType[]): ParameterDecorator;
}

// For @Req, @Ctx, @Res and @Ip, which inject request objects rather than request values.
type PipedParamDecorator = (
  nameOrPipe?: string | PipeType,
  ...pipes: PipeType[]
) => ParameterDecorator;

// A Zod schema also has a transform() method, so Standard Schemas are recognized
// before anything else; otherwise it would run as a pipe and replace the value with
// a new schema. Pipes are classes or objects with transform(); schema parsers and
// defineDto descriptors are neither.
function isParamSchema(value: PipeType | ValidationSchema): value is ValidationSchema {
  if (isStandardSchema(value)) return true;
  if (typeof value !== 'object' || ('transform' in value && typeof value.transform === 'function'))
    return false;
  return isValidationSchema(value);
}

function createBuiltinParamDecorator(type: ParamType): SchemaParamDecorator {
  return (
    nameOrPipe?: string | PipeType | ValidationSchema,
    ...pipes: Array<PipeType | ValidationSchema>
  ): ParameterDecorator => {
    const name = typeof nameOrPipe === 'string' ? nameOrPipe : undefined;
    const entries =
      typeof nameOrPipe === 'string' || nameOrPipe === undefined ? pipes : [nameOrPipe, ...pipes];
    const allPipes = entries.map((entry) =>
      isParamSchema(entry) ? new ValidationPipe(entry) : entry,
    );

    return (target: object, propertyKey: string | symbol | undefined, parameterIndex: number) => {
      if (propertyKey === undefined) {
        throw new Error('Parameter decorators can only be used on method parameters');
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

// Pure, with literal arguments, for the same reason as the method decorators.
export const Param = /* @__PURE__ */ createBuiltinParamDecorator('param');
export const Query = /* @__PURE__ */ createBuiltinParamDecorator('query');
export const Body = /* @__PURE__ */ createBuiltinParamDecorator('body');
export const Headers = /* @__PURE__ */ createBuiltinParamDecorator('headers');
/**
 * Injects the platform `Request`, as Nest's `@Req()` injects the request
 * object. It is the exact request guards and middleware saw.
 *
 * @example
 * ```ts
 * @Post('/webhook')
 * handle(@Req() request: Request) { return verify(request); }
 * ```
 */
export const Req: PipedParamDecorator = /* @__PURE__ */ createBuiltinParamDecorator('request');
/**
 * Injects the Hono `Context` (`VelaContext`): request helpers, response
 * headers and cookies, and the typed environment.
 *
 * @example
 * ```ts
 * @Get('/session')
 * handle(@Ctx() c: VelaContext) { return c.req.header('accept'); }
 * ```
 */
export const Ctx: PipedParamDecorator = /* @__PURE__ */ createBuiltinParamDecorator('context');
/**
 * Injects the Hono `Context` as the response handle. In Hono, request and
 * response state are unified in the `Context` object, so `@Res()` returns the
 * same object as `@Ctx()`.
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
export const Res: PipedParamDecorator = /* @__PURE__ */ createBuiltinParamDecorator('response');
export const Ip: PipedParamDecorator = /* @__PURE__ */ createBuiltinParamDecorator('ip');
export const Cookie = /* @__PURE__ */ createBuiltinParamDecorator('cookie');

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

/**
 * A decorator {@link applyDecorators} accepts: any class, method, property or
 * parameter decorator, including typed method decorators whose descriptor is
 * generic over the handler they accept (`@Cron`, `@Interval`,
 * `@Process(definition)`).
 */
export type ComposableDecorator =
  | ClassDecorator
  | MethodDecorator
  | PropertyDecorator
  | ParameterDecorator
  | ((
      target: object,
      propertyKey: string | symbol,
      descriptor: TypedPropertyDescriptor<never>,
    ) => unknown);

export function applyDecorators(...decorators: ComposableDecorator[]): ComposedDecorator {
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
