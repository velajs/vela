// Internal framework primitives — exposed for first-party consumers like
// @velajs/testing and advanced integration. Not covered by semver guarantees
// to the same degree as the public surface (./index).

export { Container } from './container/container';
export { ModuleRef } from './container/module-ref';
export { bindAppProviders } from './pipeline/app-providers';
export { RouteManager } from './http/route.manager';
export type { RouteManagerOptions } from './http/route.manager';
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
