import type {
  CanActivate,
  ExceptionFilter,
  NestInterceptor,
  NestMiddleware,
  PipeTransform,
} from '../pipeline/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Type<T = any> = new (...args: any[]) => T;

// Broader type that matches what decorators actually provide (Function)
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
export type Constructor = Function;

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

export type ComponentInstance = MiddlewareType | GuardType | PipeType | InterceptorType | FilterType;

export interface RouteDefinition {
  method: string;
  path: string;
  handlerName: string | symbol;
  version?: number | number[];
}

export interface ParameterMetadata {
  index: number;
  type: string;
  name?: string;
  pipes?: PipeType[];
  factory?: (data: unknown, ctx: unknown) => unknown;
}

export interface HttpHandlerMeta {
  httpCode?: number;
  responseHeaders?: Array<[string, string]>;
  redirect?: { url: string; statusCode: number };
}

export interface ModuleOptions {
  imports?: unknown[];
  providers?: Array<Type | ProviderOptions>;
  controllers?: Type[];
  exports?: Array<Type | InjectionTokenLike>;
  isGlobal?: boolean;
}

// Forward-compatible with InjectionToken
export interface InjectionTokenLike {
  toString(): string;
}

// Forward-compatible with ProviderOptions
export interface ProviderOptions<T = unknown> {
  token?: unknown;
  scope?: string;
  useValue?: T;
  useFactory?: (...args: unknown[]) => T | Promise<T>;
  inject?: unknown[];
  useExisting?: unknown;
}
