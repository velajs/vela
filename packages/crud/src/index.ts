/**
 * @velajs/crud — native CRUD for the Vela framework.
 *
 * `@Crud()` stamps REAL controller routes (table order, static sub-paths
 * before `/:id`) with named routes, DTO-validated bodies, and OpenAPI
 * metadata — everything flows through Vela's ordinary pipeline. The engine
 * beneath is adapter-based (`@velajs/crud-memory`, `@velajs/crud-drizzle`)
 * with shared cross-adapter conformance tests.
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
export { CRUD_DATABASES, CRUD_DEFAULT_ADAPTER, crudResourceToken } from './crud.tokens';
export {
  defineCrudFeature,
  synthesizeController,
  type CrudFeatureResource,
} from './synthesize-controller';

// Consumer config surface
export { MissingTenantResolverError, resourceNames, type CrudConfig } from './crud.types';
export {
  ALL_CRUD_ENDPOINTS,
  CORE_CRUD_ENDPOINTS,
  CRUD_ROUTES,
  VERSION_ENDPOINTS,
  resolveEnabledEndpoints,
  type CrudEndpointName,
  type EndpointSelection,
} from './verb-table';
export { deriveRouteName, deriveVerbNaming } from './naming';

// Model authoring (also on ./model)
export { defineModel } from './model/define-model';
export { defineModels, defineModelsExtending } from './model/model-registry';
export type {
  Model,
  ModelConfig,
  NestedWriteConfig,
  RelationConfig,
  RelationResponseConfig,
} from './model/model.types';

// Engine surface commonly needed by consumers (full set on subpaths)
export {
  defineResource,
  type CoreVerb,
  type CrudResource,
  type ResourceConfig,
} from './kernel/resource';
export type { EngineRequest, EngineResult } from './kernel/engine-request';
export { generateETag, matchesIfMatch, matchesIfNoneMatch } from './kernel/etag';
export type {
  CrudHooks,
  HookContext,
  HookMode,
  HookModeConfig,
  SchemaHooks,
  SchemaRow,
  SchemaWrite,
  SchemaShaped,
} from './kernel/hook-types';
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
export type {
  CrudAdapter,
  AdapterCapability,
  AdapterScope,
  TransactionContext,
} from './adapter/contract';
export type { ModelPolicies, PolicyContext } from './policies/types';

// Live-query bridge
export { crudLiveTag, buildLiveStamper } from './live-bridge';
export type { CrudLiveConfig } from './crud.types';

// Multi-tenant resolution (full surface on ./multi-tenant)
export {
  multiTenant,
  type MultiTenantMiddlewareConfig,
  type TenantEnv,
  type TenantIdSource,
} from './multi-tenant/index';
export { defineCrudContracts } from './schema/contracts';
export type {
  CrudContracts,
  CrudFieldMetadata,
  ContractInput,
  ContractOutput,
} from './schema/contracts';
export { defineStandardModel } from './model/standard-model';
export type { StandardModelConfig, StandardModel } from './model/standard-model';

export { crudTransaction, type CrudTransactionScope } from './kernel/transaction';
export {
  defineCrudDatabase,
  createCrudDatabaseRegistry,
  CrudDatabaseRegistry,
  databaseResource,
  type CrudDatabase,
  type CrudDatabaseResource,
} from './databases';
export { resolveCrudDatabase } from './resolve-database';
export type { RuntimeCrudConfig } from './crud.types';
