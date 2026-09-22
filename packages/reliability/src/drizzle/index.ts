import { getTableColumns, type Table } from 'drizzle-orm';
import {
  withCrudTransactionStore,
  type CrudTransactionScope,
  type TransactionStoreBinding,
} from '@velajs/crud';
import {
  drizzleInsertCommand,
  drizzleTransactionStore,
  type DrizzleHandle,
  type DrizzleD1Handle,
} from '@velajs/crud-drizzle';
import type { TransactionContext, AtomicCommand } from '@velajs/crud/adapter';
import {
  ReliabilityError,
  type ReliabilityStore,
  type ReliabilitySession,
  type ReliabilityScope,
  type WorkRecord,
  type Decoder,
  type ClaimOptions,
} from '../types';
import {
  DEFAULT_BYTES,
  MAX_BYTES,
  decodeRecord,
  encodeJson,
  decodeJson,
  fingerprint,
  integer,
  scope as validateScope,
} from '../validation';
import { newRecord } from '../features';
import { orm, session } from './database';
import { withSession } from './lifetime';
export { reliabilityPgTable, reliabilitySqliteTable } from './schema';

export type DrizzleReliabilityConfig = { readonly table: Table } & (
  | {
      readonly driver: 'd1';
      readonly dialect?: 'sqlite';
      readonly db: DrizzleD1Handle;
      readonly onOpenTransaction?: never;
    }
  | {
      readonly driver?: 'transactional';
      readonly dialect: 'pg' | 'sqlite';
      readonly db: DrizzleHandle;
      readonly onOpenTransaction?: (
        db: unknown,
        context: TransactionContext,
      ) => void | Promise<void>;
    }
);
const columnNames = [
  'tenantId',
  'namespace',
  'kind',
  'id',
  'generation',
  'fingerprint',
  'payload',
  'state',
  'token',
  'fence',
  'revision',
  'attempt',
  'maxAttempts',
  'availableAt',
  'leaseUntil',
  'createdAt',
  'updatedAt',
  'retentionMs',
  'expiresAt',
  'result',
  'error',
];
function checkTable(table: Table): void {
  const keys = Object.keys(getTableColumns(table));
  if (keys.length !== columnNames.length || columnNames.some((key) => !keys.includes(key)))
    throw new TypeError('Use the documented reliability table columns');
}
export function createDrizzleReliabilityStore(
  config: DrizzleReliabilityConfig,
): ReliabilityStore<CrudTransactionScope> & {
  readonly transactionBinding: TransactionStoreBinding<ReliabilityStore>;
} {
  checkTable(config.table);
  const root = orm(config.db);
  const d1 = config.driver === 'd1';
  const dialect = config.dialect ?? 'sqlite';
  if (dialect !== 'pg' && dialect !== 'sqlite')
    throw new ReliabilityError('UNSUPPORTED', 'Reliability requires PostgreSQL or SQLite');
  if (d1 && (dialect !== 'sqlite' || config.onOpenTransaction))
    throw new ReliabilityError('UNSUPPORTED', 'D1 cannot initialize callback transactions');
  if (
    !d1 &&
    dialect === 'sqlite' &&
    (!('resultKind' in config.db) || config.db.resultKind !== 'async')
  )
    throw new ReliabilityError(
      'UNSUPPORTED',
      'SQLite requires real asynchronous callback transactions',
    );
  const binding = drizzleTransactionStore(
    config.db,
    (run, context): ReliabilityStore => ({
      run: (scope, work) =>
        run(async (db) => {
          if (d1)
            throw new ReliabilityError(
              'UNSUPPORTED',
              'D1 cannot join fenced callback transactions',
            );
          const trusted = validateScope(scope);
          if (trusted.tenantId !== context.tenantId)
            throw new TypeError('Reliability transaction tenant mismatch');
          return withSession(session(db, config.table, trusted, dialect, false), work);
        }),
    }),
  );
  return Object.freeze({
    transactionBinding: binding,
    async run<T>(
      scope: ReliabilityScope,
      work: (session: ReliabilitySession) => Promise<T>,
      transaction?: CrudTransactionScope,
    ): Promise<T> {
      const trusted = validateScope(scope);
      if (transaction !== undefined) {
        if (d1)
          throw new ReliabilityError(
            'UNSUPPORTED',
            'D1 cannot compose fenced business writes; use an unconditional outbox insert command',
          );
        return withCrudTransactionStore(
          transaction,
          binding,
          { tenantId: trusted.tenantId },
          (store) => store.run(trusted, work),
        );
      }
      // Standalone operations are native CAS statements. Opening a write transaction
      // before validation/read work needlessly blocks other SQLite connections.
      if (d1 || !config.onOpenTransaction)
        return withSession(session(config.db, config.table, trusted, dialect, d1, true), work);
      return root.transaction(async (native) => {
        await config.onOpenTransaction?.(native, { tenantId: trusted.tenantId });
        return withSession(session(native, config.table, trusted, dialect, false), work);
      });
    },
  });
}
/** Only unconditional, precomputed admission. No result-dependent guard is implied. */
export async function prepareOutboxInsert<T>(options: {
  readonly db: DrizzleHandle;
  readonly table: Table;
  readonly scope: ReliabilityScope;
  readonly input: {
    readonly id: string;
    readonly payload: unknown;
    readonly availableAt?: number;
  } & ClaimOptions;
  readonly parsePayload: Decoder<T>;
  readonly admission: 'unconditional';
  readonly maxPayloadBytes?: number;
  readonly onOpenTransaction?: (db: unknown, context: TransactionContext) => void | Promise<void>;
}): Promise<AtomicCommand<WorkRecord>> {
  if (options.admission !== 'unconditional')
    throw new ReliabilityError(
      'UNSUPPORTED',
      'Conditional outbox admission requires a real transaction',
    );
  const trusted = validateScope(options.scope);
  checkTable(options.table);
  const bound = integer(options.maxPayloadBytes ?? DEFAULT_BYTES, 'maxPayloadBytes', 1, MAX_BYTES);
  const payload = encodeJson(await options.parsePayload(options.input.payload), bound);
  const digest = await fingerprint(
    { payload: decodeJson(payload, bound), dueAt: options.input.availableAt ?? null },
    Math.min(MAX_BYTES, bound + 1024),
  );
  const record = newRecord(
    trusted,
    'outbox',
    options.input.id,
    payload,
    digest,
    Date.now(),
    options.input,
    options.input.availableAt ?? 0,
  );
  return drizzleInsertCommand({
    db: options.db,
    table: options.table,
    values: { ...record },
    ...(options.onOpenTransaction === undefined
      ? {}
      : { onOpenTransaction: options.onOpenTransaction }),
    parseRows: (rows) => {
      if (rows.length !== 1) throw new TypeError('Expected one outbox admission');
      return decodeRecord(rows[0]);
    },
  });
}
