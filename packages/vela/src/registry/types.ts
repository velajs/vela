import type { VersionValue } from '../http/version';
import type { Context } from 'hono';
import type { RedirectStatusCode, StatusCode } from 'hono/utils/http-status';
import type {
  CanActivate,
  ExceptionFilter,
  NestInterceptor,
  NestMiddleware,
  PipeTransform,
} from '../pipeline/types';
import type {
  Constructor,
  ForwardRef,
  InferToken,
  InferTokens,
  InjectionToken,
  Provider,
  ProviderDefinition,
  Token,
  Type,
  FactoryInject,
} from '../container/types';

export type {
  Constructor,
  ForwardRef,
  InferToken,
  InferTokens,
  InjectionToken,
  Provider,
  ProviderDefinition,
  Token,
  Type,
};

export type ComponentType = 'middleware' | 'guard' | 'pipe' | 'interceptor' | 'filter';

export type MiddlewareType = Type<NestMiddleware> | NestMiddleware;
export type GuardType = Type<CanActivate> | CanActivate;
export type PipeType = Type<PipeTransform> | PipeTransform;
export type InterceptorType = Type<NestInterceptor> | NestInterceptor;
export type FilterType = Type<ExceptionFilter> | ExceptionFilter;

export interface ComponentTypeMap {
  middleware: MiddlewareType;
  guard: GuardType;
  pipe: PipeType;
  interceptor: InterceptorType;
  filter: FilterType;
}

export type ComponentInstance =
  | MiddlewareType
  | GuardType
  | PipeType
  | InterceptorType
  | FilterType;

export interface RouteDefinition {
  method: string;
  path: string;
  handlerName: string | symbol;
  version?: VersionValue;
  /** Route name for URL generation / OpenAPI operationId (`@Get(path, { name })`). */
  name?: string;
}

export interface ParameterMetadata {
  index: number;
  type: string;
  name?: string;
  pipes?: PipeType[];
  factory?: (data: unknown, ctx: Context) => unknown;
  /**
   * Explicit param type for programmatic routes. Methods synthesized at
   * runtime (e.g. `@Crud()` verb handlers) have no `design:paramtypes`, so
   * ValidationPipe and the OpenAPI walk read this instead when present.
   */
  metatype?: unknown;
}

export interface HttpHandlerMeta {
  httpCode?: StatusCode;
  responseHeaders?: Array<[string, string]>;
  redirect?: { url: string; statusCode: RedirectStatusCode };
  /**
   * Maps the handler's result to its response instead of the default mapper
   * (`@Sse()`). A failure after the response has started goes to `onStreamError`.
   */
  respond?: (c: Context, result: unknown, onStreamError: (error: unknown) => void) => Response;
}

// Module shapes — canonical home (was duplicated in module/types.ts).

export type ModuleImport = Type | DynamicModule | ForwardRef;

/**
 * Async module options with **type-inferred `useFactory` parameters**.
 *
 * The `Inject` generic captures the literal `inject` tuple via `const` type
 * parameter inference at the call site (TS 5.0+ — vela already requires it).
 * `useFactory`'s parameter types are computed from that tuple via
 * `InferTokens<Inject>`, so:
 *
 * ```ts
 * SomeModule.forRootAsync({
 *   inject: [D1Service, ConfigService],   // captured as readonly [typeof D1Service, typeof ConfigService]
 *   useFactory: (d1, config) => { ... },  // d1: D1Service, config: ConfigService — inferred
 * });
 * ```
 *
 * A factory with parameters declares their runtime dependency tuple; a type
 * argument cannot supply runtime values. A factory without parameters may
 * omit `inject`.
 */
export type AsyncModuleOptions<T = unknown, Inject extends readonly Token[] = readonly Token[]> = {
  imports?: ModuleImport[];
  useFactory: (...args: InferTokens<Inject>) => T | Promise<T>;
} & FactoryInject<Inject>;

export interface DynamicModule {
  module: Type;
  /**
   * Author-supplied instance discriminator. Two DynamicModules with the same
   * `module` class and the same `key` dedup; with different keys they coexist
   * as separate module instances. Defaults to `"default"` when absent — which
   * preserves single-instance dedup for the common case.
   *
   * For `forRoot(options)`, derive `key: stableHash(options)` so identical
   * options dedup automatically. For `forRootAsync` (factories aren't
   * structurally hashable), pass an explicit string.
   */
  key?: string;
  imports?: ModuleImport[];
  /** Classes, definitions and literals; the module loader checks literals when it loads. */
  providers?: Provider[];
  controllers?: Type[];
  exports?: Token[];
  global?: boolean;
  /**
   * Defer this module instance's providers/controllers to first use: nothing
   * constructs at bootstrap; the first resolution of any of its tokens
   * materializes the whole group and replays its lifecycle hooks (memoized).
   * See docs/modules.md "Lazy modules" for the contract.
   */
  lazy?: boolean;
}

export interface ModuleOptions {
  providers?: readonly Provider[];
  controllers?: Type[];
  imports?: ModuleImport[];
  exports?: Token[];
  isGlobal?: boolean;
  /** Defer to first use (see {@link DynamicModule.lazy}). */
  lazy?: boolean;
}

export interface ModuleMetadata {
  providers: readonly Provider[];
  controllers: Type[];
  imports: ModuleImport[];
  exports: Token[];
  isGlobal: boolean;
  lazy: boolean;
}
