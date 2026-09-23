export {
  Global,
  Module,
  isModule,
  getModuleMetadata,
  defineDynamicModule,
  type ModuleDecoratorOptions,
} from './decorators';
export { stableHash } from './stable-hash';
export { UndefinedModuleError, type ModuleEntryList } from './module-identity';
export {
  ConfigurableModuleBuilder,
  defineConfigurableModule,
  moduleKey,
} from './configurable-module.builder';
export {
  defineModule,
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
  ModuleRegistrationOptions,
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
