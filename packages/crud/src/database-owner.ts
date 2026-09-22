import type { AdapterScope, RuntimeAdapter, TransactionContext } from './adapter/contract';
import type { TransactionStoreBinding, TransactionStoreErrorObserver } from './kernel/transaction';

/** One application registration's scope namespace, shared by its resource adapters. */
export class DatabaseAdapterOwner {
  readonly #scopes = new WeakMap<AdapterScope, AdapterScope>();
  readonly #nativeOwners = new Set<object>();
  readonly #stores = new WeakMap<object, object>();

  bindTransactionStore<Store>(
    binding: TransactionStoreBinding<Store>,
  ): TransactionStoreBinding<Store> {
    if (binding.owner === this) return binding;
    if (!this.#nativeOwners.has(binding.owner))
      throw new TypeError('Foreign database registration store');
    return Object.freeze({
      owner: this,
      bind: (
        scope: AdapterScope,
        context: TransactionContext,
        onError: TransactionStoreErrorObserver,
      ) => binding.bind(this.#native(scope), context, onError),
    });
  }

  bindStore<Store extends { readonly transaction?: TransactionStoreBinding<Store> }>(
    store: Store,
  ): Store {
    if (!store.transaction || store.transaction.owner === this) return store;
    const previous = this.#stores.get(store);
    if (previous) return previous as Store;
    const transaction = this.bindTransactionStore(store.transaction);
    // Preserve class-private state: methods and accessors use the original store.
    const bound = new Proxy(Object.create(Object.getPrototypeOf(store)) as Store, {
      get(_target, key) {
        if (key === 'transaction') return transaction;
        const value: unknown = Reflect.get(store, key, store);
        return typeof value === 'function' ? value.bind(store) : value;
      },
      set: (_target, key, value) => key !== 'transaction' && Reflect.set(store, key, value, store),
      deleteProperty: (_target, key) => key !== 'transaction' && Reflect.deleteProperty(store, key),
      defineProperty: (_target, key, descriptor) =>
        key !== 'transaction' &&
        descriptor.configurable !== false &&
        Reflect.defineProperty(store, key, descriptor),
      // The virtual target must stay extensible for forwarded own-property descriptors.
      preventExtensions: () => false,
      setPrototypeOf: () => false,
      has: (_target, key) => Reflect.has(store, key),
      ownKeys: () => Reflect.ownKeys(store),
      getOwnPropertyDescriptor: (_target, key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(store, key);
        if (descriptor && key === 'transaction')
          return {
            value: transaction,
            writable: false,
            enumerable: descriptor.enumerable,
            configurable: true,
          };
        return descriptor ? { ...descriptor, configurable: true } : undefined;
      },
    });
    this.#stores.set(store, bound);
    return bound;
  }

  #native(scope: AdapterScope): AdapterScope {
    const native = this.#scopes.get(scope);
    if (!native) throw new TypeError('Foreign or expired database registration scope');
    return native;
  }

  async #run<T>(
    method: RuntimeAdapter['requestScope'],
    work: (scope: AdapterScope) => Promise<T>,
    context?: TransactionContext,
  ): Promise<T> {
    return method(async (native) => {
      const scope = Object.freeze({ tx: native.tx });
      this.#scopes.set(scope, native);
      try {
        return await work(scope);
      } finally {
        this.#scopes.delete(scope);
      }
    }, context);
  }

  bind(adapter: RuntimeAdapter): RuntimeAdapter {
    if (adapter.transactionOwner) this.#nativeOwners.add(adapter.transactionOwner);
    const {
      aggregate,
      search,
      restore,
      upsertOne,
      updateWhere,
      createMany,
      nested,
      cascade,
      relations,
    } = adapter;
    return {
      ...adapter,
      transactionOwner: adapter.transactionOwner ? this : undefined,
      requestScope: (work, ctx) => this.#run(adapter.requestScope.bind(adapter), work, ctx),
      transaction: (work, ctx) => this.#run(adapter.transaction.bind(adapter), work, ctx),
      create: (row, scope) => adapter.create(row, this.#native(scope)),
      readOne: (key, options, scope) => adapter.readOne(key, options, this.#native(scope)),
      update: (key, row, scope) => adapter.update(key, row, this.#native(scope)),
      delete: (key, options, scope) => adapter.delete(key, options, this.#native(scope)),
      list: (query, scope) => adapter.list(query, this.#native(scope)),
      ...(aggregate
        ? { aggregate: (spec, scope) => aggregate.call(adapter, spec, this.#native(scope)) }
        : {}),
      ...(search
        ? { search: (query, scope) => search.call(adapter, query, this.#native(scope)) }
        : {}),
      ...(restore
        ? { restore: (key, scope) => restore.call(adapter, key, this.#native(scope)) }
        : {}),
      ...(upsertOne
        ? { upsertOne: (input, scope) => upsertOne.call(adapter, input, this.#native(scope)) }
        : {}),
      ...(updateWhere
        ? {
            updateWhere: (filters, row, scope) =>
              updateWhere.call(adapter, filters, row, this.#native(scope)),
          }
        : {}),
      ...(createMany
        ? { createMany: (rows, scope) => createMany.call(adapter, rows, this.#native(scope)) }
        : {}),
      ...(nested
        ? {
            nested: {
              inspectNestedTargets: (row, name, operations, scope) =>
                nested.inspectNestedTargets(row, name, operations, this.#native(scope)),
              createNested: (row, name, items, scope) =>
                nested.createNested(row, name, items, this.#native(scope)),
              applyNested: (row, name, operations, scope) =>
                nested.applyNested(row, name, operations, this.#native(scope)),
            },
          }
        : {}),
      ...(cascade
        ? {
            cascade: {
              countRelated: (name, key, scope) =>
                cascade.countRelated(name, key, this.#native(scope)),
              deleteRelated: (name, key, scope) =>
                cascade.deleteRelated(name, key, this.#native(scope)),
              nullifyRelated: (name, key, scope) =>
                cascade.nullifyRelated(name, key, this.#native(scope)),
            },
          }
        : {}),
      ...(relations
        ? {
            relations: {
              load: (rows, name, loadScope, scope) =>
                relations.load(rows, name, loadScope, this.#native(scope)),
            },
          }
        : {}),
    };
  }
}
