export { Crud } from './crud.decorator';
export { CrudModule } from './crud.module';
export { CrudService } from './crud.service';
export { Override, getOverrides } from './override.decorator';
export type { OverrideEntry } from './override.decorator';
export { buildCrudRoutes } from './builder';
export { defineCrudResource } from './define-crud-resource';
export type { DefineCrudResourceConfig } from './define-crud-resource';
export {
  adapterProvidesEndpoint,
  ALL_CRUD_ENDPOINTS,
  crudEndpointSlot,
  MissingTenantResolverError,
  isTenantScopedMeta,
} from './types';
export type {
  CrudConfig,
  CrudDtos,
  CrudHooks,
  CrudEndpointName,
  EndpointOverride,
  ResourceConfig,
} from './types';
export { buildCrudOpenApiPaths } from './openapi';
// Re-export hono-crud's envelope-shape types so consumers configuring
// `CrudConfig.responseEnvelope` don't need a second import from hono-crud.
export type {
  ResponseEnvelope,
  ResponseEnvelopeInfo,
  StructuredError,
} from 'hono-crud';

// --- vela bridge self-registration (import side-effect) -------------------
//
// vela inverted its `@Crud` integration: instead of vela doing a variable
// `await import('@velajs/crud')` (which esbuild cannot bundle, breaking
// Cloudflare Workers), vela exposes a register-based bridge at
// `@velajs/vela/internal`. Merely importing `@velajs/crud` now wires the
// bridge in — vela consults it at route-build time and at OpenAPI document
// generation. Registration is last-writer-wins on vela's side, so this is
// safe to import in any order and idempotent.
import { registerCrudBridge } from '@velajs/vela/internal';
import type { CrudBridge } from '@velajs/vela/internal';
import { buildCrudRoutes } from './builder';
import { buildCrudOpenApiPaths as buildCrudOpenApiPathsImpl } from './openapi';

registerCrudBridge({
  // `buildCrudRoutes`'s signature already matches `CrudBridge.buildRoutes` +
  // `CrudBridgeRouteContext`; the only divergence is `crudConfig`, typed as
  // `CrudConfig` here but `unknown` in the bridge interface. Cast at the
  // boundary so `buildCrudRoutes`'s own types stay strict.
  buildRoutes: buildCrudRoutes as unknown as CrudBridge['buildRoutes'],
  buildOpenApiPaths: buildCrudOpenApiPathsImpl as unknown as CrudBridge['buildOpenApiPaths'],
});
