import type { InjectionToken, ProviderOptions, Type } from '../container/types.js';

export interface DynamicModule {
  module: Type;
  providers?: Array<Type | ProviderOptions>;
  controllers?: Type[];
  exports?: Array<Type | InjectionToken>;
}

export interface ModuleOptions {
  providers?: Array<Type | ProviderOptions>;
  controllers?: Type[];
  imports?: Array<Type | DynamicModule>;
  exports?: Array<Type | InjectionToken>;
}

export interface ModuleMetadata {
  providers: Array<Type | ProviderOptions>;
  controllers: Type[];
  imports: Array<Type | DynamicModule>;
  exports: Array<Type | InjectionToken>;
}
