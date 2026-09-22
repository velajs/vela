import { getTableColumns, sql } from 'drizzle-orm';
import {
  // oxlint-disable-next-line eslint/no-unused-vars -- used by the computed phantom result slot
  type ATOMIC_RESULT,
  type AtomicBatchDriver,
  type AtomicCommand,
  type AtomicResults,
  type AtomicWriteOptions,
  type Lookup,
  type DeleteOptions,
  type TransactionContext,
} from '@velajs/crud/adapter';
import { AtomicBatchResultError } from '@velajs/crud';
import { validatePredicate } from '@velajs/crud/query';
import type { AuditEntry, AtomicAuditDriver } from '@velajs/crud/audit';
import {
  asDatabase,
  type DrizzleDatabase,
  type DrizzleSql,
  type DrizzleTable,
  type DrizzleHandle,
  readRow,
} from './database';
import { checkedD1Query } from './filters';

type Row = Record<string, unknown>;
type Query = PromiseLike<Row[]>;
type Open = (tx: unknown, context: TransactionContext) => void | Promise<void>;
const ISSUE_COMMAND = Symbol('drizzle.atomic.command');

/** Module-private brand authenticates the issuer, owner and result decoder. */
class Command<Result> implements AtomicCommand<Result> {
  declare readonly [ATOMIC_RESULT]: Result;
  readonly #issued = true;
  constructor(
    issuer: typeof ISSUE_COMMAND,
    readonly owner: object,
    readonly kind: 'write' | 'audit',
    readonly build: (db: DrizzleDatabase, conditional: boolean) => Query,
    readonly decode: (rows: Row[]) => Result,
    readonly audit?: Command<void>,
    readonly open?: Open,
  ) {
    if (issuer !== ISSUE_COMMAND)
      throw new TypeError('Atomic commands must be prepared by their adapter');
    Object.freeze(this);
  }

  static isIssued(value: unknown): value is Command<unknown> {
    return typeof value === 'object' && value !== null && #issued in value && value.#issued;
  }
}

function owned(command: AtomicCommand, owner: object): Command<unknown> {
  if (!Command.isIssued(command) || command.owner !== owner)
    throw new TypeError(
      'Foreign or fabricated atomic command: use the exact same native database handle',
    );
  return command;
}

function decodeResult(command: Command<unknown>, result: unknown): unknown {
  if (!Array.isArray(result)) throw new TypeError('Expected atomic result rows');
  return command.decode(result.map(readRow));
}

/** Prepare a trusted, unconditional insert for the existing native atomic batch.
 * Inputs are copied now; the decoder runs in the SQL transaction, or after a D1
 * batch has committed. This is not a guard for another command's scoped miss.
 */
export function drizzleInsertCommand<Result>(options: {
  db: DrizzleHandle;
  table: DrizzleTable;
  values: Readonly<Record<string, unknown>>;
  parseRows: (rows: readonly Record<string, unknown>[]) => Result;
  onOpenTransaction?: Open;
}): AtomicCommand<Result> {
  const owner = asDatabase(options.db);
  const table = options.table;
  if (typeof options.parseRows !== 'function') throw new TypeError('Expected an insert decoder');
  if (options.onOpenTransaction !== undefined && typeof options.onOpenTransaction !== 'function')
    throw new TypeError('Expected a transaction context initializer');
  if (!options.values || typeof options.values !== 'object' || Array.isArray(options.values))
    throw new TypeError('Expected insert values');
  const columns = getTableColumns(table);
  if (Object.keys(options.values).some((column) => !Object.hasOwn(columns, column)))
    throw new TypeError('Unknown atomic insert column');
  const values = structuredClone(options.values);
  const parseRows = options.parseRows;
  return new Command(
    ISSUE_COMMAND,
    owner,
    'write',
    (database) => database.insert(table).values(values).returning(),
    (rows) => {
      const result = parseRows(rows);
      if (
        result !== null &&
        (typeof result === 'object' || typeof result === 'function') &&
        'then' in result &&
        typeof result.then === 'function'
      )
        throw new TypeError('Atomic insert decoders must be synchronous');
      return result;
    },
    undefined,
    options.onOpenTransaction,
  );
}

export function atomicAuditDriver(owner: object, table: DrizzleTable): AtomicAuditDriver {
  return Object.freeze({
    owner,
    prepare(entry: AuditEntry): AtomicCommand<void> {
      const values = {
        id: entry.id,
        timestamp: entry.timestamp.getTime(),
        action: entry.action,
        tableName: entry.tableName,
        recordId: String(entry.recordId),
        userId: entry.userId ?? null,
        record: entry.record === undefined ? null : JSON.stringify(entry.record),
        previousRecord:
          entry.previousRecord === undefined ? null : JSON.stringify(entry.previousRecord),
        changes: entry.changes === undefined ? null : JSON.stringify(entry.changes),
        metadata: entry.metadata === undefined ? null : JSON.stringify(entry.metadata),
      };
      const columns = Object.keys(getTableColumns(table));
      if (
        columns.length !== Object.keys(values).length ||
        columns.some((key) => !Object.hasOwn(values, key))
      )
        throw new TypeError('Atomic audit requires exactly the documented audit table columns');
      const row: Row = values;
      return new Command(
        ISSUE_COMMAND,
        owner,
        'audit',
        (db, conditional) =>
          conditional
            ? db
                .insert(table)
                .select(
                  sql`select ${sql.join(
                    columns.map((key) => sql`${row[key]}`),
                    sql`, `,
                  )} where changes() > 0`,
                )
                .returning()
            : db.insert(table).values(values).returning(),
        () => undefined,
      );
    },
  });
}

export function atomicBatchDriver<RowType extends Row>(options: {
  owner: object;
  driver?: 'd1' | 'transactional';
  table: DrizzleTable;
  primaryKeys: readonly string[];
  where: (lookup: Lookup) => DrizzleSql | undefined;
  parse: (value: unknown) => RowType;
  open?: Open;
}): AtomicBatchDriver<RowType> {
  const { owner, table, parse } = options;
  const db = asDatabase(owner);
  if (options.driver === 'd1' && typeof db.batch !== 'function')
    throw new TypeError('D1 atomic batches require native db.batch');
  const attached = (write?: AtomicWriteOptions): Command<void> | undefined => {
    if (write?.audit === undefined) return undefined;
    const command = owned(write.audit, owner);
    if (command.kind !== 'audit') throw new TypeError('Expected an atomic audit command');
    // The private kind is only issued with the void decoder above.
    return command as Command<void>;
  };
  const key = (lookup: Lookup): Lookup => {
    if (
      !options.primaryKeys.includes(lookup.field) ||
      options.primaryKeys.some(
        (field) => field !== lookup.field && !Object.hasOwn(lookup.filters ?? {}, field),
      )
    )
      throw new TypeError('Atomic writes require a complete primary-key lookup');
    const copied = structuredClone(lookup);
    if (copied.predicate)
      copied.predicate = validatePredicate(
        copied.predicate,
        new Set(Object.keys(getTableColumns(table))),
      );
    return copied;
  };
  const decode = (rows: Row[]): RowType | null => {
    if (!Array.isArray(rows) || rows.length > 1)
      throw new TypeError('Expected at most one atomic mutation row');
    return rows[0] === undefined ? null : parse(readRow(rows[0]));
  };
  return Object.freeze({
    owner,
    create(input: Partial<RowType>, write?: AtomicWriteOptions): AtomicCommand<RowType> {
      const values = structuredClone(input);
      return new Command(
        ISSUE_COMMAND,
        owner,
        'write',
        (tx) => tx.insert(table).values(values).returning(),
        (rows) => {
          const row = decode(rows);
          if (!row) throw new TypeError('Atomic create returned no row');
          return row;
        },
        attached(write),
        options.open,
      );
    },
    update(
      lookup: Lookup,
      patch: Partial<RowType>,
      write?: AtomicWriteOptions,
    ): AtomicCommand<RowType | null> {
      const selector = key(lookup);
      const values = structuredClone(patch);
      return new Command(
        ISSUE_COMMAND,
        owner,
        'write',
        (tx) => tx.update(table).set(values).where(options.where(selector)).returning(),
        decode,
        attached(write),
        options.open,
      );
    },
    delete(
      lookup: Lookup,
      config: DeleteOptions,
      write?: AtomicWriteOptions,
    ): AtomicCommand<RowType | null> {
      const selector = key(lookup);
      const field = config.softDeleteField;
      const timestamp = Date.now();
      return new Command(
        ISSUE_COMMAND,
        owner,
        'write',
        (tx) =>
          (field === undefined ? tx.delete(table) : tx.update(table).set({ [field]: timestamp }))
            .where(options.where(selector))
            .returning(),
        decode,
        attached(write),
        options.open,
      );
    },
    async execute<const Commands extends readonly AtomicCommand[]>(
      commands: Commands,
      context?: TransactionContext,
    ): Promise<AtomicResults<Commands>> {
      if (!Array.isArray(commands)) throw new TypeError('Expected an atomic command array');
      if (
        context !== undefined &&
        (!context ||
          typeof context !== 'object' ||
          (context.tenantId !== undefined && typeof context.tenantId !== 'string'))
      )
        throw new TypeError('Invalid atomic transaction context');
      const prepared = Array.from(commands, (value: AtomicCommand) => {
        const command = owned(value, owner);
        if (command.kind === 'write' && command.open !== options.open)
          throw new TypeError('Atomic commands require the same transaction context initializer');
        if (command.audit) owned(command.audit, owner);
        return command;
      });
      // Build all statements (and prepare D1 exactly once) before the boundary.
      // Never chunk a batch:
      // chunking would lose all-or-nothing semantics when a later statement fails.
      const groups = prepared.map((command) => {
        const queries = [command.build(db, false)];
        if (command.audit) queries.push(command.audit.build(db, options.driver === 'd1'));
        return options.driver === 'd1' ? queries.map(checkedD1Query) : queries;
      });
      if (!commands.length) return [] as unknown as AtomicResults<Commands>;
      if (options.driver !== 'd1') {
        return await db.transaction(async (native) => {
          const tx = asDatabase(native);
          await options.open?.(native, context ?? {});
          const decoded: unknown[] = [];
          for (const command of prepared) {
            // Statements and their conditional audits must execute in order.
            // oxlint-disable-next-line eslint/no-await-in-loop
            const result = await command.build(tx, false);
            decoded.push(decodeResult(command, result));
            if (result.length && command.audit)
              // oxlint-disable-next-line eslint/no-await-in-loop
              decodeResult(command.audit, await command.audit.build(tx, false));
          }
          return decoded as AtomicResults<Commands>;
        });
      }
      const queries = groups.flat();
      const batched = await db.batch!(queries);
      try {
        if (!Array.isArray(batched) || batched.length !== queries.length)
          throw new TypeError('Invalid D1 batch result count');
        let offset = 0;
        // Each slot is decoded by the authenticated command that declared it.
        return prepared.map((command) => {
          const result = decodeResult(command, batched[offset++]);
          if (command.audit) decodeResult(command.audit, batched[offset++]);
          return result;
        }) as AtomicResults<Commands>;
      } catch (cause) {
        throw new AtomicBatchResultError(cause);
      }
    },
  });
}
