import type { InjectionToken, ProviderOptions, Token, Type } from '../container/types';

export interface AsyncModuleOptions<T = unknown> {
  imports?: Array<Type | DynamicModule>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useFactory: (...args: any[]) => T | Promise<T>;
  inject?: Token[];
}

export interface DynamicModule {
  module: Type;
  providers?: Array<Type | ProviderOptions>;
  controllers?: Type[];
  exports?: Array<Type | InjectionToken>;
  global?: boolean;
}

export interface ModuleOptions {
  providers?: Array<Type | ProviderOptions>;
  controllers?: Type[];
  imports?: Array<Type | DynamicModule>;
  exports?: Array<Type | InjectionToken>;
  isGlobal?: boolean;
}

export interface ModuleMetadata {
  providers: Array<Type | ProviderOptions>;
  controllers: Type[];
  imports: Array<Type | DynamicModule>;
  exports: Array<Type | InjectionToken>;
  isGlobal: boolean;
}
