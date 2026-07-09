/**
 * @velajs/crud — native CRUD for the Vela framework.
 *
 * `@Crud()` stamps REAL controller routes (table order, static sub-paths
 * before `/:id`) with named routes, DTO-validated bodies, and OpenAPI
 * metadata — everything flows through Vela's ordinary pipeline. The engine
 * beneath is adapter-based (`@velajs/crud-memory`, `@velajs/crud-drizzle`)
 * with behavior parity to hono-crud 0.13 (see PARITY.md).
 *
 * Feature families live on subpaths: `@velajs/crud/adapter`, `/model`,
 * `/query`, `/envelope`, `/policies`, `/kernel`.
 */

// Decorators
export { Crud, getCrudConfig } from './crud.decorator';
export { Override } from './override.decorator';
export { CrudCtx, type CrudRequestContext } from './crud-context.decorator';

// Module + tokens
export { CrudModule, CRUD_MODULE_OPTIONS, type CrudModuleOptions } from './crud.module';
export { CRUD_DEFAULT_ADAPTER, crudResourceToken } from './crud.tokens';
export { synthesizeController, type CrudFeatureResource } from './synthesize-controller';

// Consumer config surface
export { MissingTenantResolverError, resourceNames, type CrudConfig } from './crud.types';
export {
  ALL_CRUD_ENDPOINTS,
  CRUD_ROUTES,
  IMPLEMENTED_ENDPOINTS,
  VERSION_ENDPOINTS,
  resolveEnabledEndpoints,
  type CrudEndpointName,
  type EndpointSelection,
} from './verb-table';
export { deriveRouteName, deriveVerbNaming } from './naming';

// Model authoring (also on ./model)
export { defineModel } from './model/define-model';
export { defineModels, defineModelsExtending } from './model/model-registry';
export type { Model, ModelConfig, RelationConfig } from './model/model.types';

// Engine surface commonly needed by consumers (full set on subpaths)
export {
  defineResource,
  type CoreVerb,
  type CrudResource,
  type ResourceConfig,
} from './kernel/resource';
export type { EngineRequest, EngineResult } from './kernel/engine-request';
export type { CrudHooks, HookContext, HookMode, HookModeConfig } from './kernel/hook-types';
export {
  CrudException,
  InputValidationException,
  NotFoundException,
  ConflictException,
  UnauthorizedException,
  ForbiddenException,
  AggregationException,
  ConfigurationException,
  type CrudErrorCode,
  type StructuredError,
  type ValidationIssue,
} from './envelope/errors';
export {
  defaultEnvelope,
  type ErrorMapper,
  type ResponseEnvelope,
  type ResponseEnvelopeInfo,
} from './envelope/envelope';
export type { CrudAdapter, AdapterCapability, AdapterScope } from './adapter/contract';
export type { ModelPolicies, PolicyContext } from './policies/types';
