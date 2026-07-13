export { Global, Module, isModule, getModuleMetadata, defineDynamicModule } from './decorators';
export { stableHash } from './stable-hash';
export {
  ConfigurableModuleBuilder,
  defineConfigurableModule,
  moduleKey,
} from './configurable-module.builder';
export {
  defineModule,
  buildAsyncOptionsProviders,
  type DefineModuleSpec,
  type GlobalComponentSlot,
  type ModuleContributions,
  type ModuleSetupContext,
} from './define-module';
export {
  lazyProvider,
  moduleToken,
  provideGlobal,
  sideEffectModule,
  type LazyProviderSpec,
} from './lazy-provider';
export type {
  ConfigurableModuleAsyncOptions,
  ConfigurableModuleBuilderOptions,
  ConfigurableModuleClassType,
  ConfigurableModuleExtras,
  ConfigurableModuleExtrasTransform,
  ConfigurableModuleHost,
  ConfigurableModuleOptionsFactory,
  DefineConfigurableModuleSpec,
} from './configurable-module.types';
export { ModuleLoader } from './module-loader';
export { MiddlewareBuilder } from './middleware';
export type {
  MiddlewareConsumer,
  MiddlewareConfigProxy,
  MiddlewareRouteDefinition,
  NestModule,
  RouteInfo,
} from './middleware';
export type {
  ModuleOptions,
  ModuleMetadata,
  DynamicModule,
  AsyncModuleOptions,
  ModuleImport,
} from './types';
