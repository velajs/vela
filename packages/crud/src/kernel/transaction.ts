import type {
  AdapterScope,
  CrudAdapter,
  RuntimeAdapter,
  TransactionContext,
} from '../adapter/contract';
import { ConfigurationException } from '../envelope/errors';

/** Explicit callback-lifetime capability. No native handle is accepted from request payloads. */
export class CrudTransactionScope {
  readonly #owner: object;
  readonly #scope: AdapterScope;
  readonly #tenantId: string | undefined;
  readonly #deliveries: Array<() => Promise<void>> = [];
  readonly #pending = new Set<Promise<unknown>>();
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

  #assertUsable(adapter: RuntimeAdapter, context: TransactionContext): void {
    if (!this.#active) throw new TypeError('Expired CRUD transaction');
    if (adapter.transactionOwner !== this.#owner) throw new TypeError('Foreign CRUD transaction');
    if (context.tenantId !== this.#tenantId)
      throw new TypeError('CRUD transaction tenant mismatch');
    if (this.#failed) throw new Error('CRUD transaction has failed', { cause: this.#failure });
  }

  async #join<T>(
    adapter: RuntimeAdapter,
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
    if (this.#pending.size) {
      this.#fail(new TypeError('Unawaited CRUD transaction operation'));
      await Promise.allSettled(this.#pending);
    }
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
    adapter: RuntimeAdapter,
    context: TransactionContext,
  ): void {
    if (!(scope instanceof CrudTransactionScope)) throw new TypeError('Invalid CRUD transaction');
    scope.#assertUsable(adapter, context);
  }
  static join<T>(
    scope: CrudTransactionScope,
    adapter: RuntimeAdapter,
    context: TransactionContext,
    work: (scope: AdapterScope) => Promise<T>,
  ): Promise<T> {
    return scope.#join(adapter, context, work);
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
