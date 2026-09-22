export type { AuthorizationPlan, CommitEvent, CommitMutation } from './operation-scope';
/**
 * `@velajs/crud/kernel` — the transport-neutral engine: compiled resources,
 * verb executors, and the hook contract.
 */

export type { EngineRequest, EngineRequestVars, EngineResult } from './engine-request';
export { generateETag, matchesIfMatch, matchesIfNoneMatch } from './etag';
export {
  defineResource,
  deriveCapabilityRequirements,
  envelopeOf,
  type CoreVerb,
  type CrudResource,
  type ResourceConfig,
  type ResourcePaginationConfig,
} from './resource';
export { executeCreate, executeDelete, executeList, executeRead, executeUpdate } from './verbs';
export * from './hook-types';
export { runBeforeChain, runHooks } from './run-hooks';

export {
  crudTransaction,
  withCrudTransactionStore,
  type CrudTransactionScope,
  type TransactionStoreBinding,
} from './transaction';
