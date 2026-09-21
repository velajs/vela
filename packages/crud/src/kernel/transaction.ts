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

  #finish(): void {
    if (this.#busy) this.#fail(new TypeError('Unawaited CRUD transaction operation'));
    this.#active = false;
    if (this.#failed) throw new Error('CRUD transaction rolled back', { cause: this.#failure });
  }

  #close(): void {
    this.#active = false;
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
        const result = await work(transaction);
        transaction.#finish();
        return result;
      }, context);
      if (transaction) await transaction.#deliver();
      return result;
    } finally {
      transaction && transaction.#close();
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
