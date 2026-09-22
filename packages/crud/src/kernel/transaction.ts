import type {
  AdapterScope,
  CrudAdapter,
  RuntimeAdapter,
  TransactionContext,
} from '../adapter/contract';
import { ConfigurationException } from '../envelope/errors';

/** Trusted adapter integration, configured by application code, never request input.
 * bind must return operations that validate scope lifetime on every invocation.
 */
export interface TransactionStoreErrorObserver {
  (error: unknown): void;
  /** Store authors must wrap every asynchronous bound method when provided. */
  track?<T>(work: () => Promise<T>): Promise<T>;
}

export interface TransactionStoreBinding<Store> {
  readonly owner: object;
  bind(
    scope: AdapterScope,
    context: TransactionContext,
    onError: TransactionStoreErrorObserver,
  ): Store;
}

export function assertTransactionContext(context: TransactionContext): void {
  if (!context || typeof context !== 'object') throw new TypeError('Invalid transaction context');
  if (
    context.tenantId !== undefined &&
    (typeof context.tenantId !== 'string' ||
      !context.tenantId.length ||
      context.tenantId.length > 1024)
  )
    throw new TypeError('Invalid transaction tenant');
}

/** Explicit callback-lifetime capability. No native handle is accepted from request payloads. */
export class CrudTransactionScope {
  readonly #owner: object;
  readonly #scope: AdapterScope;
  readonly #tenantId: string | undefined;
  readonly #deliveries: Array<() => Promise<void>> = [];
  readonly #pending = new Set<Promise<unknown>>();
  readonly #storePending = new Set<Promise<unknown>>();
  #accepting = true;
  #active = true;
  #failure: unknown;
  #failed = false;
  #busy = false;

  private constructor(owner: object, scope: AdapterScope, context: TransactionContext) {
    this.#owner = owner;
    this.#scope = scope;
    this.#tenantId = context.tenantId;
  }

  #assertUsable(
    adapter: Pick<RuntimeAdapter, 'transactionOwner'>,
    context: TransactionContext,
  ): void {
    assertTransactionContext(context);
    if (!this.#active) throw new TypeError('Expired CRUD transaction');
    if (adapter.transactionOwner !== this.#owner) throw new TypeError('Foreign CRUD transaction');
    if (context.tenantId !== this.#tenantId)
      throw new TypeError('CRUD transaction tenant mismatch');
    if (this.#failed) throw new Error('CRUD transaction has failed', { cause: this.#failure });
  }

  async #join<T>(
    adapter: Pick<RuntimeAdapter, 'transactionOwner'>,
    context: TransactionContext,
    work: (scope: AdapterScope) => Promise<T>,
  ): Promise<T> {
    this.#assertUsable(adapter, context);
    if (this.#busy) throw new TypeError('Await each operation in a CRUD transaction');
    this.#busy = true;
    try {
      return await work(this.#scope);
    } catch (error) {
      this.#fail(error);
      throw error;
    } finally {
      this.#busy = false;
    }
  }

  #defer(delivery: () => Promise<void>): void {
    if (!this.#active) throw new TypeError('Expired CRUD transaction');
    this.#deliveries.push(delivery);
  }

  #fail(error: unknown): void {
    if (this.#active && !this.#failed) {
      this.#failed = true;
      this.#failure = error;
    }
  }

  async #drain(): Promise<void> {
    this.#accepting = false;
    if (this.#pending.size || this.#storePending.size) {
      this.#fail(new TypeError('Unawaited CRUD transaction operation'));
      await Promise.allSettled([...this.#pending, ...this.#storePending]);
    }
  }

  #trackStore<T>(work: () => Promise<T>): Promise<T> {
    if (!this.#active || !this.#accepting)
      return Promise.reject(new TypeError('Expired CRUD transaction'));
    if (typeof work !== 'function') {
      const error = new TypeError('Invalid transaction store operation');
      this.#fail(error);
      return Promise.reject(error);
    }
    if (this.#failed)
      return Promise.reject(new Error('CRUD transaction has failed', { cause: this.#failure }));
    const pending = Promise.resolve().then(work);
    this.#storePending.add(pending);
    void pending.then(
      () => {
        this.#storePending.delete(pending);
      },
      (error: unknown) => {
        this.#fail(error);
        this.#storePending.delete(pending);
      },
    );
    return pending;
  }

  async #finish(): Promise<void> {
    await this.#drain();
    this.#active = false;
    if (this.#failed) throw new Error('CRUD transaction rolled back', { cause: this.#failure });
  }

  #close(): void {
    this.#accepting = false;
    this.#active = false;
    this.#deliveries.length = 0;
  }

  async #deliver(): Promise<void> {
    // Delivery errors cannot roll back a committed database. Run every delivery.
    for (const delivery of this.#deliveries) {
      try {
        await delivery();
      } catch (error) {
        console.error('[crud] committed write delivery failed', error);
      }
    }
  }

  static execute<T>(scope: CrudTransactionScope, work: () => Promise<T>): Promise<T> {
    if (!scope.#active || !scope.#accepting)
      return Promise.reject(new TypeError('Expired CRUD transaction'));
    if (scope.#pending.size) {
      const error = new TypeError('Await each operation in a CRUD transaction');
      scope.#fail(error);
      return Promise.reject(error);
    }
    const pending = work();
    scope.#pending.add(pending);
    // Observe without creating an unhandled rejection from a detached finally().
    void pending.then(
      () => {
        scope.#pending.delete(pending);
      },
      (error: unknown) => {
        scope.#fail(error);
        scope.#pending.delete(pending);
      },
    );
    return pending;
  }

  static assert(
    scope: CrudTransactionScope,
    adapter: Pick<RuntimeAdapter, 'transactionOwner'>,
    context: TransactionContext,
  ): void {
    if (!(scope instanceof CrudTransactionScope)) throw new TypeError('Invalid CRUD transaction');
    scope.#assertUsable(adapter, context);
  }
  static join<T>(
    scope: CrudTransactionScope,
    adapter: Pick<RuntimeAdapter, 'transactionOwner'>,
    context: TransactionContext,
    work: (scope: AdapterScope) => Promise<T>,
  ): Promise<T> {
    return scope.#join(adapter, context, work);
  }
  /** Engine/store-author seam. Native scopes are supplied only to trusted bindings. */
  static bindStore<Store>(
    scope: CrudTransactionScope,
    binding: TransactionStoreBinding<Store>,
    context: TransactionContext,
  ): Store {
    if (!(scope instanceof CrudTransactionScope)) throw new TypeError('Invalid CRUD transaction');
    try {
      if (
        !binding ||
        typeof binding !== 'object' ||
        !binding.owner ||
        typeof binding.owner !== 'object' ||
        typeof binding.bind !== 'function'
      )
        throw new TypeError('Invalid transaction store binding');
      CrudTransactionScope.assert(scope, { transactionOwner: binding.owner }, context);
      const observer: TransactionStoreErrorObserver = Object.freeze(
        Object.assign((error: unknown) => scope.#fail(error), {
          track: <T>(work: () => Promise<T>) => scope.#trackStore(work),
        }),
      );
      return binding.bind(scope.#scope, Object.freeze({ ...context }), observer);
    } catch (error) {
      scope.#fail(error);
      throw error;
    }
  }

  static defer(scope: CrudTransactionScope, delivery: () => Promise<void>): void {
    scope.#defer(delivery);
  }
  static fail(scope: CrudTransactionScope, error: unknown): void {
    scope.#fail(error);
  }

  static async run<T>(
    adapter: Pick<CrudAdapter, 'runtime'>,
    context: TransactionContext,
    work: (transaction: CrudTransactionScope) => Promise<T>,
  ): Promise<T> {
    assertTransactionContext(context);
    context = Object.freeze({ ...context });
    const runtime = adapter.runtime;
    if (!runtime.transactionOwner || !runtime.capabilities.has('transactions'))
      throw new ConfigurationException('This adapter does not support owned callback transactions');
    const owner = runtime.transactionOwner;
    let transaction: CrudTransactionScope | undefined;
    try {
      const result = await runtime.transaction(async (scope) => {
        transaction = new CrudTransactionScope(owner, scope, context);
        try {
          const result = await work(transaction);
          await transaction.#finish();
          return result;
        } catch (error) {
          transaction.#fail(error);
          await transaction.#drain();
          transaction.#close();
          throw error;
        }
      }, context);
      if (transaction) await transaction.#deliver();
      return result;
    } finally {
      if (transaction) transaction.#close();
    }
  }
}

/** Compose resources sharing an exact adapter owner. Cross-database atomicity is unsupported. */
export async function crudTransaction<T>(
  adapter: Pick<CrudAdapter, 'runtime'>,
  context: TransactionContext,
  work: (transaction: CrudTransactionScope) => Promise<T>,
): Promise<T> {
  return CrudTransactionScope.run(adapter, context, work);
}

/** Join a native store operation using a trusted binding, with the same owner,
 * tenant, callback lifetime and awaited-operation rules as resource.execute().
 */
export function withCrudTransactionStore<Store, Result>(
  transaction: CrudTransactionScope,
  binding: TransactionStoreBinding<Store>,
  context: TransactionContext,
  work: (store: Store) => Promise<Result>,
): Promise<Result> {
  if (!(transaction instanceof CrudTransactionScope))
    return Promise.reject(new TypeError('Invalid CRUD transaction'));
  return CrudTransactionScope.execute(transaction, async () => {
    if (typeof work !== 'function') throw new TypeError('Invalid transaction store operation');
    const store = CrudTransactionScope.bindStore(transaction, binding, context);
    return CrudTransactionScope.join(
      transaction,
      { transactionOwner: binding.owner },
      context,
      () => work(store),
    );
  });
}
