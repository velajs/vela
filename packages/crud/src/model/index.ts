/**
 * The model layer's public surface: model authoring (`defineModel` /
 * `defineModels`), the normalized model shape, and the engine-managed
 * write-time / soft-delete / schema-derivation / computed-field helpers that
 * operate on it.
 */

// -- Types ------------------------------------------------------------------
export type {
  CascadeAction,
  CascadeConfig,
  ComputedFieldConfig,
  ComputedFieldFn,
  ComputedFieldsConfig,
  IdStrategy,
  Model,
  ModelConfig,
  MultiTenantInput,
  NestedWriteConfig,
  NormalizedTimestamps,
  RelationConfig,
  RelationResponseConfig,
  RelationsConfig,
  RelationType,
  SchemaKeys,
  SchemaResolveContext,
  SerializationProfile,
  SoftDeleteInput,
  TimestampsInput,
} from './model.types';

// -- Authoring --------------------------------------------------------------
export {
  defineModel,
  normalizeSoftDeleteField,
  normalizeTenantField,
  normalizeTimestamps,
} from './define-model';

export { defineModels, defineModelsExtending } from './model-registry';
export type {
  DefineModelsConfig,
  DefineModelsExtendConfig,
  ModelSpec,
  RelationSpec,
  WiredModel,
  WiredModels,
} from './model-registry';

// -- Managed write-time fields ----------------------------------------------
export {
  applyManagedInsertFields,
  applyManagedUpdateFields,
  getManagedInputExclusions,
} from './managed-fields';

// -- Soft delete ------------------------------------------------------------
export {
  applyUpsertRestore,
  isRowVisible,
  isSoftDeleted,
  softDeleteFieldOf,
  softDeleteVisibilityFilter,
} from './soft-delete';
export type { SoftDeleteVisibility } from './soft-delete';

// -- Schema derivation ------------------------------------------------------
export { deriveCreateSchema, deriveUpdateSchema } from './schema-derive';
export type { DeriveFieldsConfig } from './schema-derive';

// -- Computed fields --------------------------------------------------------
export { applyComputedFields, applyComputedFieldsToArray } from './computed-fields';
export type { ApplyComputedFieldsOptions } from './computed-fields';

// -- Serialization profile ---------------------------------------------------
export { applyProfile, applyProfileToArray } from './serialization-profile';
