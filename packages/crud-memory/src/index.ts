/**
 * @velajs/crud-memory — in-memory CrudAdapter for tests and prototyping.
 */

export {
  MEMORY_NOOP_TX,
  memoryAdapter,
  type MemoryAdapterConfig,
  type MemoryRelation,
} from './adapter';
export { matchesFilter } from './filter';
export { clearMemoryStorage, getStore, storage } from './storage';
export { MemoryStore, transactionalMemoryAdapter } from './transactional';
export { transactionalMemoryVersioningStore, transactionalMemoryAuditStore } from './history';
