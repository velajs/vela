import type { ForwardRef, InjectionToken, ProviderOptions, Token, Type } from '../container/types';

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
