// @velajs/vela/internal — framework plumbing for first-party packages such as
// @velajs/testing and for custom runtimes: the bootstrap primitives, the
// managers behind them and container internals. Not covered by semver
// guarantees to the same degree as the root and `/module-kit`.
import './metadata';

// Container internals (the Container itself is on `/module-kit`)
export { ROOT_MODULE_ID } from './container/types';
export type {
  ModuleScope,
  ContainerOptions,
  Diagnostics,
  ProviderSnapshot,
} from './container/types';
export { countRegisteredClasses } from './registry/metadata.registry';

// Bootstrap primitive — used by VelaFactory.create, @velajs/testing, and any
// non-HTTP consumer (CLI tools, custom runtimes).
export { bootstrap } from './factory/bootstrap';
export type { BootstrapOptions, BootstrapResult } from './factory/bootstrap';
export { finalizeApplication } from './factory/finalize';
export { applyRuntimeAdapters } from './factory/adapter';

// Managers
export { bindAppProviders } from './pipeline/app-providers';
export { RouteManager } from './http/route.manager';
export type { RouteManagerOptions } from './http/route.manager';
export { ModuleLoader } from './module/module-loader';
export { ComponentManager } from './pipeline/component.manager';
export { getModuleMetadata, isModule } from './module/decorators';
export { ConfigStore } from './config/config.store';
export { CONFIG_OPTIONS } from './config/config.tokens';

// Invocation plumbing
export { INVOCATION_TRANSPORT } from './dispatch/tokens';
export { createRequestContext } from './http/request-context';
export { setRequestContainer } from './http/request-container';
