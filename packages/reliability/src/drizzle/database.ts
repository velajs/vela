/* oxlint-disable eslint/no-await-in-loop -- Native transaction statements must remain sequential. */
import {
  and,
  asc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
  type AnyColumn,
  type SQL,
  type SQLWrapper,
  type Table,
} from 'drizzle-orm';
import {
  ReliabilityResultError,
  type ReliabilitySession,
  type ReliabilityScope,
  type WorkKey,
  type WorkRecord,
} from '../types';
import { decodeRecord, integer, scope as validateScope } from '../validation';
import { transitionValues } from '../state';

type Row = Record<string, unknown>;
interface Query extends PromiseLike<unknown> {
  toSQL?(): { params: unknown[] };
}
interface Select extends Query {
  from(table: Table): Select;
  where(condition: SQLWrapper | undefined): Select;
  orderBy(...order: SQLWrapper[]): Select;
  limit(value: number): Select;
}
interface Mutation extends Query {
  where(condition: SQLWrapper | undefined): Mutation;
  onConflictDoNothing(): Mutation;
  returning(): Query;
}
/** One checked reflection boundary for incompatible pg/sqlite fluent overloads. */
export interface Orm {
  select(): Select;
  insert(table: Table): { values(value: Row): Mutation };
  update(table: Table): { set(value: Row): Mutation };
  delete(table: Table): Mutation;
  execute?(query: SQL): Promise<unknown>;
  all?(query: SQL): Promise<unknown>;
  transaction<T>(work: (native: unknown) => Promise<T>): Promise<T>;
}
export function orm(value: unknown): Orm {
  if (
    !value ||
    typeof value !== 'object' ||
    ['select', 'insert', 'update', 'delete', 'transaction'].some(
      (key) => typeof Reflect.get(value, key) !== 'function',
    )
  )
    throw new TypeError('Expected a native Drizzle handle');
  return value as Orm;
}
export function session(
  native: unknown,
  table: Table,
  scope: ReliabilityScope,
  dialect: 'pg' | 'sqlite',
  d1: boolean,
  autocommit = false,
): ReliabilitySession {
  const db = orm(native);
  const columns = getTableColumns(table);
  const column = (name: keyof WorkRecord): AnyColumn => {
    const value = columns[name];
    if (!value) throw new TypeError(`Missing reliability column ${name}`);
    return value;
  };
  const current =
    dialect === 'pg'
      ? sql`floor(extract(epoch from clock_timestamp()) * 1000)::bigint`
      : sql`cast((julianday('now') - 2440587.5) * 86400000 as integer)`;
  const time = (offset: number) => sql`${current} + ${offset}`;
  function checkedScope(value: ReliabilityScope) {
    const trusted = validateScope(value);
    if (trusted.tenantId !== scope.tenantId || trusted.namespace !== scope.namespace)
      throw new TypeError('Reliability store scope mismatch');
    return and(eq(column('tenantId'), scope.tenantId), eq(column('namespace'), scope.namespace));
  }
  const key = (value: WorkKey) =>
    and(checkedScope(value), eq(column('kind'), value.kind), eq(column('id'), value.id));
  const due = and(
    inArray(column('state'), ['pending', 'leased']),
    lte(column('availableAt'), current),
    or(isNull(column('leaseUntil')), lte(column('leaseUntil'), current)),
  );
  const incrementable = and(
    lt(column('revision'), Number.MAX_SAFE_INTEGER),
    lt(column('fence'), Number.MAX_SAFE_INTEGER),
  );
  async function rows(query: Query, write = false): Promise<WorkRecord[]> {
    if (d1) {
      if (!query.toSQL || query.toSQL().params.length > 100)
        throw new TypeError('D1 reliability query exceeds native parameter limits');
    }
    const result = await query;
    try {
      if (!Array.isArray(result)) throw new TypeError('Expected database rows');
      return result.map(decodeRecord);
    } catch (cause) {
      if (autocommit && write) throw new ReliabilityResultError(cause);
      throw cause;
    }
  }
  async function one(query: Query, write = false): Promise<WorkRecord | null> {
    const result = await rows(query, write);
    if (result.length > 1) throw new TypeError('Expected one reliability row');
    return result[0] ?? null;
  }
  async function now(): Promise<number> {
    const result =
      dialect === 'pg'
        ? await db.execute?.(sql`select ${current} as now`)
        : await db.all?.(sql`select ${current} as now`);
    const values: unknown =
      result && typeof result === 'object' && 'rows' in result ? result.rows : result;
    if (
      !Array.isArray(values) ||
      !values[0] ||
      typeof values[0] !== 'object' ||
      !('now' in values[0])
    )
      throw new TypeError('Database did not return authoritative time');
    const value: unknown = values[0].now;
    return integer(
      typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value,
      'database clock',
    );
  }
  const get = (selector: WorkKey) => one(db.select().from(table).where(key(selector)).limit(1));
  return {
    atomic: !autocommit,
    now,
    get,
    insert: (record) => {
      checkedScope(record);
      return one(
        db
          .insert(table)
          .values({ ...decodeRecord(record) })
          .onConflictDoNothing()
          .returning(),
        true,
      );
    },
    due: (selector, kind, limit) =>
      rows(
        db
          .select()
          .from(table)
          .where(and(checkedScope(selector), eq(column('kind'), kind), due))
          .orderBy(asc(column('availableAt')), asc(column('id')))
          .limit(limit),
      ),
    claim: (record, token, leaseMs) =>
      one(
        db
          .update(table)
          .set({
            state: 'leased',
            token,
            fence: sql`${column('fence')} + 1`,
            revision: sql`${column('revision')} + 1`,
            attempt: sql`${column('attempt')} + 1`,
            leaseUntil: time(leaseMs),
            updatedAt: current,
          })
          .where(
            and(
              key(record),
              eq(column('generation'), record.generation),
              eq(column('fingerprint'), record.fingerprint),
              eq(column('payload'), record.payload),
              due,
              lt(column('attempt'), column('maxAttempts')),
              incrementable,
            ),
          )
          .returning(),
        true,
      ),
    async transition(claim, change) {
      const record = await get(claim);
      if (!record) return null;
      const values: Row = {
        ...transitionValues(record, change, await now()),
        updatedAt: current,
        revision: sql`${column('revision')} + 1`,
      };
      if (change.state === 'leased') values.leaseUntil = time(change.leaseMs!);
      else if (values.state === 'pending') values.availableAt = time(change.delayMs!);
      else values.expiresAt = time(record.retentionMs);
      return one(
        db
          .update(table)
          .set(values)
          .where(
            and(
              key(claim),
              eq(column('generation'), claim.generation),
              eq(column('token'), claim.token),
              eq(column('fence'), claim.fence),
              eq(column('state'), 'leased'),
              gt(column('leaseUntil'), current),
              incrementable,
            ),
          )
          .returning(),
        true,
      );
    },
    async exhaust(record) {
      await rows(
        db
          .update(table)
          .set({
            state: 'failed',
            token: null,
            leaseUntil: null,
            error: 'attempts-exhausted',
            expiresAt: time(record.retentionMs),
            updatedAt: current,
            revision: sql`${column('revision')} + 1`,
          })
          .where(
            and(
              key(record),
              eq(column('generation'), record.generation),
              due,
              sql`${column('attempt')} >= ${column('maxAttempts')}`,
              incrementable,
            ),
          )
          .returning(),
        true,
      );
    },
    async edit(selector, generation, revision, action, dueAt) {
      const record = await get(selector);
      if (!record) return null;
      return one(
        db
          .update(table)
          .set({
            state: action === 'cancel' ? 'cancelled' : 'pending',
            token: null,
            leaseUntil: null,
            fence: sql`${column('fence')} + 1`,
            revision: sql`${column('revision')} + 1`,
            updatedAt: current,
            ...(action === 'cancel'
              ? { expiresAt: time(record.retentionMs) }
              : { availableAt: dueAt }),
          })
          .where(
            and(
              key(selector),
              eq(column('generation'), generation),
              eq(column('revision'), revision),
              inArray(column('state'), ['pending', 'leased']),
              incrementable,
            ),
          )
          .returning(),
        true,
      );
    },
    async prune(selector, kind, limit) {
      const expired = and(
        checkedScope(selector),
        eq(column('kind'), kind),
        inArray(column('state'), ['completed', 'failed', 'cancelled']),
        lte(column('expiresAt'), current),
      );
      const candidates = await rows(
        db
          .select()
          .from(table)
          .where(expired)
          .orderBy(asc(column('id')))
          .limit(limit),
      );
      let removed = 0;
      for (const record of candidates)
        removed += (
          await rows(
            db
              .delete(table)
              .where(and(key(record), eq(column('generation'), record.generation), expired))
              .returning(),
            true,
          )
        ).length;
      return removed;
    },
  };
}
