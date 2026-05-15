// Internal framework primitives — exposed for first-party consumers like
// @velajs/testing and advanced integration. Not covered by semver guarantees
// to the same degree as the public surface (./index).

export { Container } from './container/container';
export { ModuleRef } from './container/module-ref';
export { ModuleVisibilityError } from './container/types';
export type {
  ModuleScope,
  ContainerOptions,
  Diagnostics,
} from './container/types';
export { bindAppProviders } from './pipeline/app-providers';
export { RouteManager } from './http/route.manager';
export type { RouteManagerOptions } from './http/route.manager';

// CRUD bridge registry — the integration seam for `@velajs/crud` (and any
// future CRUD route generator). `@velajs/crud` calls `registerCrudBridge`
// once at import time; the framework consults `getCrudBridge` whenever it
// encounters a controller carrying `vela:crud` metadata, both at route
// build time and at OpenAPI document generation. The types are exposed so
// integrators can write their own bridges or strongly-typed mocks in tests.
export {
  registerCrudBridge,
  getCrudBridge,
} from './http/crud-bridge';
export type {
  CrudBridge,
  CrudBridgeRouteContext,
  CrudBridgeOpenApiContext,
} from './http/crud-bridge';
export { ModuleLoader } from './module/module-loader';
export { ComponentManager } from './pipeline/component.manager';
export { VelaApplication } from './application';
export { MetadataRegistry } from './registry/metadata.registry';
export {
  APP_GUARD,
  APP_PIPE,
  APP_INTERCEPTOR,
  APP_FILTER,
  APP_MIDDLEWARE,
} from './pipeline/tokens';
export { getModuleMetadata, isModule } from './module/decorators';

// Bootstrap primitive — used by VelaFactory.create, @velajs/testing, and any
// non-HTTP consumer (CLI tools, custom runtimes).
export { bootstrap } from './factory/bootstrap';
export type { BootstrapOptions, BootstrapResult } from './factory/bootstrap';

// Plugin manifest + composer
export {
  definePlugin,
  composePlugins,
  PluginRegistry,
  PluginRootModule,
  PLUGIN_REGISTRY_TOKEN,
} from './plugin/plugin';
export type { Plugin } from './plugin/plugin';
