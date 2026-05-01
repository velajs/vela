import type { Context } from 'hono';
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
  InjectionToken,
  ProviderOptions,
  Token,
  Type,
} from '../container/types';

export type { Constructor, ForwardRef, InjectionToken, ProviderOptions, Token, Type };

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
  factory?: (data: unknown, ctx: Context) => unknown;
}

export interface HttpHandlerMeta {
  httpCode?: number;
  responseHeaders?: Array<[string, string]>;
  redirect?: { url: string; statusCode: number };
}

// Module shapes — canonical home (was duplicated in module/types.ts).

export type ModuleImport = Type | DynamicModule | ForwardRef;

export interface AsyncModuleOptions<T = unknown> {
  imports?: ModuleImport[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useFactory: (...args: any[]) => T | Promise<T>;
  inject?: Token[];
}

export interface DynamicModule {
  module: Type;
  imports?: ModuleImport[];
  providers?: Array<Type | ProviderOptions>;
  controllers?: Type[];
  exports?: Array<Type | InjectionToken>;
  global?: boolean;
}

export interface ModuleOptions {
  providers?: Array<Type | ProviderOptions>;
  controllers?: Type[];
  imports?: ModuleImport[];
  exports?: Array<Type | InjectionToken>;
  isGlobal?: boolean;
}

export interface ModuleMetadata {
  providers: Array<Type | ProviderOptions>;
  controllers: Type[];
  imports: ModuleImport[];
  exports: Array<Type | InjectionToken>;
  isGlobal: boolean;
}
