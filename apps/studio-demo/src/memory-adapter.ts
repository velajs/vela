/**
 * A tiny in-memory `CrudAdapter` — the demo's BYO datastore.
 *
 * The demo authors a compact in-memory adapter over a shared
 * multi-table `MemoryDb`. It implements the full read/write contract the Studio
 * data browser + time-travel exercise, and advertises the optional capabilities
 * (`aggregate`/`nativeSearch`/`cascade`) each model opts into so Studio's honest
 * capability degradation is demonstrated end-to-end.
 */
import type {
  AdapterCapability,
  AdapterScope,
  AggregateResult,
  AggregateSpec,
  CrudAdapter,
  DeleteOptions,
  FilterCondition,
  FilterOperator,
  ListQuery,
  Lookup,
  Page,
  ReadOptions,
  SearchHit,
  SearchQuery,
} from '@velajs/crud/adapter';
import type { Model } from '@velajs/crud/model';
import { bindAdapter } from '@velajs/crud/adapter';

/** One untyped row image. */
export type Row = Record<string, unknown>;

/** A minimal multi-table in-memory "database" shared by the per-model adapters. */
export class MemoryDb {
  readonly tables = new Map<string, Map<string, Row>>();
  #pending = Promise.resolve();

  /** Serialize adapter scopes; transactions restore every table on failure. */
  async scoped<T>(fn: (scope: AdapterScope) => Promise<T>, rollback: boolean): Promise<T> {
    const previous = this.#pending;
    let release = () => {};
    this.#pending = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    let snapshot: Map<string, Map<string, Row>> | undefined;
    try {
      snapshot = rollback ? structuredClone(this.tables) : undefined;
      return await fn({ tx: null });
    } catch (error) {
      if (snapshot !== undefined) {
        for (const [name, table] of this.tables) {
          table.clear();
          for (const [id, row] of snapshot.get(name) ?? []) table.set(id, row);
        }
      }
      throw error;
    } finally {
      release();
    }
  }

  table(name: string): Map<string, Row> {
    let t = this.tables.get(name);
    if (t === undefined) {
      t = new Map<string, Row>();
      this.tables.set(name, t);
    }
    return t;
  }

  seed(name: string, rows: Row[]): void {
    const t = this.table(name);
    for (const row of rows) t.set(String(row.id), { ...row });
  }
}

const s = (v: unknown): string => (v == null ? '' : String(v));

function matchFilter(value: unknown, operator: FilterOperator, needle: unknown): boolean {
  switch (operator) {
    case 'eq':
      return s(value) === s(needle);
    case 'ne':
      return s(value) !== s(needle);
    case 'in':
      return Array.isArray(needle) && needle.map(s).includes(s(value));
    case 'nin':
      return Array.isArray(needle) && !needle.map(s).includes(s(value));
    case 'like':
      return s(value).includes(s(needle));
    case 'ilike':
      return s(value).toLowerCase().includes(s(needle).toLowerCase());
    case 'gt':
      return Number(value) > Number(needle);
    case 'gte':
      return Number(value) >= Number(needle);
    case 'lt':
      return Number(value) < Number(needle);
    case 'lte':
      return Number(value) <= Number(needle);
    case 'null':
      return needle === true || needle === 'true' ? value == null : value != null;
    case 'between':
      return (
        Array.isArray(needle) &&
        Number(value) >= Number(needle[0]) &&
        Number(value) <= Number(needle[1])
      );
    default:
      return true;
  }
}

/** A read/write in-memory adapter bound to a model's table, with opt-in capabilities. */
export function memoryAdapter(
  model: Model,
  db: MemoryDb,
  caps: AdapterCapability[] = [],
): CrudAdapter<Row> {
  const store = db.table(model.tableName);
  const sd = model.softDeleteField;
  const scope: AdapterScope = { tx: null };
  const capabilities = new Set<AdapterCapability>(['transactions', ...caps]);

  const applyFilters = (rows: Row[], filters: FilterCondition[]): Row[] =>
    filters.reduce((acc, f) => acc.filter((r) => matchFilter(r[f.field], f.operator, f.value)), rows);
  const visibleLive = (rows: Row[]): Row[] =>
    sd === undefined ? rows : rows.filter((r) => r[sd] == null);

  const adapter = bindAdapter({
    capabilities,
    requestScope<T>(fn: (s: AdapterScope) => Promise<T>): Promise<T> {
      return db.scoped(fn, false);
    },
    async transaction<T>(fn: (s: AdapterScope) => Promise<T>): Promise<T> {
      return db.scoped(fn, true);
    },
    async create(input: Partial<Row>): Promise<Row> {
      const row = { ...input };
      store.set(String(row.id), row);
      return row;
    },
    async readOne(lookup: Lookup, opts: ReadOptions): Promise<Row | null> {
      for (const row of store.values()) {
        if (String(row[lookup.field]) !== lookup.value) continue;
        let matched = true;
        for (const [k, v] of Object.entries(lookup.filters ?? {})) {
          if (String(row[k]) !== v) matched = false;
        }
        if (!matched) return null;
        if (opts.withDeleted !== true && sd !== undefined && row[sd] != null) return null;
        return row;
      }
      return null;
    },
    async update(lookup: Lookup, patch: Partial<Row>): Promise<Row | null> {
      const existing = await adapter.readOne(lookup, { withDeleted: true }, scope);
      if (existing === null) return null;
      const updated = { ...existing, ...patch };
      store.set(String(existing.id), updated);
      return updated;
    },
    async delete(lookup: Lookup, opts: DeleteOptions): Promise<Row | null> {
      const existing = await adapter.readOne(lookup, { withDeleted: true }, scope);
      if (existing === null) return null;
      if (opts.softDeleteField !== undefined) {
        const stamped = { ...existing, [opts.softDeleteField]: Date.now() };
        store.set(String(existing.id), stamped);
        return stamped;
      }
      store.delete(String(existing.id));
      return existing;
    },
    async list(query: ListQuery): Promise<Page<Row>> {
      let rows = [...store.values()];
      if (sd !== undefined) {
        if (query.options.onlyDeleted) rows = rows.filter((r) => r[sd] != null);
        else if (query.options.withDeleted !== true) rows = rows.filter((r) => r[sd] == null);
      }
      rows = applyFilters(rows, query.filters);
      if (query.options.order_by !== undefined) {
        const field = query.options.order_by;
        const dir = query.options.order_by_direction === 'desc' ? -1 : 1;
        rows.sort((a, b) => (String(a[field]) < String(b[field]) ? -dir : dir));
      }
      const page = query.options.page ?? 1;
      const perPage = query.options.per_page ?? 20;
      const total = rows.length;
      const slice = rows.slice((page - 1) * perPage, page * perPage);
      return {
        result: slice,
        result_info: {
          page,
          per_page: perPage,
          total_count: total,
          total_pages: Math.ceil(total / perPage),
          has_next_page: page * perPage < total,
          has_prev_page: page > 1,
        },
      };
    },
  });

  if (capabilities.has('aggregate')) {
    adapter.aggregate = async (spec: AggregateSpec): Promise<AggregateResult> => {
      const field = spec.groupBy?.[0];
      if (field === undefined) return { values: { count: store.size } };
      const rows = applyFilters(visibleLive([...store.values()]), spec.filters);
      const counts = new Map<unknown, number>();
      for (const row of rows) counts.set(row[field], (counts.get(row[field]) ?? 0) + 1);
      let groups = [...counts.entries()].map(([value, count]) => ({
        key: { [field]: value },
        values: { count },
      }));
      groups.sort((a, b) => b.values.count - a.values.count);
      const total = groups.length;
      if (spec.limit !== undefined) groups = groups.slice(0, spec.limit);
      return { groups, totalGroups: total };
    };
  }

  if (capabilities.has('nativeSearch')) {
    adapter.search = async (spec: SearchQuery): Promise<Array<SearchHit<Row>>> => {
      const term = spec.term.toLowerCase();
      const fields = spec.fields.map((f) => f.field);
      const rows = applyFilters(visibleLive([...store.values()]), spec.filters).filter((r) =>
        fields.some((f) =>
          String(r[f] ?? '')
            .toLowerCase()
            .includes(term),
        ),
      );
      const page = spec.options.page ?? 1;
      const per = spec.options.per_page ?? 20;
      return rows.slice((page - 1) * per, page * per).map((record) => ({ record, score: 1 }));
    };
  }

  if (capabilities.has('cascade')) {
    const countRelated = async (relation: string, parentKey: unknown): Promise<number> => {
      const rel = model.relations?.[relation];
      if (rel === undefined) return 0;
      const childStore = db.table(rel.target ?? '');
      let n = 0;
      for (const row of childStore.values()) {
        if (String(row[rel.foreignKey]) !== String(parentKey)) continue;
        if (row.deletedAt != null) continue; // skip tombstoned children
        n++;
      }
      return n;
    };
    adapter.cascade = {
      countRelated,
      async deleteRelated(relation, parentKey) {
        return countRelated(relation, parentKey);
      },
      async nullifyRelated(relation, parentKey) {
        return countRelated(relation, parentKey);
      },
    };
  }

  return adapter;
}
