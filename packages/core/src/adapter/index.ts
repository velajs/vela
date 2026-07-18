/**
 * `@velajs/crud/adapter` — the contract adapter authors implement.
 */

export {
  ADAPTER_CAPABILITIES,
  CAPABILITY_MEMBERS,
  type AdapterCapability,
  type AdapterScope,
  type CascadeDriver,
  type CrudAdapter,
  type NestedWriteDriver,
  type NestedWriteInspection,
  type NestedWriteOperations,
  type RelationLoader,
  type RelationLoadScope,
  type TransactionContext,
} from './contract';
export { assertAdapterSatisfies, type CapabilityRequirement } from './capabilities';
export * from './query-types';
