import type { MutationStore, PersistedMutation } from './types';

/**
 * A reference in-memory {@link MutationStore}: FIFO, deep-cloned records so a
 * mutation to a returned record can never corrupt the stored copy. Records
 * survive across `LiveClient` instances that share the same store object, so
 * this doubles as the "reload boundary" harness in tests — but a fresh store
 * (the default when no `mutationStore` is supplied) is lost on reload.
 */
export function createMemoryMutationStore(): MutationStore {
  const records: PersistedMutation[] = [];
  return {
    async append(record) {
      records.push(clone(record));
    },
    async load() {
      return records.map(clone);
    },
    async remove(id) {
      const index = records.findIndex((record) => record.id === id);
      if (index !== -1) records.splice(index, 1);
    },
    async clear() {
      records.length = 0;
    },
  };
}

const clone = (record: PersistedMutation): PersistedMutation =>
  (globalThis as { structuredClone?: <T>(value: T) => T }).structuredClone?.(record) ??
  (JSON.parse(JSON.stringify(record)) as PersistedMutation);
