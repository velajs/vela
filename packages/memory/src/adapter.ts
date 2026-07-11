import type {
  AdapterCapability,
  AdapterScope,
  CascadeDriver,
  CrudAdapter,
  DeleteOptions,
  FilterCondition,
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
import { decodeCursor, encodeCursor } from '@velajs/crud/query';
import { matchesFilter } from './filter';
import { getStore } from './storage';

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
export function memoryAdapter<Row extends Record<string, unknown> = Record<string, unknown>>(
  config: MemoryAdapterConfig,
): CrudAdapter<Row> {
  const primaryKey = config.primaryKey ?? 'id';
  const table = () => getStore(config.tableName);

  const isSoftDeleted = (row: Record<string, unknown>): boolean =>
    config.softDeleteField !== undefined && row[config.softDeleteField] != null;

  const matchesLookup = (row: Record<string, unknown>, lookup: Lookup): boolean => {
    if (String(row[lookup.field]) !== lookup.value) return false;
    for (const [field, value] of Object.entries(lookup.filters ?? {})) {
      if (String(row[field]) !== value) return false;
    }
    return true;
  };

  /** Point lookup honoring the PK fast path, extra filters, and visibility. */
  const findOne = (lookup: Lookup, withDeleted: boolean): Row | null => {
    const store = table();
    const candidates =
      lookup.field === primaryKey
        ? ([store.get(lookup.value)].filter(Boolean) as Array<Record<string, unknown>>)
        : Array.from(store.values());
    for (const row of candidates) {
      if (!matchesLookup(row, lookup)) continue;
      if (!withDeleted && isSoftDeleted(row)) return null;
      return row as Row;
    }
    return null;
  };

  const nested: NestedWriteDriver<Row> = {
    async createNested(parent, relation, records, _scope) {
      const rel = requireRelation(config, relation);
      const relatedStore = getStore(rel.table);
      const parentKey = (parent as Record<string, unknown>)[rel.localKey ?? primaryKey];
      for (const record of records) {
        const row = { ...record, id: record.id ?? crypto.randomUUID(), [rel.foreignKey]: parentKey };
        relatedStore.set(String(row.id), row);
      }
    },
    async applyNested(parent, relation, operations: NestedWriteOperations, _scope) {
      const rel = requireRelation(config, relation);
      const relatedStore = getStore(rel.table);
      const parentKey = (parent as Record<string, unknown>)[rel.localKey ?? primaryKey];

      for (const record of operations.create ?? []) {
        const row = { ...record, id: record.id ?? crypto.randomUUID(), [rel.foreignKey]: parentKey };
        relatedStore.set(String(row.id), row);
      }
      for (const { where, data } of operations.update ?? []) {
        for (const [id, row] of relatedStore) {
          if (rowMatches(row, where) && row[rel.foreignKey] === parentKey) {
            relatedStore.set(id, { ...row, ...data });
          }
        }
      }
      for (const where of operations.delete ?? []) {
        for (const [id, row] of relatedStore) {
          if (rowMatches(row, where) && row[rel.foreignKey] === parentKey) relatedStore.delete(id);
        }
      }
      for (const where of operations.connect ?? []) {
        for (const [id, row] of relatedStore) {
          if (rowMatches(row, where)) relatedStore.set(id, { ...row, [rel.foreignKey]: parentKey });
        }
      }
      for (const where of operations.disconnect ?? []) {
        for (const [id, row] of relatedStore) {
          if (rowMatches(row, where) && row[rel.foreignKey] === parentKey) {
            relatedStore.set(id, { ...row, [rel.foreignKey]: null });
          }
        }
      }
      if (operations.set) {
        // set = disconnect everything, then connect the listed records.
        for (const [id, row] of relatedStore) {
          if (row[rel.foreignKey] === parentKey) {
            relatedStore.set(id, { ...row, [rel.foreignKey]: null });
          }
        }
        for (const where of operations.set) {
          for (const [id, row] of relatedStore) {
            if (rowMatches(row, where)) relatedStore.set(id, { ...row, [rel.foreignKey]: parentKey });
          }
        }
      }
    },
  };

  const cascade: CascadeDriver = {
    async countRelated(relation, parentKey, _scope) {
      const rel = requireRelation(config, relation);
      return relatedRows(rel, parentKey).length;
    },
    async deleteRelated(relation, parentKey, _scope) {
      const rel = requireRelation(config, relation);
      const store = getStore(rel.table);
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
      const store = getStore(rel.table);
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
      const store = getStore(rel.table);
      // Join value on the RELATED side: FK column for hasOne/hasMany, the
      // target key for belongsTo (parent rows carry the FK).
      const relatedJoinField = rel.type === 'belongsTo' ? (rel.localKey ?? 'id') : rel.foreignKey;
      const parentJoinField = rel.type === 'belongsTo' ? rel.foreignKey : (rel.localKey ?? primaryKey);
      const wanted = new Set(rows.map((r) => (r as Record<string, unknown>)[parentJoinField]));

      const grouped = new Map<unknown, Array<Record<string, unknown>>>();
      for (const row of store.values()) {
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
          const rowValue = (row as Row)[column];
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

  return {
    capabilities,

    async transaction<T>(fn: (scope: AdapterScope) => Promise<T>, _ctx?: TransactionContext): Promise<T> {
      return fn(NOOP_SCOPE);
    },

    async create(input, _scope) {
      const row = { ...input } as Row;
      const id = String((row as Record<string, unknown>)[primaryKey]);
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
      const updated = { ...existing, ...patch } as Row;
      const existingKey = String((existing as Record<string, unknown>)[primaryKey]);
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
      const id = String((existing as Record<string, unknown>)[primaryKey]);
      if (opts.softDeleteField !== undefined) {
        const stamped = { ...existing, [opts.softDeleteField]: Date.now() } as Row;
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
      const restored = { ...existing, [field]: null } as Row;
      table().set(String((existing as Record<string, unknown>)[primaryKey]), restored);
      return restored;
    },

    async list(query: ListQuery, _scope): Promise<Page<Row>> {
      const items = runQuery(table(), query, config.softDeleteField);
      const totalCount = items.length;
      const { options } = query;

      // Keyset cursor pagination (next-only): strictly-after-the-boundary
      // window, tolerant of a deleted boundary row. An invalid cursor starts
      // from the beginning (SQL adapter parity). Rows are already ordered by
      // the cursor field ascending — the engine forces order_by on a walk.
      if (options.cursor !== undefined || options.limit !== undefined) {
        const cursorField = options.order_by ?? primaryKey;
        const limit = options.limit ?? options.per_page ?? 20;
        // The engine validates cursors loudly at parse time; if a malformed
        // one still reaches the adapter, start from the beginning (SQL
        // adapter parity) instead of crashing mid-walk.
        let decoded: string | null = null;
        if (options.cursor !== undefined) {
          try {
            decoded = decodeCursor(options.cursor);
          } catch {
            decoded = null;
          }
        }

        const window =
          decoded === null
            ? items
            : items.filter((item) => {
                const value = (item as Record<string, unknown>)[cursorField];
                return typeof value === 'number' ? value > Number(decoded) : String(value) > String(decoded);
              });

        const pageItems = window.slice(0, limit) as Row[];
        const hasNext = window.length > limit;
        const last = pageItems[pageItems.length - 1] as Record<string, unknown> | undefined;
        const info: PageInfo = {
          // Next-only cursor walks have no page number (Stripe-style): the
          // engine's buildCursorPageInfo pins page 0, and adapters must agree.
          page: 0,
          per_page: limit,
          total_count: totalCount,
          has_next_page: hasNext,
          has_prev_page: decoded !== null,
          ...(hasNext && last !== undefined
            ? { next_cursor: encodeCursor(String(last[cursorField])) }
            : {}),
        };
        return { result: pageItems, result_info: info };
      }

      // Offset pagination (default).
      const page = options.page ?? 1;
      const perPage = options.per_page ?? 20;
      const start = (page - 1) * perPage;
      const pageItems = items.slice(start, start + perPage) as Row[];
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
  };
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

function relatedRows(rel: MemoryRelation, parentKey: unknown): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const row of getStore(rel.table).values()) {
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

  for (const filter of query.filters as FilterCondition[]) {
    items = items.filter((item) => matchesFilter(item[filter.field], filter));
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
      const aVal = a[orderBy] as string | number;
      const bVal = b[orderBy] as string | number;
      if (aVal < bVal) return -1 * direction;
      if (aVal > bVal) return 1 * direction;
      return 0;
    });
  }

  return items;
}
