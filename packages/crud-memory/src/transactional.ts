import {
  bindAdapter,
  type AdapterScope,
  type CrudAdapter,
  type RuntimeAdapter,
} from '@velajs/crud/adapter';
import { memoryAdapter, type MemoryAdapterConfig } from './adapter';
type Tables = Map<string, Map<string, Record<string, unknown>>>;
/** Explicit instance ownership. Share an instance across models in one database. */
export class MemoryStore {
  #tables: Tables = new Map();
  #participants = new Map<object, unknown>();
  /** Internal store-author seam. A stable typed key owns its cloned transaction state. */
  participant<T>(key: { create(): T }): T {
    if (!this.#participants.has(key)) this.#participants.set(key, key.create());
    // Entries are installed exclusively by this exact typed key's factory.
    return this.#participants.get(key) as T;
  }
  #tail: Promise<void> = Promise.resolve();
  readonly #scopes = new WeakMap<AdapterScope, MemoryStore>();
  table(name: string): Map<string, Record<string, unknown>> {
    let table = this.#tables.get(name);
    if (!table) {
      table = new Map();
      this.#tables.set(name, table);
    }
    return table;
  }
  inScope(scope: AdapterScope): MemoryStore {
    const store = this.#scopes.get(scope);
    if (!store) throw new TypeError('Foreign or expired memory transaction');
    return store;
  }
  async transaction<T>(work: (scope: AdapterScope) => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let unlock!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    const snapshot = new MemoryStore();
    const scope = Object.freeze({ tx: Object.freeze({ kind: 'memory-transaction' }) });
    try {
      snapshot.#tables = structuredClone(this.#tables);
      snapshot.#participants = new Map(
        [...this.#participants].map(([key, value]) => [key, structuredClone(value)]),
      );
      this.#scopes.set(scope, snapshot);
      const result = await work(scope);
      // Detach committed state from values retained by hooks or the caller.
      const committedTables = structuredClone(snapshot.#tables);
      const committedParticipants = new Map(
        [...snapshot.#participants].map(([key, value]) => [key, structuredClone(value)]),
      );
      this.#tables = committedTables;
      this.#participants = committedParticipants;
      return result;
    } finally {
      this.#scopes.delete(scope);
      unlock();
    }
  }
}
/** Serialized, copy-on-write transactions; no module-global or ambient scope. */
export function transactionalMemoryAdapter(
  config: MemoryAdapterConfig & { store: MemoryStore },
): CrudAdapter {
  const adapter = memoryAdapter(config).runtime;
  const scoped = (scope: AdapterScope) =>
    memoryAdapter({ ...config, store: config.store.inScope(scope) }).runtime;
  const runtime: RuntimeAdapter = {
    ...adapter,
    transactionOwner: config.store,
    capabilities: new Set([...adapter.capabilities, 'transactions']),
    requestScope: (fn) => config.store.transaction(fn),
    transaction: (fn) => config.store.transaction(fn),
    create: (row, scope) => scoped(scope).create(structuredClone(row), scope),
    readOne: async (key, opts, scope) =>
      structuredClone(await scoped(scope).readOne(key, opts, scope)),
    update: (key, row, scope) => scoped(scope).update(key, structuredClone(row), scope),
    delete: (key, opts, scope) => scoped(scope).delete(key, opts, scope),
    list: async (query, scope) => structuredClone(await scoped(scope).list(query, scope)),
    restore: (key, scope) => scoped(scope).restore!(key, scope),
    nested: {
      inspectNestedTargets: (row, name, ops, scope) =>
        scoped(scope).nested!.inspectNestedTargets(row, name, ops, scope),
      createNested: (row, name, items, scope) =>
        scoped(scope).nested!.createNested(row, name, items, scope),
      applyNested: (row, name, ops, scope) =>
        scoped(scope).nested!.applyNested(row, name, ops, scope),
    },
    cascade: {
      countRelated: (name, key, scope) => scoped(scope).cascade!.countRelated(name, key, scope),
      deleteRelated: (name, key, scope) => scoped(scope).cascade!.deleteRelated(name, key, scope),
      nullifyRelated: (name, key, scope) => scoped(scope).cascade!.nullifyRelated(name, key, scope),
    },
    relations: {
      load: (rows, name, loadScope, scope) =>
        scoped(scope).relations!.load(rows, name, loadScope, scope),
    },
  };
  return bindAdapter(runtime);
}
