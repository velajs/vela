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

// --- vela RouteContributor self-registration (import side-effect) ----------
//
// vela inverts its `@Crud` integration: instead of vela doing a variable
// `await import('@velajs/crud')` (which esbuild cannot bundle, breaking
// Cloudflare Workers), it exposes a register-based `RouteContributor` on the
// public surface. Merely importing `@velajs/crud` wires the contributor in —
// vela consults it after explicit routes at route-build time and during
// OpenAPI document generation, for every controller carrying `vela:crud`
// metadata. Registration is last-writer-wins on vela's side (keyed by `id`),
// so this is safe to import in any order and idempotent.
import { registerRouteContributor } from '@velajs/vela';
import type { Hono } from 'hono';
import { buildCrudRoutes } from './builder';
import { buildCrudOpenApiPaths as buildCrudOpenApiPathsImpl } from './openapi';
import type { CrudConfig } from './types';

registerRouteContributor({
  id: 'crud',
  claimsMetaKey: 'vela:crud',
  // vela passes a single resolved context; map it onto `buildCrudRoutes`'s
  // positional signature. `meta` is the stored `CrudConfig` (typed `unknown`
  // in the contributor contract), and `container` threads through so the
  // stateless `ComponentManager` resolvers can materialize controller-scoped
  // guards/middleware. `app` is cast across the hono type boundary: with vela
  // linked (`link:../vela`) its `hono` copy can differ from this package's, a
  // compile-time-only identity skew the old CrudBridge registration bridged
  // the same way (`as unknown as`).
  buildRoutes(app, { controller, controllerPrefix, meta, globalPrefix, globalGuards, container, joinPaths }) {
    return buildCrudRoutes(app as unknown as Hono, controller, controllerPrefix, meta as CrudConfig, {
      globalPrefix,
      globalGuards,
      joinPaths,
      container,
    });
  },
  buildOpenApiPaths({ controller, meta, globalPrefix, controllerPrefix }) {
    return buildCrudOpenApiPathsImpl(controller, meta as CrudConfig, {
      globalPrefix,
      controllerPrefix,
    });
  },
});
