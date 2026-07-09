import type { AdapterScope, CrudAdapter } from '../adapter/contract';
import type { ListQuery, Lookup, Page } from '../adapter/query-types';

type Row = Record<string, unknown>;

/**
 * Self-contained in-test adapter (a Map with eq-filter/soft-delete/offset
 * semantics). Core's own tests can't use @velajs/crud-memory — that package
 * depends on core — so integration suites carry this mini adapter instead.
 */
export function testAdapter(
  store: Map<string, Row>,
  softDeleteField?: string,
): CrudAdapter<Row> {
  const scope: AdapterScope = { tx: { test: true } };
  const visible = (row: Row, withDeleted: boolean) =>
    withDeleted || softDeleteField === undefined || row[softDeleteField] == null;

  const find = (lookup: Lookup, withDeleted: boolean): Row | null => {
    for (const row of store.values()) {
      if (String(row[lookup.field]) !== lookup.value) continue;
      for (const [k, v] of Object.entries(lookup.filters ?? {})) {
        if (String(row[k]) !== v) return null;
      }
      return visible(row, withDeleted) ? row : null;
    }
    return null;
  };

  return {
    capabilities: new Set(softDeleteField !== undefined ? (['softDelete'] as const) : []),
    async transaction(fn) {
      return fn(scope);
    },
    async create(input) {
      const row = { ...input } as Row;
      store.set(String(row.id), row);
      return row;
    },
    async readOne(lookup, opts) {
      return find(lookup, opts.withDeleted ?? false);
    },
    async update(lookup, patch) {
      const existing = find(lookup, false);
      if (!existing) return null;
      const updated = { ...existing, ...patch };
      store.set(String(existing.id), updated);
      return updated;
    },
    async delete(lookup, opts) {
      const existing = find(lookup, false);
      if (!existing) return null;
      if (opts.softDeleteField !== undefined) {
        const stamped = { ...existing, [opts.softDeleteField]: Date.now() };
        store.set(String(existing.id), stamped);
        return stamped;
      }
      store.delete(String(existing.id));
      return existing;
    },
    async list(query: ListQuery): Promise<Page<Row>> {
      let rows = Array.from(store.values());
      if (softDeleteField !== undefined) {
        if (query.options.onlyDeleted) rows = rows.filter((r) => r[softDeleteField] != null);
        else if (!query.options.withDeleted) rows = rows.filter((r) => r[softDeleteField] == null);
      }
      for (const f of query.filters) {
        rows = rows.filter((r) => String(r[f.field]) === String(f.value));
      }
      if (query.options.order_by) {
        const field = query.options.order_by;
        const dir = query.options.order_by_direction === 'desc' ? -1 : 1;
        rows.sort((a, b) => (String(a[field]) < String(b[field]) ? -dir : dir));
      }
      const page = query.options.page ?? 1;
      const perPage = query.options.per_page ?? 20;
      const slice = rows.slice((page - 1) * perPage, page * perPage);
      return {
        result: slice,
        result_info: {
          page,
          per_page: perPage,
          total_count: rows.length,
          total_pages: Math.ceil(rows.length / perPage),
          has_next_page: page * perPage < rows.length,
          has_prev_page: page > 1,
        },
      };
    },
  };
}
