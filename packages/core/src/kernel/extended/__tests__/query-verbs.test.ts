import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AdapterCapability, AdapterScope, CrudAdapter } from '../../../adapter/contract';
import type {
  AggregateResult,
  AggregateSpec,
  ListQuery,
  Page,
  SearchHit,
  SearchQuery,
} from '../../../adapter/query-types';
import { matchesFilter } from '../../../query/filters';
import { runSearchFallback } from '../../../query/search';
import { computeAggregateFallback } from '../../../query/aggregate';
import { parseCsv } from '../../../csv/index';
import { defineModel } from '../../../model/define-model';
import { defineResource } from '../../resource';
import type { EngineRequest } from '../../engine-request';
import type { ModelPolicies } from '../../../policies/types';

type Row = Record<string, unknown>;

interface FakeOptions {
  softDeleteField?: string;
  /** Declare + implement native `search` (nativeSearch capability). */
  nativeSearch?: boolean;
  /** Declare + implement native `aggregate` (aggregate capability). */
  nativeAggregate?: boolean;
}

/**
 * In-test adapter over a Map — extends the extended-verb sibling's fake with the
 * `search` + `aggregate` capability methods this family exercises. Both native
 * methods just reuse the engine fallbacks over the filtered store, wrapped so a
 * spy can assert the native path was taken.
 */
function fakeAdapter(store: Map<string, Row>, opts: FakeOptions = {}) {
  const softDeleteField = opts.softDeleteField;
  const scopeSentinel: AdapterScope = { tx: { fake: true } };

  const visibleRows = (withDeleted: boolean, onlyDeleted: boolean): Row[] => {
    let rows = Array.from(store.values());
    if (softDeleteField !== undefined) {
      if (onlyDeleted) rows = rows.filter((r) => r[softDeleteField] != null);
      else if (!withDeleted) rows = rows.filter((r) => r[softDeleteField] == null);
    }
    return rows;
  };

  const applyFilters = (rows: Row[], query: ListQuery): Row[] => {
    let out = rows;
    for (const f of query.filters) out = out.filter((r) => matchesFilter(r[f.field], f));
    return out;
  };

  const caps: AdapterCapability[] = [];
  if (softDeleteField !== undefined) caps.push('softDelete', 'restore');
  if (opts.nativeSearch) caps.push('nativeSearch');
  if (opts.nativeAggregate) caps.push('aggregate');

  const search = vi.fn(async (spec: SearchQuery): Promise<Array<SearchHit<Row>>> => {
    const rows = applyFilters(visibleRows(spec.options.withDeleted ?? false, false), {
      filters: spec.filters,
      options: {},
    });
    return runSearchFallback(rows, spec);
  });

  const aggregate = vi.fn(async (spec: AggregateSpec): Promise<AggregateResult> => {
    const rows = applyFilters(visibleRows(false, false), { filters: spec.filters, options: {} });
    return computeAggregateFallback(rows, spec);
  });

  const adapter: CrudAdapter<Row> = {
    capabilities: new Set(caps),
    async transaction(fn) {
      return fn(scopeSentinel);
    },
    async create(input) {
      const row = { ...input } as Row;
      store.set(String(row.id), row);
      return row;
    },
    async readOne(lookup, optsRead) {
      for (const row of store.values()) {
        if (String(row[lookup.field]) !== lookup.value) continue;
        const extras = Object.entries(lookup.filters ?? {});
        if (!extras.every(([k, v]) => String(row[k]) === v)) return null;
        const withDeleted = optsRead.withDeleted ?? false;
        if (!withDeleted && softDeleteField !== undefined && row[softDeleteField] != null)
          return null;
        return row;
      }
      return null;
    },
    async update(lookup, patch) {
      const existing = store.get(lookup.value);
      if (!existing) return null;
      const updated = { ...existing, ...patch };
      store.set(lookup.value, updated);
      return updated;
    },
    async delete(lookup, optsDelete) {
      const existing = store.get(lookup.value);
      if (!existing) return null;
      if (optsDelete.softDeleteField !== undefined) {
        const stamped = { ...existing, [optsDelete.softDeleteField]: Date.now() };
        store.set(lookup.value, stamped);
        return stamped;
      }
      store.delete(lookup.value);
      return existing;
    },
    async list(query: ListQuery): Promise<Page<Row>> {
      const rows = applyFilters(
        visibleRows(query.options.withDeleted ?? false, query.options.onlyDeleted ?? false),
        query,
      );
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

  if (softDeleteField !== undefined) {
    adapter.restore = async (lookup) => {
      const existing = store.get(lookup.value);
      if (!existing || existing[softDeleteField] == null) return null;
      const restored = { ...existing, [softDeleteField]: null };
      store.set(lookup.value, restored);
      return restored;
    };
  }
  if (opts.nativeSearch) adapter.search = search;
  if (opts.nativeAggregate) adapter.aggregate = aggregate;

  return { adapter, search, aggregate };
}

const itemSchema = z.object({
  id: z.string(),
  email: z.string().optional(),
  name: z.string().min(1).optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  category: z.string().optional(),
  tag: z.string().optional(),
  value: z.number().optional(),
  status: z.string().optional(),
  secret: z.string().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  deletedAt: z.number().nullable().optional(),
});

function makeResource(
  overrides: Record<string, unknown> = {},
  fake: FakeOptions = { softDeleteField: 'deletedAt' },
) {
  const { model: modelOverrides, ...resourceOverrides } = overrides;
  const store = new Map<string, Row>();
  const policies = {
    operation: () => true,
    ...((modelOverrides as { policies?: ModelPolicies } | undefined)?.policies ?? {}),
  } satisfies ModelPolicies;
  const model = defineModel({
    name: 'item',
    tableName: 'items',
    schema: itemSchema,
    softDelete: fake.softDeleteField !== undefined,
    ...((modelOverrides as object) ?? {}),
    policies,
  });
  const { adapter, search, aggregate } = fakeAdapter(store, fake);
  const resource = defineResource('items', {
    model,
    adapter,
    filterFields: ['category', 'tag', 'status', 'value', 'email'],
    search: { fields: { title: { weight: 2 }, body: { weight: 1 } } },
    aggregate: {
      sumFields: ['value'],
      avgFields: ['value'],
      minMaxFields: ['value'],
      countDistinctFields: ['tag'],
      groupByFields: ['category', 'tag'],
    },
    ...(resourceOverrides as object),
  });
  return { store, model, adapter, resource, search, aggregate };
}

const req = (partial: Partial<EngineRequest> = {}): EngineRequest => partial;

/** Three articles: 1 + 3 mention TypeScript, 2 is Python. */
function seedArticles(store: Map<string, Row>): void {
  store.set('1', {
    id: '1',
    title: 'TypeScript Handbook',
    body: 'A guide to TypeScript',
    category: 'A',
    tag: 'x',
    value: 10,
  });
  store.set('2', {
    id: '2',
    title: 'Python Handbook',
    body: 'A guide to Python',
    category: 'A',
    tag: 'y',
    value: 20,
  });
  store.set('3', {
    id: '3',
    title: 'Advanced TypeScript',
    body: 'Deep dive into TypeScript generics',
    category: 'B',
    tag: 'x',
    value: 30,
  });
}

// ===========================================================================
// search
// ===========================================================================

describe('search', () => {
  it('returns hit wrappers { item, score, matchedFields } + search result_info envelope', async () => {
    const { resource, store } = makeResource();
    seedArticles(store);

    const result = await resource.execute('search', req({ query: { q: 'typescript' } }));
    expect(result.status).toBe(200);
    const body = result.body as {
      success: boolean;
      result: Array<{ item: Row; score: number; matchedFields: string[]; highlights?: unknown }>;
      result_info: Record<string, unknown>;
    };
    expect(body.success).toBe(true);

    const ids = body.result.map((h) => h.item.id);
    expect(ids).toEqual(expect.arrayContaining(['1', '3']));
    expect(ids).not.toContain('2');
    // scores are monotonically non-increasing
    for (let i = 1; i < body.result.length; i++) {
      expect(body.result[i - 1].score).toBeGreaterThanOrEqual(body.result[i].score);
    }
    expect(body.result[0].matchedFields.length).toBeGreaterThan(0);
    // highlights omitted unless ?highlight=true
    expect(body.result[0].highlights).toBeUndefined();

    expect(body.result_info).toMatchObject({
      page: 1,
      per_page: 20,
      total_count: 2,
      total_pages: 1,
      query: 'typescript',
      searchedFields: ['title', 'body'],
    });
  });

  it('rejects a missing or too-short query with VALIDATION_ERROR 400', async () => {
    const { resource, store } = makeResource();
    seedArticles(store);
    await expect(resource.execute('search', req({ query: {} }))).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
    await expect(resource.execute('search', req({ query: { q: 'a' } }))).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('includes highlights only when ?highlight=true', async () => {
    const { resource, store } = makeResource();
    seedArticles(store);
    const result = await resource.execute(
      'search',
      req({ query: { q: 'typescript', highlight: 'true' } }),
    );
    const body = result.body as {
      result: Array<{
        item: Row;
        highlights?: Record<
          string,
          Array<{ text: string; ranges: Array<{ start: number; end: number }> }>
        >;
      }>;
    };
    const hit = body.result.find((h) => h.item.id === '1');
    const highlight = hit?.highlights?.title?.[0];
    expect(highlight?.text.slice(highlight.ranges[0]?.start, highlight.ranges[0]?.end)).toBe(
      'TypeScript',
    );
  });

  it('all mode requires every token; phrase mode matches an exact substring', async () => {
    const { resource, store } = makeResource();
    seedArticles(store);
    const all = await resource.execute(
      'search',
      req({ query: { q: 'typescript generics', mode: 'all' } }),
    );
    expect((all.body as { result: Array<{ item: Row }> }).result.map((h) => h.item.id)).toEqual([
      '3',
    ]);

    const phrase = await resource.execute(
      'search',
      req({ query: { q: 'guide to typescript', mode: 'phrase' } }),
    );
    expect((phrase.body as { result: Array<{ item: Row }> }).result.map((h) => h.item.id)).toEqual([
      '1',
    ]);
  });

  it('paginates hits and reports the post-filter total_count', async () => {
    const { resource, store } = makeResource();
    seedArticles(store);
    const result = await resource.execute(
      'search',
      req({ query: { q: 'typescript', per_page: '1', page: '1' } }),
    );
    const body = result.body as {
      result: unknown[];
      result_info: { total_count: number; total_pages: number };
    };
    expect(body.result).toHaveLength(1);
    expect(body.result_info.total_count).toBe(2);
    expect(body.result_info.total_pages).toBe(2);
  });

  it('scopes hits to the request tenant', async () => {
    const { resource, store } = makeResource({ model: { multiTenant: true } });
    store.set('1', { id: '1', title: 'TypeScript t1', body: 'x', tenantId: 't1' });
    store.set('2', { id: '2', title: 'TypeScript t2', body: 'x', tenantId: 't2' });

    const result = await resource.execute(
      'search',
      req({ query: { q: 'typescript' }, vars: { tenantId: 't1' } }),
    );
    const body = result.body as { result: Array<{ item: Row }> };
    expect(body.result.map((h) => h.item.id)).toEqual(['1']);
  });

  it('applies read-policy filtering + field masking to hits (hardening)', async () => {
    const policies: ModelPolicies = {
      read: (_ctx, row) => (row as Row).status !== 'hidden',
      fields: () => ({ secret: '***' }),
    };
    const { resource, store } = makeResource({ model: { policies } });
    store.set('1', {
      id: '1',
      title: 'TypeScript visible',
      body: 'x',
      status: 'ok',
      secret: 'top',
    });
    store.set('2', {
      id: '2',
      title: 'TypeScript hidden',
      body: 'x',
      status: 'hidden',
      secret: 'top',
    });

    const result = await resource.execute('search', req({ query: { q: 'typescript' } }));
    const body = result.body as { result: Array<{ item: Row }> };
    expect(body.result.map((h) => h.item.id)).toEqual(['1']);
    expect(body.result[0].item.secret).toBe('***');
  });

  it('uses the native search path when the adapter declares nativeSearch', async () => {
    const { resource, store, search } = makeResource(
      {},
      { softDeleteField: 'deletedAt', nativeSearch: true },
    );
    seedArticles(store);
    const result = await resource.execute('search', req({ query: { q: 'typescript' } }));
    expect(search).toHaveBeenCalledTimes(1);
    expect((result.body as { result: unknown[] }).result.length).toBe(2);
  });
});

// ===========================================================================
// aggregate
// ===========================================================================

describe('aggregate', () => {
  it('requires and enforces explicit operation authorization', async () => {
    const missing = makeResource({ model: { policies: { operation: undefined } } });
    await expect(
      missing.resource.execute('aggregate', req({ query: { count: '*' } })),
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });

    const denied = makeResource({
      model: {
        policies: { operation: (_ctx: unknown, operation: string) => operation !== 'aggregate' },
      },
    });
    await expect(
      denied.resource.execute('aggregate', req({ query: { count: '*' } })),
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
  });

  it('computes ungrouped { values } keyed by alias', async () => {
    const { resource, store } = makeResource();
    seedArticles(store);
    const result = await resource.execute(
      'aggregate',
      req({ query: { count: '*', sum: 'value', avg: 'value' } }),
    );
    expect(result.status).toBe(200);
    const body = result.body as {
      success: boolean;
      result: { values: Record<string, number | null> };
    };
    expect(body.success).toBe(true);
    expect(body.result.values).toEqual({ count: 3, sumValue: 60, avgValue: 20 });
  });

  it('defaults to COUNT(*) when no aggregation is requested', async () => {
    const { resource, store } = makeResource();
    seedArticles(store);
    const result = await resource.execute('aggregate', req({ query: {} }));
    expect((result.body as { result: { values: Record<string, number> } }).result.values).toEqual({
      count: 3,
    });
  });

  it('groups into { groups, totalGroups }', async () => {
    const { resource, store } = makeResource();
    seedArticles(store);
    const result = await resource.execute(
      'aggregate',
      req({ query: { sum: 'value', groupBy: 'category' } }),
    );
    const body = result.body as {
      result: { groups: Array<{ key: Row; values: Row }>; totalGroups: number };
    };
    expect(body.result.totalGroups).toBe(2);
    expect(body.result.groups).toContainEqual({ key: { category: 'A' }, values: { sumValue: 30 } });
    expect(body.result.groups).toContainEqual({ key: { category: 'B' }, values: { sumValue: 30 } });
  });

  it('supports HAVING, ordering, and group pagination together', async () => {
    const { resource, store } = makeResource();
    seedArticles(store);
    // A has 2 rows, B has 1 → having count>=2 keeps only A.
    const having = await resource.execute(
      'aggregate',
      req({ query: { count: '*', groupBy: 'category', 'having[count][gte]': '2' } }),
    );
    const hbody = having.body as { result: { groups: Array<{ key: Row }>; totalGroups: number } };
    expect(hbody.result.totalGroups).toBe(1);
    expect(hbody.result.groups[0].key.category).toBe('A');

    const ordered = await resource.execute(
      'aggregate',
      req({
        query: {
          sum: 'value',
          groupBy: 'category',
          orderBy: 'sumValue',
          orderDirection: 'desc',
          limit: '1',
        },
      }),
    );
    const obody = ordered.body as { result: { groups: Array<{ key: Row }>; totalGroups: number } };
    expect(obody.result.totalGroups).toBe(2);
    expect(obody.result.groups).toHaveLength(1);
  });

  it('applies WHERE filters before aggregating', async () => {
    const { resource, store } = makeResource();
    seedArticles(store);
    const result = await resource.execute(
      'aggregate',
      req({ query: { count: '*', category: 'B' } }),
    );
    expect((result.body as { result: { values: Record<string, number> } }).result.values).toEqual({
      count: 1,
    });
  });

  it('rejects a disallowed aggregation field with AGGREGATION_ERROR 400', async () => {
    const { resource, store } = makeResource();
    seedArticles(store);
    await expect(
      resource.execute('aggregate', req({ query: { sum: 'notallowed' } })),
    ).rejects.toMatchObject({ statusCode: 400, code: 'AGGREGATION_ERROR' });
  });

  it('scopes aggregation to the request tenant', async () => {
    const { resource, store } = makeResource({ model: { multiTenant: true } });
    store.set('1', { id: '1', value: 10, tenantId: 't1' });
    store.set('2', { id: '2', value: 20, tenantId: 't2' });
    const result = await resource.execute(
      'aggregate',
      req({ query: { sum: 'value' }, vars: { tenantId: 't1' } }),
    );
    expect((result.body as { result: { values: Record<string, number> } }).result.values).toEqual({
      sumValue: 10,
    });
  });

  it('uses the native aggregate path when the adapter declares the capability', async () => {
    const { resource, store, aggregate } = makeResource(
      {},
      { softDeleteField: 'deletedAt', nativeAggregate: true },
    );
    seedArticles(store);
    const result = await resource.execute('aggregate', req({ query: { count: '*' } }));
    expect(aggregate).toHaveBeenCalledTimes(1);
    expect((result.body as { result: { values: Record<string, number> } }).result.values).toEqual({
      count: 3,
    });
  });

  it('does not use native aggregate when a row read policy requires post-filtering', async () => {
    const { resource, store, aggregate } = makeResource(
      { model: { policies: { read: () => false } } },
      { softDeleteField: 'deletedAt', nativeAggregate: true },
    );
    seedArticles(store);
    const result = await resource.execute('aggregate', req({ query: { count: '*' } }));
    expect(aggregate).not.toHaveBeenCalled();
    expect((result.body as { result: { values: Record<string, number> } }).result.values).toEqual({
      count: 0,
    });
  });

  it('rejects an engine fallback scan above 1000 rows', async () => {
    const { resource, store } = makeResource();
    for (let i = 0; i < 1_001; i++) store.set(String(i), { id: String(i), value: i });
    await expect(
      resource.execute('aggregate', req({ query: { count: '*' } })),
    ).rejects.toMatchObject({ statusCode: 400, code: 'SCAN_LIMIT_EXCEEDED' });
  });
});

// ===========================================================================
// export
// ===========================================================================

describe('export', () => {
  it('exports CSV with text/csv + attachment headers', async () => {
    const { resource, store } = makeResource();
    store.set('1', { id: '1', title: 'Alpha', value: 10 });
    store.set('2', { id: '2', title: 'Beta', value: 20 });

    const result = await resource.execute('export', req({ query: { format: 'csv' } }));
    expect(result.status).toBe(200);
    expect(result.headers?.['Content-Type']).toBe('text/csv; charset=utf-8');
    expect(result.headers?.['Content-Disposition']).toMatch(
      /^attachment; filename="items-export-.*\.csv"$/,
    );
    const parsed = parseCsv(result.body as string);
    expect(parsed.data).toHaveLength(2);
    expect(parsed.data[0]).toMatchObject({ id: '1', title: 'Alpha', value: '10' });
  });

  it('quotes CSV cells containing the delimiter', async () => {
    const { resource, store } = makeResource();
    store.set('1', { id: '1', title: 'Doe, John' });
    const result = await resource.execute('export', req({ query: { format: 'csv' } }));
    expect(result.body as string).toContain('"Doe, John"');
  });

  it('returns an empty body for an empty result set', async () => {
    const { resource } = makeResource();
    const result = await resource.execute('export', req({ query: { format: 'csv' } }));
    expect(result.body).toBe('');
  });

  it('exports JSON by default with { data, count, format, exportedAt }', async () => {
    const { resource, store } = makeResource();
    store.set('1', { id: '1', title: 'Alpha' });
    const result = await resource.execute('export', req({ query: {} }));
    const body = result.body as {
      success: boolean;
      result: { data: Row[]; count: number; format: string; exportedAt: string };
    };
    expect(body.success).toBe(true);
    expect(body.result.count).toBe(1);
    expect(body.result.format).toBe('json');
    expect(body.result.data[0].title).toBe('Alpha');
    expect(typeof body.result.exportedAt).toBe('string');
    expect(result.headers?.['Content-Disposition']).toContain('items-export-');
  });

  it('excludes soft-deleted rows by default and includes them with ?withDeleted=true', async () => {
    const { resource, store } = makeResource();
    store.set('1', { id: '1', title: 'Live' });
    store.set('2', { id: '2', title: 'Gone', deletedAt: 123 });

    const live = await resource.execute('export', req({ query: { format: 'csv' } }));
    expect(parseCsv(live.body as string).data).toHaveLength(1);

    const all = await resource.execute(
      'export',
      req({ query: { format: 'csv', withDeleted: 'true' } }),
    );
    expect(parseCsv(all.body as string).data).toHaveLength(2);
  });

  it('scopes the export to the request tenant and masks/read-filters rows', async () => {
    const policies: ModelPolicies = {
      read: (_ctx, row) => (row as Row).status !== 'hidden',
      fields: () => ({ secret: '***' }),
    };
    const { resource, store } = makeResource({ model: { multiTenant: true, policies } });
    store.set('1', { id: '1', title: 'T1', status: 'ok', secret: 'top', tenantId: 't1' });
    store.set('2', { id: '2', title: 'T2', status: 'ok', secret: 'top', tenantId: 't2' });
    store.set('3', {
      id: '3',
      title: 'T1 hidden',
      status: 'hidden',
      secret: 'top',
      tenantId: 't1',
    });

    const result = await resource.execute(
      'export',
      req({ query: { format: 'csv' }, vars: { tenantId: 't1' } }),
    );
    const data = parseCsv(result.body as string).data;
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ id: '1', secret: '***' });
  });

  it('rejects exports above the 1,000-row authorization window for arbitrary read policies', async () => {
    const { resource, store } = makeResource({
      model: { policies: { read: () => true } },
    });
    for (let index = 0; index < 1_001; index++) {
      store.set(String(index), { id: String(index), title: `Item ${index}` });
    }

    await expect(resource.execute('export', req({ query: {} }))).rejects.toMatchObject({
      statusCode: 400,
      code: 'SCAN_LIMIT_EXCEEDED',
    });
  });
});

// ===========================================================================
// import
// ===========================================================================

describe('import', () => {
  it('enforces create and write policies without exposing internal errors', async () => {
    const createDenied = makeResource({ model: { policies: { create: () => false } } });
    const deniedCreate = await createDenied.resource.execute(
      'import',
      req({ body: { items: [{ email: 'new@x', name: 'New' }] } }),
    );
    expect(
      (deniedCreate.body as { result: { results: Array<{ status: string }> } }).result.results[0]
        .status,
    ).toBe('failed');
    expect(createDenied.store.size).toBe(0);

    const writeDenied = makeResource({
      model: { policies: { write: () => false } },
      upsert: { keys: ['email'] },
    });
    writeDenied.store.set('a', { id: 'a', email: 'a@x', name: 'Original' });
    const deniedWrite = await writeDenied.resource.execute(
      'import',
      req({
        query: { mode: 'upsert' },
        body: { items: [{ email: 'a@x', name: 'Changed' }] },
      }),
    );
    expect(
      (deniedWrite.body as { result: { results: Array<{ status: string }> } }).result.results[0]
        .status,
    ).toBe('failed');
    expect(writeDenied.store.get('a')!.name).toBe('Original');

    const errors = makeResource();
    errors.adapter.create = async () => {
      throw new Error('SQL failed password=super-secret');
    };
    const failed = await errors.resource.execute(
      'import',
      req({ body: { items: [{ email: 'x@x', name: 'X' }] } }),
    );
    const publicError = (failed.body as { result: { results: Array<{ error?: string }> } }).result
      .results[0].error;
    expect(publicError).toBe('Import operation failed');
    expect(publicError).not.toContain('super-secret');
  });
  it('creates rows from a JSON items payload → summary + per-row results, 200', async () => {
    const { resource, store } = makeResource();
    const result = await resource.execute(
      'import',
      req({
        body: {
          items: [
            { email: 'a@x', name: 'Alice' },
            { email: 'b@x', name: 'Bob' },
          ],
        },
      }),
    );
    expect(result.status).toBe(200);
    const body = result.body as {
      result: {
        summary: Record<string, number>;
        results: Array<{ rowNumber: number; status: string; data?: Row }>;
      };
    };
    expect(body.result.summary).toEqual({
      total: 2,
      created: 2,
      updated: 0,
      skipped: 0,
      failed: 0,
    });
    expect(body.result.results.map((r) => r.status)).toEqual(['created', 'created']);
    expect(body.result.results[0].rowNumber).toBe(1);
    expect(typeof body.result.results[0].data?.id).toBe('string');
    expect(typeof body.result.results[0].data?.createdAt).toBe('number');
    expect(store.size).toBe(2);
  });

  it('accepts a bare JSON array body', async () => {
    const { resource, store } = makeResource();
    const result = await resource.execute(
      'import',
      req({ body: [{ email: 'a@x', name: 'Alice' }] }),
    );
    expect(result.status).toBe(200);
    expect(store.size).toBe(1);
  });

  it('imports CSV text and round-trips string columns', async () => {
    const { resource, store } = makeResource();
    const csv = 'email,name,title\r\na@x,Alice,Hello\r\nb@x,Bob,World';
    const result = await resource.execute('import', req({ body: csv }));
    const body = result.body as { result: { summary: Record<string, number> } };
    expect(body.result.summary).toMatchObject({ total: 2, created: 2 });
    expect(store.size).toBe(2);
    expect(
      Array.from(store.values())
        .map((r) => r.name)
        .sort(),
    ).toEqual(['Alice', 'Bob']);
  });

  it('skips create-mode duplicates by default (matching the upsert keys)', async () => {
    const { resource, store } = makeResource({ upsert: { keys: ['email'] } });
    store.set('existing', { id: 'existing', email: 'dup@x', name: 'Old' });
    const result = await resource.execute(
      'import',
      req({
        body: {
          items: [
            { email: 'dup@x', name: 'New' },
            { email: 'fresh@x', name: 'Fresh' },
          ],
        },
      }),
    );
    const body = result.body as {
      result: { summary: Record<string, number>; results: Array<{ status: string }> };
    };
    expect(body.result.summary).toMatchObject({ created: 1, skipped: 1, failed: 0 });
    expect(body.result.results.map((r) => r.status)).toEqual(['skipped', 'created']);
    expect(store.size).toBe(2);
  });

  it('updates existing rows in upsert mode', async () => {
    const { resource, store } = makeResource({ upsert: { keys: ['email'] } });
    store.set('a', { id: 'a', email: 'dup@x', name: 'Old' });
    const result = await resource.execute(
      'import',
      req({ query: { mode: 'upsert' }, body: { items: [{ email: 'dup@x', name: 'Fresh' }] } }),
    );
    const body = result.body as {
      result: { summary: Record<string, number>; results: Array<{ status: string; data?: Row }> };
    };
    expect(body.result.summary).toMatchObject({ created: 0, updated: 1 });
    expect(body.result.results[0].status).toBe('updated');
    expect(store.get('a')?.name).toBe('Fresh');
    expect(store.size).toBe(1);
  });

  it("id:'client' upsert mode: matched rows keep their PK; created rows use the item id", async () => {
    const { resource, store } = makeResource({
      model: { id: 'client' },
      upsert: { keys: ['email'] },
    });
    store.set('right', { id: 'right', email: 'dup@x', name: 'Old' });
    const result = await resource.execute(
      'import',
      req({
        query: { mode: 'upsert' },
        body: {
          items: [
            { id: 'wrong', email: 'dup@x', name: 'Fresh' },
            { id: 'fresh', email: 'new@x', name: 'New' },
          ],
        },
      }),
    );
    const body = result.body as { result: { summary: Record<string, number> } };
    expect(body.result.summary).toMatchObject({ created: 1, updated: 1 });
    expect(store.get('right')?.name).toBe('Fresh');
    expect(store.get('right')?.id).toBe('right');
    expect(store.get('wrong')).toBeUndefined();
    expect(store.get('fresh')).toBeDefined();
  });

  it('skips invalid rows by default and reports validationErrors', async () => {
    const { resource } = makeResource();
    const result = await resource.execute(
      'import',
      req({
        body: {
          items: [
            { email: 'a@x', name: 'Alice' },
            { email: 'b@x', name: '' },
          ],
        },
      }),
    );
    const body = result.body as {
      result: {
        summary: Record<string, number>;
        results: Array<{ status: string; validationErrors?: unknown[] }>;
      };
    };
    expect(body.result.summary).toMatchObject({ created: 1, skipped: 1 });
    expect(body.result.results[1].status).toBe('skipped');
    expect(body.result.results[1].validationErrors?.length).toBeGreaterThan(0);
  });

  it('returns 207 for a strict partial failure (skipInvalid=false)', async () => {
    const { resource, store } = makeResource({ upsert: { keys: ['email'] } });
    store.set('a', { id: 'a', email: 'dup@x', name: 'Old' });
    const result = await resource.execute(
      'import',
      req({
        query: { skipInvalid: 'false' },
        body: {
          items: [
            { email: 'new@x', name: 'New' },
            { email: 'dup@x', name: 'Dup' },
          ],
        },
      }),
    );
    expect(result.status).toBe(207);
    const body = result.body as {
      result: { summary: Record<string, number>; results: Array<{ status: string }> };
    };
    expect(body.result.summary).toMatchObject({ total: 2, created: 1, failed: 1 });
    expect(body.result.results.map((r) => r.status)).toEqual(['created', 'failed']);
  });

  it('stops after the first failure when ?stopOnError=true', async () => {
    const { resource } = makeResource();
    const result = await resource.execute(
      'import',
      req({
        query: { skipInvalid: 'false', stopOnError: 'true' },
        body: {
          items: [
            { email: 'a@x', name: '' },
            { email: 'b@x', name: 'Bob' },
          ],
        },
      }),
    );
    const body = result.body as { result: { results: Array<{ status: string }> } };
    // Only the first (failing) row is processed; the loop halts.
    expect(body.result.results).toHaveLength(1);
    expect(body.result.results[0].status).toBe('failed');
  });

  it('injects + scopes the request tenant on imported rows (hardening)', async () => {
    const { resource, store } = makeResource({
      model: { multiTenant: true },
      upsert: { keys: ['email'] },
    });
    // Same email in another tenant must NOT be treated as an existing match.
    store.set('other', { id: 'other', email: 'shared@x', name: 'Other', tenantId: 't2' });
    const result = await resource.execute(
      'import',
      req({ body: { items: [{ email: 'shared@x', name: 'Mine' }] }, vars: { tenantId: 't1' } }),
    );
    const body = result.body as {
      result: { summary: Record<string, number>; results: Array<{ data?: Row }> };
    };
    expect(body.result.summary).toMatchObject({ created: 1 });
    expect(body.result.results[0].data?.tenantId).toBe('t1');
    expect(store.size).toBe(2);
  });

  it('rejects an oversized batch with VALIDATION_ERROR 400', async () => {
    const { resource } = makeResource({ batch: { maxBatchSize: 2 } });
    await expect(
      resource.execute(
        'import',
        req({
          body: {
            items: [
              { email: 'a@x', name: 'A' },
              { email: 'b@x', name: 'B' },
              { email: 'c@x', name: 'C' },
            ],
          },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
  });

  it('rejects an unrecognized payload with VALIDATION_ERROR 400', async () => {
    const { resource } = makeResource();
    await expect(
      resource.execute('import', req({ body: { notItems: true } })),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  });
});
