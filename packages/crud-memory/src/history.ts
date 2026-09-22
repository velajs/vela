import { MemoryAuditStore, type AuditEntry, type AuditStore } from '@velajs/crud/audit';
import {
  MemoryVersioningStore,
  historyNamespaceFor,
  type VersionEntry,
  type VersioningStore,
  type VersionRecordKey,
} from '@velajs/crud/versioning';
import type { MemoryStore } from './transactional';

/** History shares the exact MemoryStore copy-on-write boundary as resource rows. */
export function transactionalMemoryVersioningStore(owner: MemoryStore): VersioningStore {
  const key = { create: () => new Map<string, VersionEntry[]>() };
  class Store extends MemoryVersioningStore {
    constructor(private readonly state: () => MemoryStore) {
      super();
    }
    protected override get versions() {
      return this.state().participant(key);
    }
  }
  const standalone = new Store(() => owner);
  const writes: Pick<VersioningStore, 'save' | 'prune' | 'deleteAll'> = {
    save: (name, recordKey, entry) =>
      owner.transaction((scope) =>
        new Store(() => owner.inScope(scope)).save(name, recordKey, entry),
      ),
    prune: (name, recordKey, count) =>
      owner.transaction((scope) =>
        new Store(() => owner.inScope(scope)).prune(name, recordKey, count),
      ),
    deleteAll: (name, recordKey) =>
      owner.transaction((scope) =>
        new Store(() => owner.inScope(scope)).deleteAll(name, recordKey),
      ),
  };
  return Object.assign(standalone, writes, {
    transaction: {
      owner,
      bind(scope, context, onError) {
        const store = new Store(() => owner.inScope(scope));
        const run = async <T>(recordKey: VersionRecordKey, work: () => Promise<T>): Promise<T> => {
          const execute = async () => {
            try {
              owner.inScope(scope);
              if (recordKey.tenantNamespace !== historyNamespaceFor(context))
                throw new TypeError('Version transaction tenant mismatch');
              return await work();
            } catch (error) {
              onError(error);
              throw error;
            }
          };
          return onError.track ? onError.track(execute) : execute();
        };
        return {
          save: (name, recordKey, entry) =>
            run(recordKey, () => store.save(name, recordKey, entry)),
          list: (name, recordKey, options) =>
            run(recordKey, () => store.list(name, recordKey, options)),
          get: (name, recordKey, version) =>
            run(recordKey, () => store.get(name, recordKey, version)),
          latest: (name, recordKey) => run(recordKey, () => store.latest(name, recordKey)),
          prune: (name, recordKey, count) =>
            run(recordKey, () => store.prune(name, recordKey, count)),
          deleteAll: (name, recordKey) => run(recordKey, () => store.deleteAll(name, recordKey)),
        };
      },
    } satisfies NonNullable<VersioningStore['transaction']>,
  });
}

export function transactionalMemoryAuditStore(owner: MemoryStore): AuditStore {
  const key = { create: (): AuditEntry[] => [] };
  class Store extends MemoryAuditStore {
    constructor(private readonly state: () => MemoryStore) {
      super();
    }
    protected override get entries() {
      return this.state().participant(key);
    }
  }
  const standalone = new Store(() => owner);
  const writes: Pick<AuditStore, 'log' | 'logBatch'> = {
    log: (entry) => owner.transaction((scope) => new Store(() => owner.inScope(scope)).log(entry)),
    logBatch: (entries) =>
      owner.transaction((scope) => new Store(() => owner.inScope(scope)).logBatch(entries)),
  };
  return Object.assign(standalone, writes, {
    transaction: {
      owner,
      bind(scope, context, onError) {
        const store = new Store(() => owner.inScope(scope));
        const namespace = historyNamespaceFor(context);
        const scoped = <T extends { tenantNamespace?: string }>(
          value: T,
        ): T & { tenantNamespace: string } => {
          if (value.tenantNamespace !== undefined && value.tenantNamespace !== namespace)
            throw new TypeError('Audit transaction tenant mismatch');
          return { ...value, tenantNamespace: namespace };
        };
        const run = async <T>(work: () => Promise<T>): Promise<T> => {
          const execute = async () => {
            try {
              owner.inScope(scope);
              return await work();
            } catch (error) {
              onError(error);
              throw error;
            }
          };
          return onError.track ? onError.track(execute) : execute();
        };
        return {
          log: (entry) => run(() => store.log(scoped(entry))),
          logBatch: (entries) => run(() => store.logBatch(entries.map(scoped))),
          query: (options = {}) => run(() => store.query(scoped(options))),
        };
      },
    } satisfies NonNullable<AuditStore['transaction']>,
  });
}
