import type { AdapterScope, TransactionContext } from '@velajs/crud/adapter';
import { asDatabase, databaseForScope, type DrizzleDatabase } from './database';

type ErrorObserver = ((error: unknown) => void) & {
  track?<T>(work: () => Promise<T>): Promise<T>;
};

/** Execute trusted native store code with a checked current transaction handle. */
export type DrizzleTransactionRunner = <Result>(
  work: (database: DrizzleDatabase) => Promise<Result>,
) => Promise<Result>;

/** Construct a store-author binding, never from request values. Each method on
 * the bound store must call run; retaining its native database is unsupported.
 * run validates the exact native owner and callback lifetime on every call.
 */
export function drizzleTransactionStore<Store>(
  db: object,
  bindNative: (run: DrizzleTransactionRunner, context: TransactionContext) => Store,
): {
  readonly owner: object;
  bind(scope: AdapterScope, context: TransactionContext, onError: ErrorObserver): Store;
} {
  asDatabase(db);
  if (typeof bindNative !== 'function') throw new TypeError('Invalid native store binding');
  return Object.freeze({
    owner: db,
    bind(scope: AdapterScope, context: TransactionContext, onError: ErrorObserver): Store {
      if (typeof onError !== 'function') throw new TypeError('Invalid transaction error observer');
      if (
        !context ||
        typeof context !== 'object' ||
        (context.tenantId !== undefined &&
          (typeof context.tenantId !== 'string' ||
            !context.tenantId.length ||
            context.tenantId.length > 1024))
      )
        throw new TypeError('Invalid transaction tenant');
      databaseForScope(db, scope);
      const trusted = Object.freeze({ ...context });
      return bindNative((work) => {
        const execute = async () => {
          try {
            if (typeof work !== 'function') throw new TypeError('Invalid native store operation');
            return await work(databaseForScope(db, scope));
          } catch (error) {
            onError(error);
            throw error;
          }
        };
        return onError.track ? onError.track(execute) : execute();
      }, trusted);
    },
  });
}
