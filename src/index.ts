export { Crud } from './crud.decorator';
export { CrudModule } from './crud.module';
export { CrudService } from './crud.service';
export { Override, getOverrides } from './override.decorator';
export type { OverrideEntry } from './override.decorator';
export { buildCrudRoutes } from './builder';
export { defineCrudResource } from './define-crud-resource';
export type { DefineCrudResourceConfig } from './define-crud-resource';
export {
  ALL_CRUD_ENDPOINTS,
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
// Re-export hono-crud's envelope-shape types so consumers configuring
// `CrudConfig.responseEnvelope` don't need a second import from hono-crud.
export type {
  ResponseEnvelope,
  ResponseEnvelopeInfo,
  StructuredError,
} from 'hono-crud';
