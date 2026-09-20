import type { MutationStore, PersistedMutation } from './types';

/**
 * A reference in-memory {@link MutationStore}: FIFO, deep-cloned records so a
 * mutation to a returned record can never corrupt the stored copy. Records
 * survive across `LiveClient` instances that share the same store object, so
 * this doubles as the "reload boundary" harness in tests — but a fresh store
 * (the default when no `mutationStore` is supplied) is lost on reload.
 */
export function createMemoryMutationStore(): MutationStore {
  const partitions = new Map<string, PersistedMutation[]>();
  const recordsFor = (account: string): PersistedMutation[] => {
    let records = partitions.get(account);
    if (records === undefined) {
      records = [];
      partitions.set(account, records);
    }
    return records;
  };
  return {
    async append(record, { account }) {
      recordsFor(account).push(clone(record));
    },
    async load({ account }) {
      return recordsFor(account).map(clone);
    },
    async remove(id, { account }) {
      const records = recordsFor(account);
      const index = records.findIndex((record) => record.id === id);
      if (index !== -1) records.splice(index, 1);
    },
    async clear({ account }) {
      partitions.delete(account);
    },
  };
}

const clone = (record: PersistedMutation): PersistedMutation =>
  (globalThis as { structuredClone?: <T>(value: T) => T }).structuredClone?.(record) ??
  (JSON.parse(JSON.stringify(record)) as PersistedMutation);
