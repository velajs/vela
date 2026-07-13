import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AdapterCapability, AdapterScope, CrudAdapter } from '../../../adapter/contract';
import type {
  BulkOutcome,
  FilterCondition,
  ListQuery,
  Lookup,
  Page,
  UpsertInput,
} from '../../../adapter/query-types';
import { matchesFilter } from '../../../query/filters';
import { defineModel } from '../../../model/define-model';
import { defineResource } from '../../resource';
import type { CrudHooks, HookModeConfig } from '../../hook-types';
import type { EngineRequest } from '../../engine-request';

type Row = Record<string, unknown>;

interface FakeOptions {
  /** Soft-delete column (enables softDelete + restore capabilities). */
  softDeleteField?: string;
  /** Declare + implement `upsertOne` (native upsert path). */
  native?: boolean;
  /** Force-OFF the restore capability even while soft-deleting (loud-error test). */
  restore?: boolean;
  /** Declare + implement `createMany` (native batch-insert path). */
  nativeBatch?: boolean;
  /** Declare + implement `updateWhere` (native filtered bulk-patch path). */
  bulkPatch?: boolean;
}

/**
 * In-test adapter over a Map — the batch-family sibling of the one in
 * `./restore-clone-upsert.test.ts`, additionally implementing the `createMany`
 * and `updateWhere` capability methods (plus `restore` / `upsertOne`) so the
 * native-vs-synthesized paths can both be exercised.
 */
function fakeAdapter(store: Map<string, Row>, opts: FakeOptions = {}): CrudAdapter<Row> {
  const softDeleteField = opts.softDeleteField;
  const hasRestore = softDeleteField !== undefined && opts.restore !== false;
  const hasUpsert = opts.native === true;
  const hasNativeBatch = opts.nativeBatch === true;
  const hasBulkPatch = opts.bulkPatch === true;
  const scopeSentinel: AdapterScope = { tx: { fake: true } };

  const visible = (row: Row, withDeleted: boolean) =>
    withDeleted || softDeleteField === undefined || row[softDeleteField] == null;

  const find = (lookup: Lookup, withDeleted: boolean): Row | null => {
    for (const row of store.values()) {
      if (String(row[lookup.field]) !== lookup.value) continue;
      const extras = Object.entries(lookup.filters ?? {});
      if (!extras.every(([k, v]) => String(row[k]) === v)) return null;
      return visible(row, withDeleted) ? row : null;
    }
    return null;
  };

  const caps: AdapterCapability[] = [];
  if (softDeleteField !== undefined) caps.push('softDelete');
  if (hasRestore) caps.push('restore');
  if (hasUpsert) caps.push('upsert');
  if (hasNativeBatch) caps.push('nativeBatch');
  if (hasBulkPatch) caps.push('bulkPatch');

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
      return find(lookup, optsRead.withDeleted ?? false);
    },
    async update(lookup, patch) {
      const existing = find(lookup, false);
      if (!existing) return null;
      const updated = { ...existing, ...patch };
      store.set(String(existing.id), updated);
      return updated;
    },
    async delete(lookup, optsDelete) {
      const existing = find(lookup, false);
      if (!existing) return null;
      if (optsDelete.softDeleteField !== undefined) {
        const stamped = { ...existing, [optsDelete.softDeleteField]: Date.now() };
        store.set(String(existing.id), stamped);
        return stamped;
      }
      store.delete(String(existing.id));
      return existing;
    },
    async list(query: ListQuery): Promise<Page<Row>> {
      let rows = Array.from(store.values());
      if (softDeleteField !== undefined && !query.options.withDeleted) {
        rows = rows.filter((r) => r[softDeleteField] == null);
      }
      for (const f of query.filters) {
        rows = rows.filter((r) => matchesFilter(r[f.field], f));
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

  if (hasRestore) {
    adapter.restore = async (lookup) => {
      const existing = find(lookup, true);
      if (!existing || existing[softDeleteField!] == null) return null;
      const restored = { ...existing, [softDeleteField!]: null };
      store.set(String(existing.id), restored);
      return restored;
    };
  }

  if (hasUpsert) {
    adapter.upsertOne = async (input: UpsertInput<Row>) => {
      const { conflictTarget, values } = input;
      for (const row of store.values()) {
        if (conflictTarget.every((k) => String(row[k]) === String(values[k]))) {
          const { id: _ignored, ...rest } = values as Row;
          const updated = { ...row, ...rest };
          store.set(String(row.id), updated);
          return { row: updated, created: false };
        }
      }
      const created = { ...values } as Row;
      store.set(String(created.id), created);
      return { row: created, created: true };
    };
  }

  if (hasNativeBatch) {
    adapter.createMany = async (rows) => {
      const created: Row[] = [];
      for (const input of rows) {
        const row = { ...input } as Row;
        store.set(String(row.id), row);
        created.push(row);
      }
      return created;
    };
  }

  if (hasBulkPatch) {
    adapter.updateWhere = async (filters: FilterCondition[], patch): Promise<BulkOutcome<Row>> => {
      const records: Row[] = [];
      for (const row of store.values()) {
        if (!filters.every((f) => matchesFilter(row[f.field], f))) continue;
        const updated = { ...row, ...patch };
        store.set(String(row.id), updated);
        records.push(updated);
      }
      return { count: records.length, records };
    };
  }

  return adapter;
}

const itemSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().min(1),
  role: z.string().optional(),
  age: z.number().int().optional(),
  qty: z.number().int().nonnegative().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  deletedAt: z.number().nullable().optional(),
});

function makeResource(
  overrides: Record<string, unknown> = {},
  fake: FakeOptions | false = { softDeleteField: 'deletedAt' },
) {
  const { model: modelOverrides, ...resourceOverrides } = overrides;
  const store = new Map<string, Row>();
  const softDelete = fake !== false && fake.softDeleteField !== undefined;
  const model = defineModel({
    name: 'item',
    tableName: 'items',
    schema: itemSchema,
    softDelete,
    ...((modelOverrides as object) ?? {}),
  });
  const adapter = fake === false ? fakeAdapter(store, {}) : fakeAdapter(store, fake);
  const resource = defineResource('items', {
    model,
    adapter,
    filterFields: ['qty', 'name', 'email', 'role', 'age'],
    ...(resourceOverrides as object),
  });
  return { store, model, adapter, resource };
}

const req = (partial: Partial<EngineRequest> = {}): EngineRequest => partial;

/** A Web Request carrying the given headers (for the X-Confirm-Bulk flow). */
const withHeaders = (headers: Record<string, string>): Request =>
  new Request('http://engine.test/', { headers });

// ===========================================================================
// batchCreate — POST /batch
// ===========================================================================

describe('batchCreate', () => {
  it('rejects nested-write payloads with a loud 400 (no dispatch seam)', async () => {
    const PostSchema = z.object({
      id: z.string(),
      authorId: z.string().optional(),
      title: z.string(),
    });
    const { resource } = makeResource({
      model: {
        relations: {
          posts: {
            type: 'hasMany' as const,
            target: 'posts',
            foreignKey: 'authorId',
            schema: PostSchema,
            nestedWrites: { allowCreate: true },
          },
        },
      },
    });
    await expect(
      resource.execute(
        'batchCreate',
        req({ body: { items: [{ email: 'x@x', name: 'X', posts: [{ title: 'p' }] }] } }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('inserts every item → 201 { created, count } with fresh ids + timestamps', async () => {
    const { resource, store } = makeResource();
    const result = await resource.execute(
      'batchCreate',
      req({
        body: {
          items: [
            { email: 'a@x', name: 'A' },
            { email: 'b@x', name: 'B' },
          ],
        },
      }),
    );
    expect(result.status).toBe(201);
    const body = result.body as { success: boolean; result: { created: Row[]; count: number } };
    expect(body.success).toBe(true);
    expect(body.result.count).toBe(2);
    expect(body.result.created).toHaveLength(2);
    expect(body.result.created.every((r) => typeof r.id === 'string')).toBe(true);
    expect(body.result.created.every((r) => typeof r.createdAt === 'number')).toBe(true);
    expect(store.size).toBe(2);
  });

  it('rejects a batch over maxBatchSize with VALIDATION_ERROR 400 (nothing written)', async () => {
    const { resource, store } = makeResource({ batch: { maxBatchSize: 2 } });
    await expect(
      resource.execute(
        'batchCreate',
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
    expect(store.size).toBe(0);
  });

  it('rejects an empty items array and a wrong body shape with 400', async () => {
    const { resource } = makeResource();
    await expect(
      resource.execute('batchCreate', req({ body: { items: [] } })),
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    await expect(
      resource.execute('batchCreate', req({ body: [{ email: 'a@x', name: 'A' }] })),
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
  });

  it('aborts the whole batch on a per-item validation error (400, atomic — nothing written)', async () => {
    const { resource, store } = makeResource();
    await expect(
      resource.execute(
        'batchCreate',
        req({
          body: {
            items: [
              { email: 'a@x', name: 'A' },
              { email: 'b@x', name: '' }, // invalid: name min(1)
            ],
          },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    expect(store.size).toBe(0);
  });

  it('runs beforeBatchCreate/afterBatchCreate per item, in order, with the item index', async () => {
    const seen: Array<{ phase: string; index: number }> = [];
    const hooks: CrudHooks<Row> & HookModeConfig = {
      beforeBatchCreate: (_ctx, item, index) => {
        seen.push({ phase: 'before', index });
        return { ...item, name: `${item.name as string}!` };
      },
      afterBatchCreate: (_ctx, row, index) => {
        seen.push({ phase: 'after', index });
        return { ...row, tag: 'hooked' };
      },
    };
    const { resource } = makeResource({ hooks });
    const result = await resource.execute(
      'batchCreate',
      req({
        body: {
          items: [
            { email: 'a@x', name: 'A' },
            { email: 'b@x', name: 'B' },
          ],
        },
      }),
    );
    expect(seen).toEqual([
      { phase: 'before', index: 0 },
      { phase: 'before', index: 1 },
      { phase: 'after', index: 0 },
      { phase: 'after', index: 1 },
    ]);
    const body = result.body as { result: { created: Row[] } };
    expect(body.result.created.map((r) => r.name)).toEqual(['A!', 'B!']);
    expect(body.result.created.every((r) => r.tag === 'hooked')).toBe(true);
  });

  it('uses the native createMany path once when the adapter declares nativeBatch', async () => {
    const store = new Map<string, Row>();
    const model = defineModel({ name: 'item', tableName: 'items', schema: itemSchema });
    const base = fakeAdapter(store, { nativeBatch: true });
    const createMany = vi.fn(base.createMany!);
    base.createMany = createMany;
    const create = vi.fn(base.create);
    base.create = create;
    const resource = defineResource('items', { model, adapter: base });

    const result = await resource.execute(
      'batchCreate',
      req({
        body: {
          items: [
            { email: 'a@x', name: 'A' },
            { email: 'b@x', name: 'B' },
          ],
        },
      }),
    );
    expect(result.status).toBe(201);
    expect(createMany).toHaveBeenCalledTimes(1);
    expect((createMany.mock.calls[0][0] as Row[]).length).toBe(2);
    expect(create).not.toHaveBeenCalled();
    expect(store.size).toBe(2);
  });

  it('stamps the request tenant on every created row', async () => {
    const { resource } = makeResource({ model: { multiTenant: true } });
    const result = await resource.execute(
      'batchCreate',
      req({ body: { items: [{ email: 'a@x', name: 'A' }] }, vars: { tenantId: 't1' } }),
    );
    const body = result.body as { result: { created: Row[] } };
    expect(body.result.created[0].tenantId).toBe('t1');
  });
});

// ===========================================================================
// batchUpdate — PATCH /batch
// ===========================================================================

describe('batchUpdate', () => {
  it('patches every item → 200 { updated, count } with updatedAt bumped', async () => {
    const { resource, store } = makeResource();
    store.set('a', { id: 'a', email: 'a@x', name: 'A', createdAt: 1 });
    store.set('b', { id: 'b', email: 'b@x', name: 'B', createdAt: 1 });

    const result = await resource.execute(
      'batchUpdate',
      req({
        body: {
          items: [
            { id: 'a', data: { name: 'A2' } },
            { id: 'b', data: { name: 'B2' } },
          ],
        },
      }),
    );
    expect(result.status).toBe(200);
    const body = result.body as { result: { updated: Row[]; count: number; notFound?: string[] } };
    expect(body.result.count).toBe(2);
    expect(body.result.notFound).toBeUndefined();
    expect(body.result.updated.map((r) => r.name)).toEqual(['A2', 'B2']);
    expect(body.result.updated.every((r) => typeof r.updatedAt === 'number')).toBe(true);
  });

  it('reports missing ids in notFound → 207', async () => {
    const { resource, store } = makeResource();
    store.set('a', { id: 'a', email: 'a@x', name: 'A' });

    const result = await resource.execute(
      'batchUpdate',
      req({
        body: {
          items: [
            { id: 'a', data: { name: 'A2' } },
            { id: 'ghost', data: { name: 'Z' } },
          ],
        },
      }),
    );
    expect(result.status).toBe(207);
    const body = result.body as { result: { updated: Row[]; count: number; notFound: string[] } };
    expect(body.result.count).toBe(1);
    expect(body.result.notFound).toEqual(['ghost']);
  });

  it('400 TENANT_REQUIRED when the model is multi-tenant and no tenant is present', async () => {
    const { resource } = makeResource({ model: { multiTenant: true } });
    await expect(
      resource.execute('batchUpdate', req({ body: { items: [{ id: 'a', data: { name: 'X' } }] } })),
    ).rejects.toMatchObject({ statusCode: 400, code: 'TENANT_REQUIRED' });
  });

  it("scopes to the tenant: another tenant's id falls through to notFound (row untouched)", async () => {
    const { resource, store } = makeResource({ model: { multiTenant: true } });
    store.set('a', { id: 'a', email: 'a@x', name: 'A', tenantId: 't1' });

    const result = await resource.execute(
      'batchUpdate',
      req({ body: { items: [{ id: 'a', data: { name: 'Hijacked' } }] }, vars: { tenantId: 't2' } }),
    );
    expect(result.status).toBe(207);
    const body = result.body as { result: { count: number; updated: Row[]; notFound: string[] } };
    expect(body.result.count).toBe(0);
    expect(body.result.updated).toEqual([]);
    expect(body.result.notFound).toEqual(['a']);
    expect(store.get('a')!.name).toBe('A');
  });

  it('threads beforeBatchUpdate (patch) / afterBatchUpdate (row) with indexes', async () => {
    const seen: Array<{ phase: string; index: number }> = [];
    const hooks: CrudHooks<Row> & HookModeConfig = {
      beforeBatchUpdate: (_ctx, patch, index) => {
        seen.push({ phase: 'before', index });
        return { ...patch, name: `${patch.name as string}#` };
      },
      afterBatchUpdate: (_ctx, row, index) => {
        seen.push({ phase: 'after', index });
        return { ...row, tag: 'x' };
      },
    };
    const { resource, store } = makeResource({ hooks });
    store.set('a', { id: 'a', email: 'a@x', name: 'A' });
    store.set('b', { id: 'b', email: 'b@x', name: 'B' });

    const result = await resource.execute(
      'batchUpdate',
      req({
        body: {
          items: [
            { id: 'a', data: { name: 'A2' } },
            { id: 'b', data: { name: 'B2' } },
          ],
        },
      }),
    );
    expect(seen).toEqual([
      { phase: 'before', index: 0 },
      { phase: 'after', index: 0 },
      { phase: 'before', index: 1 },
      { phase: 'after', index: 1 },
    ]);
    const body = result.body as { result: { updated: Row[] } };
    expect(body.result.updated.map((r) => r.name)).toEqual(['A2#', 'B2#']);
    expect(body.result.updated.every((r) => r.tag === 'x')).toBe(true);
  });

  it('rejects an invalid item patch with VALIDATION_ERROR 400', async () => {
    const { resource, store } = makeResource();
    store.set('a', { id: 'a', email: 'a@x', name: 'A' });
    await expect(
      resource.execute('batchUpdate', req({ body: { items: [{ id: 'a', data: { name: '' } }] } })),
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
  });
});

// ===========================================================================
// batchDelete — DELETE /batch
// ===========================================================================

describe('batchDelete', () => {
  it('soft-deletes every id → 200 { deleted, count } (deletedAt stamped)', async () => {
    const { resource, store } = makeResource();
    store.set('a', { id: 'a', email: 'a@x', name: 'A' });
    store.set('b', { id: 'b', email: 'b@x', name: 'B' });

    const result = await resource.execute('batchDelete', req({ body: { ids: ['a', 'b'] } }));
    expect(result.status).toBe(200);
    const body = result.body as { result: { deleted: Row[]; count: number } };
    expect(body.result.count).toBe(2);
    expect(body.result.deleted.every((r) => typeof r.deletedAt === 'number')).toBe(true);
    expect(store.get('a')!.deletedAt).toBeTruthy();
    expect(store.size).toBe(2); // soft delete keeps the rows
  });

  it('hard-deletes when the model has no soft-delete (rows removed)', async () => {
    const { resource, store } = makeResource({}, false);
    store.set('a', { id: 'a', email: 'a@x', name: 'A' });
    store.set('b', { id: 'b', email: 'b@x', name: 'B' });

    const result = await resource.execute('batchDelete', req({ body: { ids: ['a', 'b'] } }));
    expect(result.status).toBe(200);
    expect((result.body as { result: { count: number } }).result.count).toBe(2);
    expect(store.size).toBe(0);
  });

  it('reports missing / already-deleted ids in notFound → 207', async () => {
    const { resource, store } = makeResource();
    store.set('a', { id: 'a', email: 'a@x', name: 'A' });
    store.set('gone', { id: 'gone', email: 'g@x', name: 'Gone', deletedAt: 5 });

    const result = await resource.execute(
      'batchDelete',
      req({ body: { ids: ['a', 'gone', 'ghost'] } }),
    );
    expect(result.status).toBe(207);
    const body = result.body as { result: { count: number; notFound: string[] } };
    expect(body.result.count).toBe(1);
    expect(body.result.notFound).toEqual(['gone', 'ghost']);
  });

  it('400 TENANT_REQUIRED without a tenant, and scopes cross-tenant ids to notFound', async () => {
    const { resource, store } = makeResource({ model: { multiTenant: true } });
    store.set('a', { id: 'a', email: 'a@x', name: 'A', tenantId: 't1' });

    await expect(
      resource.execute('batchDelete', req({ body: { ids: ['a'] } })),
    ).rejects.toMatchObject({ statusCode: 400, code: 'TENANT_REQUIRED' });

    const result = await resource.execute(
      'batchDelete',
      req({ body: { ids: ['a'] }, vars: { tenantId: 't2' } }),
    );
    expect(result.status).toBe(207);
    expect((result.body as { result: { notFound: string[] } }).result.notFound).toEqual(['a']);
    expect(store.get('a')!.deletedAt ?? null).toBeNull();
  });

  it('runs beforeBatchDelete/afterBatchDelete with the pre-deletion prior + index', async () => {
    const seen: Array<{ phase: string; index: number; name: unknown }> = [];
    const hooks: CrudHooks<Row> & HookModeConfig = {
      beforeBatchDelete: (_ctx, prior, index) => {
        seen.push({ phase: 'before', index, name: prior.name });
      },
      afterBatchDelete: (_ctx, prior, index) => {
        seen.push({ phase: 'after', index, name: prior.name });
      },
    };
    const { resource, store } = makeResource({ hooks });
    store.set('a', { id: 'a', email: 'a@x', name: 'A' });

    await resource.execute('batchDelete', req({ body: { ids: ['a'] } }));
    expect(seen).toEqual([
      { phase: 'before', index: 0, name: 'A' },
      { phase: 'after', index: 0, name: 'A' },
    ]);
  });
});

// ===========================================================================
// batchRestore — POST /batch/restore
// ===========================================================================

describe('batchRestore', () => {
  it('restores soft-deleted ids → 200 { restored, count } (deletedAt cleared)', async () => {
    const { resource, store } = makeResource();
    store.set('a', { id: 'a', email: 'a@x', name: 'A', deletedAt: 5 });
    store.set('b', { id: 'b', email: 'b@x', name: 'B', deletedAt: 9 });

    const result = await resource.execute('batchRestore', req({ body: { ids: ['a', 'b'] } }));
    expect(result.status).toBe(200);
    const body = result.body as { result: { restored: Row[]; count: number } };
    expect(body.result.count).toBe(2);
    expect(body.result.restored.every((r) => r.deletedAt === null)).toBe(true);
    expect(store.get('a')!.deletedAt).toBeNull();
  });

  it('reports not-deleted / missing ids in notFound → 207', async () => {
    const { resource, store } = makeResource();
    store.set('a', { id: 'a', email: 'a@x', name: 'A', deletedAt: 5 });
    store.set('live', { id: 'live', email: 'l@x', name: 'Live' });

    const result = await resource.execute(
      'batchRestore',
      req({ body: { ids: ['a', 'live', 'ghost'] } }),
    );
    expect(result.status).toBe(207);
    const body = result.body as { result: { count: number; notFound: string[] } };
    expect(body.result.count).toBe(1);
    expect(body.result.notFound).toEqual(['live', 'ghost']);
  });

  it('throws a loud ConfigurationException when the model does not soft-delete', async () => {
    const { resource } = makeResource({}, false);
    await expect(
      resource.execute('batchRestore', req({ body: { ids: ['a'] } })),
    ).rejects.toMatchObject({ statusCode: 500, code: 'CONFIGURATION_ERROR' });
  });

  it('throws a loud ConfigurationException when the adapter lacks the restore capability', async () => {
    const { resource, store } = makeResource({}, { softDeleteField: 'deletedAt', restore: false });
    store.set('a', { id: 'a', email: 'a@x', name: 'A', deletedAt: 5 });
    await expect(
      resource.execute('batchRestore', req({ body: { ids: ['a'] } })),
    ).rejects.toMatchObject({ statusCode: 500, code: 'CONFIGURATION_ERROR' });
  });

  it('400 TENANT_REQUIRED without a tenant, and scopes cross-tenant ids to notFound', async () => {
    const { resource, store } = makeResource({ model: { multiTenant: true } });
    store.set('a', { id: 'a', email: 'a@x', name: 'A', deletedAt: 5, tenantId: 't1' });

    await expect(
      resource.execute('batchRestore', req({ body: { ids: ['a'] } })),
    ).rejects.toMatchObject({ statusCode: 400, code: 'TENANT_REQUIRED' });

    const result = await resource.execute(
      'batchRestore',
      req({ body: { ids: ['a'] }, vars: { tenantId: 't2' } }),
    );
    expect(result.status).toBe(207);
    expect((result.body as { result: { notFound: string[] } }).result.notFound).toEqual(['a']);
    expect(store.get('a')!.deletedAt).toBe(5); // untouched
  });

  it('runs beforeBatchRestore (soft-deleted prior) / afterBatchRestore (restored row) with indexes', async () => {
    const seen: Array<{ phase: string; index: number; deletedAt: unknown }> = [];
    const hooks: CrudHooks<Row> & HookModeConfig = {
      beforeBatchRestore: (_ctx, prior, index) => {
        seen.push({ phase: 'before', index, deletedAt: prior.deletedAt });
      },
      afterBatchRestore: (_ctx, row, index) => {
        seen.push({ phase: 'after', index, deletedAt: row.deletedAt });
        return { ...row, tag: 'r' };
      },
    };
    const { resource, store } = makeResource({ hooks });
    store.set('a', { id: 'a', email: 'a@x', name: 'A', deletedAt: 5 });

    const result = await resource.execute('batchRestore', req({ body: { ids: ['a'] } }));
    expect(seen).toEqual([
      { phase: 'before', index: 0, deletedAt: 5 },
      { phase: 'after', index: 0, deletedAt: null },
    ]);
    expect((result.body as { result: { restored: Row[] } }).result.restored[0].tag).toBe('r');
  });
});

// ===========================================================================
// batchUpsert — POST /batch/upsert  (bare array body)
// ===========================================================================

describe('batchUpsert', () => {
  const upsertCfg = { upsert: { keys: ['email'] } };

  it('throws a loud ConfigurationException when upsert.keys is not configured', async () => {
    const { resource } = makeResource();
    await expect(
      resource.execute('batchUpsert', req({ body: [{ email: 'x@x', name: 'X' }] })),
    ).rejects.toMatchObject({ statusCode: 500, code: 'CONFIGURATION_ERROR' });
  });

  it('creates + updates a mixed batch → 200 with per-item {data, created, index} + counts', async () => {
    const { resource, store } = makeResource(upsertCfg);
    store.set('a', { id: 'a', email: 'dup@x', name: 'Old', createdAt: 1 });

    const result = await resource.execute(
      'batchUpsert',
      req({
        body: [
          { email: 'dup@x', name: 'Fresh' }, // update existing
          { email: 'new@x', name: 'New' }, // create
        ],
      }),
    );
    expect(result.status).toBe(200);
    const body = result.body as {
      result: {
        items: Array<{ data: Row; created: boolean; index: number }>;
        createdCount: number;
        updatedCount: number;
        totalCount: number;
      };
    };
    expect(body.result.totalCount).toBe(2);
    expect(body.result.createdCount).toBe(1);
    expect(body.result.updatedCount).toBe(1);
    expect(body.result.items[0]).toMatchObject({ created: false, index: 0 });
    expect(body.result.items[0].data.id).toBe('a');
    expect(body.result.items[0].data.name).toBe('Fresh');
    expect(body.result.items[1]).toMatchObject({ created: true, index: 1 });
    expect(store.size).toBe(2);
  });

  it("id:'client': update leg keeps the matched row's PK; insert leg uses the item id", async () => {
    const { resource, store } = makeResource({ model: { id: 'client' }, ...upsertCfg });
    store.set('right', { id: 'right', email: 'dup@x', name: 'Old' });

    const result = await resource.execute(
      'batchUpsert',
      req({
        body: [
          { id: 'wrong', email: 'dup@x', name: 'Fresh' }, // matches by email — body id ignored
          { id: 'fresh', email: 'new@x', name: 'New' }, // no match — body id used
        ],
      }),
    );
    expect(result.status).toBe(200);
    const body = result.body as { result: { items: Array<{ data: Row; created: boolean }> } };
    expect(body.result.items[0].created).toBe(false);
    expect(body.result.items[0].data.id).toBe('right');
    expect(body.result.items[1].created).toBe(true);
    expect(body.result.items[1].data.id).toBe('fresh');
    expect(store.get('wrong')).toBeUndefined();
    expect(store.get('right')?.name).toBe('Fresh');
    expect(store.get('fresh')).toBeDefined();
  });

  it('match-and-restore: matching a soft-deleted row restores + updates it (created:false)', async () => {
    const { resource, store } = makeResource(upsertCfg);
    store.set('a', { id: 'a', email: 'phoenix@x', name: 'Old', deletedAt: 999 });

    const result = await resource.execute(
      'batchUpsert',
      req({ body: [{ email: 'phoenix@x', name: 'Reborn' }] }),
    );
    const body = result.body as { result: { items: Array<{ data: Row; created: boolean }> } };
    expect(body.result.items[0].created).toBe(false);
    expect(body.result.items[0].data.id).toBe('a');
    expect(body.result.items[0].data.deletedAt).toBeNull();
    expect(body.result.items[0].data.name).toBe('Reborn');
    expect(Array.from(store.values()).filter((r) => r.email === 'phoenix@x')).toHaveLength(1);
  });

  it('uses the native upsertOne path when the adapter declares the upsert capability', async () => {
    const store = new Map<string, Row>();
    const model = defineModel({
      name: 'item',
      tableName: 'items',
      schema: itemSchema,
      softDelete: true,
    });
    const base = fakeAdapter(store, { softDeleteField: 'deletedAt', native: true });
    const upsertOne = vi.fn(base.upsertOne!);
    base.upsertOne = upsertOne;
    const resource = defineResource('items', { model, adapter: base, upsert: { keys: ['email'] } });

    const result = await resource.execute(
      'batchUpsert',
      req({
        body: [
          { email: 'nat1@x', name: 'N1' },
          { email: 'nat2@x', name: 'N2' },
        ],
      }),
    );
    expect(result.status).toBe(200);
    expect(upsertOne).toHaveBeenCalledTimes(2);
    expect((result.body as { result: { createdCount: number } }).result.createdCount).toBe(2);
  });

  it('runs beforeBatchUpsert/afterBatchUpsert per item with index, threading replacements', async () => {
    const seen: Array<{ phase: string; index: number }> = [];
    const hooks: CrudHooks<Row> & HookModeConfig = {
      beforeBatchUpsert: (_ctx, item, index) => {
        seen.push({ phase: 'before', index });
        return { ...item, name: `${item.name as string}!` };
      },
      afterBatchUpsert: (_ctx, row, index) => {
        seen.push({ phase: 'after', index });
        return { ...row, tag: 'u' };
      },
    };
    const { resource } = makeResource({ ...upsertCfg, hooks });
    const result = await resource.execute(
      'batchUpsert',
      req({ body: [{ email: 'h@x', name: 'Hook' }] }),
    );
    expect(seen).toEqual([
      { phase: 'before', index: 0 },
      { phase: 'after', index: 0 },
    ]);
    const body = result.body as { result: { items: Array<{ data: Row }> } };
    expect(body.result.items[0].data.name).toBe('Hook!');
    expect(body.result.items[0].data.tag).toBe('u');
  });

  it('scopes the key match to the tenant (same-key row in another tenant does not match)', async () => {
    const { resource, store } = makeResource({ ...upsertCfg, model: { multiTenant: true } });
    store.set('a', { id: 'a', email: 'shared@x', name: 'Tenant1', tenantId: 't1' });

    const result = await resource.execute(
      'batchUpsert',
      req({ body: [{ email: 'shared@x', name: 'Tenant2' }], vars: { tenantId: 't2' } }),
    );
    const body = result.body as { result: { items: Array<{ data: Row; created: boolean }> } };
    expect(body.result.items[0].created).toBe(true);
    expect(body.result.items[0].data.tenantId).toBe('t2');
    expect(store.size).toBe(2);
  });

  it('accepts an empty array → 200 with an empty result (totalCount 0)', async () => {
    const { resource } = makeResource(upsertCfg);
    const result = await resource.execute('batchUpsert', req({ body: [] }));
    expect(result.status).toBe(200);
    const body = result.body as { result: { totalCount: number; items: unknown[] } };
    expect(body.result.totalCount).toBe(0);
    expect(body.result.items).toEqual([]);
  });

  it('rejects an over-limit batch with VALIDATION_ERROR 400', async () => {
    const { resource } = makeResource({ ...upsertCfg, batch: { maxBatchSize: 1 } });
    await expect(
      resource.execute(
        'batchUpsert',
        req({
          body: [
            { email: 'a@x', name: 'A' },
            { email: 'b@x', name: 'B' },
          ],
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
  });
});

// ===========================================================================
// bulkPatch — PATCH /bulk  (filters in body, flat response)
// ===========================================================================

describe('bulkPatch', () => {
  const seedGuests = (store: Map<string, Row>) => {
    store.set('carol', {
      id: 'carol',
      email: 'c@x',
      name: 'Carol',
      role: 'guest',
      age: 40,
      updatedAt: 1,
    });
    store.set('dave', {
      id: 'dave',
      email: 'd@x',
      name: 'Dave',
      role: 'guest',
      age: 50,
      deletedAt: 7,
    });
    store.set('alice', { id: 'alice', email: 'a@x', name: 'Alice', role: 'user', age: 35 });
  };

  it('patches only the visible filtered subset, never soft-deleted rows, bumping updatedAt', async () => {
    const { resource, store } = makeResource();
    seedGuests(store);

    const result = await resource.execute(
      'bulkPatch',
      req({ body: { filter: { role: 'guest' }, data: { age: 99 } } }),
    );
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ success: true, matched: 1, updated: 1, dryRun: false });
    expect(store.get('carol')!.age).toBe(99);
    expect(typeof store.get('carol')!.updatedAt).toBe('number');
    expect(store.get('carol')!.updatedAt).not.toBe(1);
    expect(store.get('dave')!.age).toBe(50); // soft-deleted → untouched
    expect(store.get('alice')!.age).toBe(35); // non-matching → untouched
  });

  it('dryRun=true reports the matched count without writing', async () => {
    const { resource, store } = makeResource();
    seedGuests(store);

    const result = await resource.execute(
      'bulkPatch',
      req({ query: { dryRun: 'true' }, body: { filter: { role: 'guest' }, data: { age: 77 } } }),
    );
    expect(result.body).toEqual({ success: true, matched: 1, updated: 0, dryRun: true });
    expect(store.get('carol')!.age).toBe(40); // untouched
  });

  it('rejects an empty data patch with EMPTY_BODY 400', async () => {
    const { resource } = makeResource();
    await expect(
      resource.execute('bulkPatch', req({ body: { filter: { role: 'guest' }, data: {} } })),
    ).rejects.toMatchObject({ statusCode: 400, code: 'EMPTY_BODY' });
  });

  it('returns matched:0 when nothing matches (no writes)', async () => {
    const { resource, store } = makeResource();
    seedGuests(store);
    const result = await resource.execute(
      'bulkPatch',
      req({ body: { filter: { role: 'nobody' }, data: { age: 1 } } }),
    );
    expect(result.body).toEqual({ success: true, matched: 0, updated: 0, dryRun: false });
  });

  it('rejects over maxBulkSize with BULK_TOO_LARGE 400', async () => {
    const { resource, store } = makeResource({ bulkPatch: { maxBulkSize: 1 } });
    store.set('a', { id: 'a', email: 'a@x', name: 'A', role: 'guest' });
    store.set('b', { id: 'b', email: 'b@x', name: 'B', role: 'guest' });
    await expect(
      resource.execute('bulkPatch', req({ body: { filter: { role: 'guest' }, data: { age: 1 } } })),
    ).rejects.toMatchObject({ statusCode: 400, code: 'BULK_TOO_LARGE' });
  });

  it('requires X-Confirm-Bulk at/above confirmThreshold, and proceeds once confirmed', async () => {
    const { resource, store } = makeResource({ bulkPatch: { confirmThreshold: 2 } });
    store.set('a', { id: 'a', email: 'a@x', name: 'A', role: 'guest' });
    store.set('b', { id: 'b', email: 'b@x', name: 'B', role: 'guest' });

    await expect(
      resource.execute('bulkPatch', req({ body: { filter: { role: 'guest' }, data: { age: 1 } } })),
    ).rejects.toMatchObject({ statusCode: 400, code: 'CONFIRMATION_REQUIRED' });

    const result = await resource.execute(
      'bulkPatch',
      req({
        body: { filter: { role: 'guest' }, data: { age: 1 } },
        request: withHeaders({ 'X-Confirm-Bulk': 'true' }),
      }),
    );
    expect(result.body).toEqual({ success: true, matched: 2, updated: 2, dryRun: false });
  });

  it('returns the patched records when returnRecords is enabled', async () => {
    const { resource, store } = makeResource({ bulkPatch: { returnRecords: true } });
    store.set('a', { id: 'a', email: 'a@x', name: 'A', role: 'guest', age: 1 });

    const result = await resource.execute(
      'bulkPatch',
      req({ body: { filter: { role: 'guest' }, data: { age: 9 } } }),
    );
    const body = result.body as {
      success: boolean;
      matched: number;
      updated: number;
      records: Row[];
    };
    expect(body.matched).toBe(1);
    expect(body.records).toHaveLength(1);
    expect(body.records[0].age).toBe(9);
  });

  it('uses the native updateWhere path when the adapter declares bulkPatch', async () => {
    const store = new Map<string, Row>();
    const model = defineModel({
      name: 'item',
      tableName: 'items',
      schema: itemSchema,
      softDelete: true,
    });
    const base = fakeAdapter(store, { softDeleteField: 'deletedAt', bulkPatch: true });
    const updateWhere = vi.fn(base.updateWhere!);
    base.updateWhere = updateWhere;
    const resource = defineResource('items', {
      model,
      adapter: base,
      filterFields: ['role'],
      bulkPatch: { returnRecords: true },
    });
    // A real SQL row carries the soft-delete column as NULL (not absent); the
    // native `updateWhere` path pushes a `deletedAt IS NULL` condition, which is
    // strict-null (SQL IS NULL) semantics.
    store.set('a', { id: 'a', email: 'a@x', name: 'A', role: 'guest', age: 1, deletedAt: null });
    store.set('gone', { id: 'gone', email: 'g@x', name: 'G', role: 'guest', deletedAt: 3 });

    const result = await resource.execute(
      'bulkPatch',
      req({ body: { filter: { role: 'guest' }, data: { age: 9 } } }),
    );
    expect(updateWhere).toHaveBeenCalledTimes(1);
    const body = result.body as { matched: number; updated: number; records: Row[] };
    expect(body.matched).toBe(1);
    expect(body.updated).toBe(1); // the soft-deleted row is excluded by the visibility filter
    expect(store.get('gone')!.age).toBeUndefined();
  });

  it('scopes matched rows to the request tenant', async () => {
    const { resource, store } = makeResource({
      model: { multiTenant: true },
      bulkPatch: { returnRecords: true },
    });
    store.set('a', { id: 'a', email: 'a@x', name: 'A', role: 'guest', tenantId: 't1' });
    store.set('b', { id: 'b', email: 'b@x', name: 'B', role: 'guest', tenantId: 't2' });

    const result = await resource.execute(
      'bulkPatch',
      req({ body: { filter: { role: 'guest' }, data: { age: 9 } }, vars: { tenantId: 't1' } }),
    );
    const body = result.body as { matched: number; updated: number; records: Row[] };
    expect(body.matched).toBe(1);
    expect(body.records[0].id).toBe('a');
    expect(store.get('b')!.age).toBeUndefined(); // other tenant untouched
  });
});
