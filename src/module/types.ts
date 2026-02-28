import type { InjectionToken, ProviderOptions, Type } from '../container/types';

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
