import { drizzle } from 'drizzle-orm/durable-sqlite';
import { drizzleAdapter, type DrizzleAdapterConfig } from '@velajs/crud-drizzle';
import { bindAdapter, type CrudAdapter } from '@velajs/crud/adapter';

/** One object's SQLite storage is the complete transaction boundary. */
export function durableObjectSqliteAdapter(
  options: Omit<
    DrizzleAdapterConfig,
    'db' | 'driver' | 'dialect' | 'onOpenTransaction' | 'transactionOwner'
  > & {
    storage: DurableObjectStorage;
  },
): CrudAdapter {
  const { storage, ...config } = options;
  const db = drizzle(storage);
  const base = drizzleAdapter({
    ...config,
    db,
    dialect: 'sqlite',
    transactionOwner: storage,
  }).runtime;
  const transaction: typeof base.transaction = (work) =>
    storage.transaction(() => base.requestScope(work));
  return bindAdapter({ ...base, requestScope: transaction, transaction });
}
