import { bindAdapter } from '@velajs/crud/adapter';
import type {
  AdapterCapability,
  AdapterScope,
  CascadeDriver,
  CrudAdapter,
  DeleteOptions,
  ListQuery,
  Lookup,
  NestedWriteDriver,
  NestedWriteOperations,
  Page,
  PageInfo,
  ReadOptions,
  RelationLoadScope,
  RelationLoader,
  TransactionContext,
} from '@velajs/crud/adapter';
import { ConflictException } from '@velajs/crud';
import {
  buildKeysetPage,
  compareKeysetRows,
  compareCursorValues,
  cursorValue,
  isAfterKeyset,
} from '@velajs/crud/query';
import { matchesPredicate } from '@velajs/crud/query';
import { matchesFilter } from './filter';
import { getStore } from './storage';
import type { MemoryStore } from './transactional';

/**
 * Sentinel scope for memory writes. There is no real transaction machinery:
 * throwing inside an after-hook does NOT roll back the parent write — the
 * frozen sentinel makes that explicit so downstream code can feature-detect.
 */
export const MEMORY_NOOP_TX = Object.freeze({
  __memoryNoopTx: true as const,
  rolledBack: false as const,
});

const NOOP_SCOPE: AdapterScope = Object.freeze({ tx: MEMORY_NOOP_TX });

/** A relation the adapter can traverse (nested writes, cascade, includes). */
export interface MemoryRelation {
  type: 'hasOne' | 'hasMany' | 'belongsTo';
  /** Target table name in the shared memory storage. */
  table: string;
  /** FK column: on the related table for hasOne/hasMany, on the parent for belongsTo. */
  foreignKey: string;
  /** Join column on the owning side (defaults to the primary key / 'id'). */
  localKey?: string;
}

export interface MemoryAdapterConfig {
  tableName: string;
  /** Primary key column (default 'id'). Rows are keyed by its string value. */
  primaryKey?: string;
  primaryKeys?: readonly string[];
  /** Explicit instance storage; use transactionalMemoryAdapter for rollback. */
  store?: MemoryStore;
  /** Soft-delete column, when the model soft-deletes. */
  softDeleteField?: string;
  relations?: Record<string, MemoryRelation>;
  /**
   * Unique tuples enforced natively on create/update (409 ConflictException).
   * GLOBAL scope; soft-deleted rows still occupy the slot; tuples containing
   * null/undefined never conflict (SQL semantics). Mirror the model's
   * normalized `unique`.
   */
  unique?: string[][];
}

const CAPABILITIES: ReadonlySet<AdapterCapability> = new Set([
  'structuredPredicates',
  'nestedPredicates',
  'softDelete',
  'restore',
  'cursor',
  'nestedWrites',
  'cascade',
  'uniqueConstraints',
] as const);

/**
 * In-memory `CrudAdapter` for tests, prototypes, and examples.
 *
 * Deliberately narrow capability set: no `transactions` (no-op sentinel), no
 * `databaseGeneratedId` (there is no database), no native
 * search/aggregate/upsert/bulk/batch — the engine synthesizes those from the
 * five core methods. Storage is module-level and shared across instances so
 * relations spanning tables resolve.
 */
type Row = Record<string, unknown>;
export function memoryAdapter<R extends Row>(
  config: MemoryAdapterConfig & { parseRow: (value: unknown) => R },
): CrudAdapter<R>;
export function memoryAdapter(config: MemoryAdapterConfig): CrudAdapter<Row>;
export function memoryAdapter(
  config: MemoryAdapterConfig & { parseRow?: (value: unknown) => Row },
): CrudAdapter<Row> {
  const parseRow =
    config.parseRow ??
    ((value: unknown): Row => {
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error('Invalid stored row');
      return Object.fromEntries(Object.entries(value));
    });
  const keys = config.primaryKeys ?? [config.primaryKey ?? 'id'];
  const primaryKey = keys[0] ?? 'id';
  const identity = (row: Row) =>
    keys.length === 1
      ? String(row[primaryKey])
      : JSON.stringify(keys.map((key) => String(row[key])));
  const storageTable = (name: string) => (config.store ? config.store.table(name) : getStore(name));
  const table = () => storageTable(config.tableName);

  const isSoftDeleted = (row: Record<string, unknown>): boolean =>
    config.softDeleteField !== undefined && row[config.softDeleteField] != null;

  const matchesLookup = (row: Record<string, unknown>, lookup: Lookup): boolean => {
    if (String(row[lookup.field]) !== lookup.value) return false;
    for (const [field, value] of Object.entries(lookup.filters ?? {})) {
      if (String(row[field]) !== value) return false;
    }
    return !lookup.predicate || matchesPredicate(row, lookup.predicate);
  };

  /** Point lookup honoring the PK fast path, extra filters, and visibility. */
  const findOne = (lookup: Lookup, withDeleted: boolean): Row | null => {
    const store = table();
    const candidates =
      lookup.field === primaryKey && keys.length === 1
        ? store.has(lookup.value)
          ? [store.get(lookup.value)!]
          : []
        : Array.from(store.values());
    for (const row of candidates) {
      if (!matchesLookup(row, lookup)) continue;
      if (!withDeleted && isSoftDeleted(row)) return null;
      return parseRow(row);
    }
    return null;
  };

  const nested: NestedWriteDriver<Row> = {
    async inspectNestedTargets(parent, relation, operations, _scope) {
      const rel = requireRelation(config, relation);
      const relatedStore = storageTable(rel.table);
      const parentKey = parent[rel.localKey ?? primaryKey];
      const find = (where: Record<string, unknown>, mustBelongToParent: boolean): Row | null => {
        for (const row of relatedStore.values()) {
          if (
            !rowMatches(row, where) ||
            !rowMatches(row, operations.targetScope ?? {}) ||
            (operations.targetPredicate && !matchesPredicate(row, operations.targetPredicate))
          )
            continue;
          if (mustBelongToParent && row[rel.foreignKey] !== parentKey) continue;
          return { ...row };
        }
        return null;
      };
      return {
        update: (operations.update ?? []).map(({ where }) => find(where, true)),
        delete: (operations.delete ?? []).map((where) => find(where, true)),
        connect: (operations.connect ?? []).map((where) => find(where, false)),
        disconnect: (operations.disconnect ?? []).map((where) => find(where, true)),
        setConnect: (operations.set ?? []).map((where) => find(where, false)),
        // Deliberately do not apply targetScope here: the engine must see and
        // reject an already-linked foreign-tenant row before mass-detaching.
        setDisconnect:
          operations.set === undefined
            ? []
            : Array.from(relatedStore.values())
                .filter((row) => row[rel.foreignKey] === parentKey)
                .map((row) => ({ ...row })),
      };
    },
    async createNested(parent, relation, records, _scope) {
      const rel = requireRelation(config, relation);
      const relatedStore = storageTable(rel.table);
      const parentKey = parent[rel.localKey ?? primaryKey];
      for (const record of records) {
        const row = {
          ...record,
          id: record.id ?? crypto.randomUUID(),
          [rel.foreignKey]: parentKey,
        };
        relatedStore.set(String(row.id), row);
      }
    },
    async applyNested(parent, relation, operations: NestedWriteOperations, _scope) {
      const rel = requireRelation(config, relation);
      const relatedStore = storageTable(rel.table);
      const parentKey = parent[rel.localKey ?? primaryKey];
      const scopedMatch = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
        rowMatches(row, where) &&
        rowMatches(row, operations.targetScope ?? {}) &&
        (!operations.targetPredicate || matchesPredicate(row, operations.targetPredicate));

      for (const record of operations.create ?? []) {
        const row = {
          ...record,
          id: record.id ?? crypto.randomUUID(),
          [rel.foreignKey]: parentKey,
        };
        relatedStore.set(String(row.id), row);
      }
      for (const { where, data } of operations.update ?? []) {
        for (const [id, row] of relatedStore) {
          if (scopedMatch(row, where) && row[rel.foreignKey] === parentKey) {
            relatedStore.set(id, { ...row, ...data });
          }
        }
      }
      for (const where of operations.delete ?? []) {
        for (const [id, row] of relatedStore) {
          if (scopedMatch(row, where) && row[rel.foreignKey] === parentKey) relatedStore.delete(id);
        }
      }
      for (const where of operations.connect ?? []) {
        for (const [id, row] of relatedStore) {
          if (scopedMatch(row, where))
            relatedStore.set(id, { ...row, [rel.foreignKey]: parentKey });
        }
      }
      for (const where of operations.disconnect ?? []) {
        for (const [id, row] of relatedStore) {
          if (scopedMatch(row, where) && row[rel.foreignKey] === parentKey) {
            relatedStore.set(id, { ...row, [rel.foreignKey]: null });
          }
        }
      }
      if (operations.set) {
        // set = disconnect everything, then connect the listed records.
        for (const [id, row] of relatedStore) {
          if (row[rel.foreignKey] === parentKey && scopedMatch(row, {})) {
            relatedStore.set(id, { ...row, [rel.foreignKey]: null });
          }
        }
        for (const where of operations.set) {
          for (const [id, row] of relatedStore) {
            if (scopedMatch(row, where))
              relatedStore.set(id, { ...row, [rel.foreignKey]: parentKey });
          }
        }
      }
    },
  };

  const cascade: CascadeDriver = {
    async countRelated(relation, parentKey, _scope) {
      const rel = requireRelation(config, relation);
      return relatedRows(rel, parentKey, storageTable(rel.table)).length;
    },
    async deleteRelated(relation, parentKey, _scope) {
      const rel = requireRelation(config, relation);
      const store = storageTable(rel.table);
      let count = 0;
      for (const [id, row] of store) {
        if (row[rel.foreignKey] === parentKey) {
          store.delete(id);
          count++;
        }
      }
      return count;
    },
    async nullifyRelated(relation, parentKey, _scope) {
      const rel = requireRelation(config, relation);
      const store = storageTable(rel.table);
      let count = 0;
      for (const [id, row] of store) {
        if (row[rel.foreignKey] === parentKey) {
          store.set(id, { ...row, [rel.foreignKey]: null });
          count++;
        }
      }
      return count;
    },
  };

  const relations: RelationLoader<Row> = {
    async load(rows, relation, loadScope: RelationLoadScope, _scope) {
      const rel = requireRelation(config, relation);
      const store = storageTable(rel.table);
      // Join value on the RELATED side: FK column for hasOne/hasMany, the
      // target key for belongsTo (parent rows carry the FK).
      const relatedJoinField = rel.type === 'belongsTo' ? (rel.localKey ?? 'id') : rel.foreignKey;
      const parentJoinField =
        rel.type === 'belongsTo' ? rel.foreignKey : (rel.localKey ?? primaryKey);
      const wanted = new Set(rows.map((r) => r[parentJoinField]));

      const grouped = new Map<unknown, Array<Record<string, unknown>>>();
      for (const row of store.values()) {
        if (loadScope.predicate && !matchesPredicate(row, loadScope.predicate)) continue;
        const key = row[relatedJoinField];
        if (!wanted.has(key)) continue;
        if (
          loadScope.tenantField != null &&
          loadScope.tenantValue != null &&
          row[loadScope.tenantField] !== loadScope.tenantValue
        ) {
          continue;
        }
        if (loadScope.excludeDeletedField != null && row[loadScope.excludeDeletedField] != null) {
          continue;
        }
        const bucket = grouped.get(key);
        if (bucket) bucket.push(row);
        else grouped.set(key, [row]);
      }
      return grouped;
    },
  };

  const uniqueTuples = config.unique ?? [];
  /**
   * First violated unique tuple, or undefined. SQL semantics: tuples with a
   * null/undefined value (on either side) never conflict; soft-deleted rows
   * occupy the slot.
   */
  const violatedUnique = (candidate: Row, excludeKey?: string): string[] | undefined => {
    for (const tuple of uniqueTuples) {
      const values = tuple.map((column) => candidate[column]);
      if (values.some((value) => value === null || value === undefined)) continue;
      for (const [key, row] of table()) {
        if (excludeKey !== undefined && key === excludeKey) continue;
        const collides = tuple.every((column, i) => {
          const rowValue = row[column];
          if (rowValue === null || rowValue === undefined) return false;
          return String(rowValue) === String(values[i]);
        });
        if (collides) return tuple;
      }
    }
    return undefined;
  };

  // Loud, never silent: the capability is declared ONLY when this instance
  // actually enforces tuples — a model with `unique` paired with an
  // unmirrored memory adapter fails assertAdapterSatisfies at define time
  // instead of silently enforcing nothing.
  const capabilities: ReadonlySet<AdapterCapability> =
    uniqueTuples.length > 0
      ? CAPABILITIES
      : new Set([...CAPABILITIES].filter((cap) => cap !== 'uniqueConstraints'));

  return bindAdapter({
    capabilities,

    async requestScope(fn) {
      return fn(NOOP_SCOPE);
    },

    async transaction<T>(
      fn: (scope: AdapterScope) => Promise<T>,
      _ctx?: TransactionContext,
    ): Promise<T> {
      return fn(NOOP_SCOPE);
    },

    async create(input, _scope) {
      const row = parseRow({ ...input });
      const id = identity(row);
      // A duplicate PK must never silently overwrite (reachable since
      // id:'client' hands PK generation to the caller) — conflict like a
      // database unique constraint would.
      if (table().has(id)) {
        throw new ConflictException(
          `Duplicate primary key '${id}': a row with this key already exists`,
        );
      }
      const violated = violatedUnique(row);
      if (violated) {
        throw new ConflictException(`Unique constraint violated on (${violated.join(', ')})`);
      }
      table().set(id, row);
      return row;
    },

    async readOne(lookup, opts: ReadOptions, _scope) {
      return findOne(lookup, opts.withDeleted ?? false);
    },

    async update(lookup, patch, _scope) {
      const existing = findOne(lookup, false);
      if (!existing) return null;
      const updated = parseRow({ ...existing, ...patch });
      const existingKey = identity(existing);
      const violated = violatedUnique(updated, existingKey);
      if (violated) {
        throw new ConflictException(`Unique constraint violated on (${violated.join(', ')})`);
      }
      table().set(existingKey, updated);
      return updated;
    },

    async delete(lookup, opts: DeleteOptions, _scope) {
      const existing = findOne(lookup, false);
      if (!existing) return null;
      const store = table();
      const id = identity(existing);
      if (opts.softDeleteField !== undefined) {
        const stamped = parseRow({ ...existing, [opts.softDeleteField]: Date.now() });
        store.set(id, stamped);
        return stamped;
      }
      store.delete(id);
      return existing;
    },

    async restore(lookup, _scope): Promise<Row | null> {
      // MemoryRestoreEndpoint parity: find the row INCLUDING soft-deleted ones
      // (honoring lookup.filters for tenant scope), refuse if there is nothing
      // to restore (missing, or a live row that is not soft-deleted), else clear
      // the soft-delete field and persist the restored row.
      const field = config.softDeleteField;
      if (field === undefined) return null;
      const existing = findOne(lookup, true);
      if (!existing || !isSoftDeleted(existing)) return null;
      const restored = parseRow({ ...existing, [field]: null });
      table().set(identity(existing), restored);
      return restored;
    },

    async list(query: ListQuery, _scope): Promise<Page<Row>> {
      const items = runQuery(table(), query, config.softDeleteField);
      const totalCount = items.length;
      const { options } = query;

      if (options.cursor !== undefined || (options.limit !== undefined && !options.keyset))
        throw new Error('Adapter cursors must be decoded by the engine');
      if (options.keyset) {
        const keyset = options.keyset;
        const window = items
          .sort((a, b) => compareKeysetRows(keyset, a, b))
          .filter((row) => isAfterKeyset(keyset, row));
        return buildKeysetPage(
          options.limit ?? options.per_page ?? 20,
          window.map(parseRow),
          keyset,
          totalCount,
        );
      }

      // Offset pagination (default).
      const page = options.page ?? 1;
      const perPage = options.per_page ?? 20;
      const start = (page - 1) * perPage;
      const pageItems = items.slice(start, start + perPage).map(parseRow);
      const totalPages = Math.ceil(totalCount / perPage);
      const info: PageInfo = {
        page,
        per_page: perPage,
        total_count: totalCount,
        total_pages: totalPages,
        has_next_page: page < totalPages,
        has_prev_page: page > 1,
      };
      return { result: pageItems, result_info: info };
    },

    nested,
    cascade,
    relations,
  });
}

function requireRelation(config: MemoryAdapterConfig, relation: string): MemoryRelation {
  const rel = config.relations?.[relation];
  if (!rel) {
    throw new Error(
      `memoryAdapter('${config.tableName}'): unknown relation '${relation}' — declare it in config.relations`,
    );
  }
  return rel;
}

function relatedRows(
  rel: MemoryRelation,
  parentKey: unknown,
  store: Map<string, Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const row of store.values()) {
    if (row[rel.foreignKey] === parentKey) rows.push(row);
  }
  return rows;
}

function rowMatches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => String(row[k]) === String(v));
}

/**
 * The shared list-query block: soft-delete visibility, filter loop, inline
 * `?search=` literal needle, and sorting. Pagination stays with the caller.
 */
function runQuery(
  store: Map<string, Record<string, unknown>>,
  query: ListQuery,
  softDeleteField: string | undefined,
): Array<Record<string, unknown>> {
  let items = Array.from(store.values());
  const { options } = query;

  if (softDeleteField !== undefined) {
    if (options.onlyDeleted) {
      items = items.filter((item) => item[softDeleteField] != null);
    } else if (!options.withDeleted) {
      items = items.filter((item) => item[softDeleteField] == null);
    }
  }

  for (const filter of query.filters) {
    items = items.filter((item) =>
      matchesFilter(filter.operator === 'predicate' ? item : item[filter.field], filter),
    );
  }

  // Inline search: literal substring, case-insensitive (the like/ilike
  // contract — `%`/`_` are inert characters, never wildcards).
  if (options.search && options.searchFields && options.searchFields.length > 0) {
    const needle = options.search.toLowerCase();
    const fields = options.searchFields;
    items = items.filter((item) =>
      fields.some((field) => String(item[field]).toLowerCase().includes(needle)),
    );
  }

  if (options.order_by) {
    const orderBy = options.order_by;
    const direction = options.order_by_direction === 'desc' ? -1 : 1;
    items.sort((a, b) => {
      return (
        direction *
        compareCursorValues(cursorValue(a[orderBy] ?? null), cursorValue(b[orderBy] ?? null))
      );
    });
  }

  return items;
}
