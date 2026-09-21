import type { AdapterScope, RuntimeAdapter, TransactionContext } from './adapter/contract';

/** One application registration's scope namespace, shared by its resource adapters. */
export class DatabaseAdapterOwner {
  readonly #scopes = new WeakMap<AdapterScope, AdapterScope>();

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
