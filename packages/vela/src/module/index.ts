export {
  Global,
  Module,
  isModule,
  getModuleMetadata,
  type ModuleDecoratorOptions,
} from './decorators';
export { stableHash } from './stable-hash';
export { referenceKey } from './reference-key';
export { ROOT_MODULE } from './root-module';
export { UndefinedModuleError, type ModuleEntryList } from './module-identity';
export { ConfigurableModuleBuilder } from './configurable-module.builder';
export {
  defineModule,
  type DefineModuleSpec,
  type GlobalComponentSlot,
  type ModuleContributions,
  type ModuleSetupContext,
} from './define-module';
export { lazyProvider, sideEffectModule, type LazyProviderSpec } from './lazy-provider';
export type {
  ModuleRegistrationOptions,
  ModuleFactoryOptions,
  ConfigurableModuleAsyncOptions,
  ConfigurableModuleBuilderOptions,
  ConfigurableModuleClassType,
  ConfigurableModuleExtras,
  ConfigurableModuleExtrasTransform,
  ConfigurableModuleHost,
  ConfigurableModuleOptionsFactory,
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
  ModuleRecord,
  DynamicModule,
  AsyncModuleOptions,
  ModuleImport,
} from './types';
