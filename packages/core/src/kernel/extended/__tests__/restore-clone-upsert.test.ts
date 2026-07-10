import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AdapterCapability, AdapterScope, CrudAdapter } from '../../../adapter/contract';
import type { ListQuery, Lookup, Page, UpsertInput } from '../../../adapter/query-types';
import { defineModel } from '../../../model/define-model';
import { defineResource } from '../../resource';
import type { EngineRequest } from '../../engine-request';

type Row = Record<string, unknown>;

interface FakeOptions {
  /** Soft-delete column (enables softDelete + restore capabilities). */
  softDeleteField?: string;
  /** Declare + implement `upsertOne` (native upsert path). */
  native?: boolean;
  /** Force-OFF the restore capability even while soft-deleting (loud-error test). */
  restore?: boolean;
}

/**
 * In-test adapter over a Map — the extended-verb sibling of the one in
 * `../../__tests__/verbs.test.ts`, additionally implementing the `restore` and
 * `upsertOne` capability methods this family exercises.
 */
function fakeAdapter(store: Map<string, Row>, opts: FakeOptions = {}): CrudAdapter<Row> {
  const softDeleteField = opts.softDeleteField;
  const hasRestore = softDeleteField !== undefined && opts.restore !== false;
  const hasUpsert = opts.native === true;
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
        rows = rows.filter((r) => String(r[f.field]) === String(f.value));
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

  return adapter;
}

const itemSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().min(1),
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
    filterFields: ['qty', 'name', 'email'],
    ...(resourceOverrides as object),
  });
  return { store, model, adapter, resource };
}

const req = (partial: Partial<EngineRequest> = {}): EngineRequest => partial;

// ===========================================================================
// restore
// ===========================================================================

describe('restore', () => {
  it('un-deletes a soft-deleted row → 200 with the restored record (deletedAt cleared)', async () => {
    const { resource, store } = makeResource();
    store.set('a', { id: 'a', email: 'a@x', name: 'A', deletedAt: 123 });

    const result = await resource.execute('restore', req({ id: 'a' }));
    expect(result.status).toBe(200);
    const body = result.body as { success: boolean; result: Row };
    expect(body.success).toBe(true);
    expect(body.result.id).toBe('a');
    expect(body.result.deletedAt).toBeNull();
    expect(store.get('a')!.deletedAt).toBeNull();
  });

  it('404s when the target is not soft-deleted', async () => {
    const { resource, store } = makeResource();
    store.set('a', { id: 'a', email: 'a@x', name: 'A' });
    await expect(resource.execute('restore', req({ id: 'a' }))).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  });

  it('404s for a missing id', async () => {
    const { resource } = makeResource();
    await expect(resource.execute('restore', req({ id: 'zz' }))).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('scopes restore to the request tenant', async () => {
    const { resource, store } = makeResource({ model: { multiTenant: true } });
    store.set('a', { id: 'a', email: 'a@x', name: 'A', deletedAt: 5, tenantId: 't1' });

    await expect(
      resource.execute('restore', req({ id: 'a', vars: { tenantId: 't2' } })),
    ).rejects.toMatchObject({ statusCode: 404 });

    const ok = await resource.execute('restore', req({ id: 'a', vars: { tenantId: 't1' } }));
    expect(ok.status).toBe(200);
    expect(store.get('a')!.deletedAt).toBeNull();
  });

  it('throws a loud ConfigurationException when the model does not soft-delete', async () => {
    const { resource } = makeResource({}, false);
    await expect(resource.execute('restore', req({ id: 'a' }))).rejects.toMatchObject({
      statusCode: 500,
      code: 'CONFIGURATION_ERROR',
    });
  });

  it('throws a loud ConfigurationException when the adapter lacks the restore capability', async () => {
    const { resource, store } = makeResource({}, { softDeleteField: 'deletedAt', restore: false });
    store.set('a', { id: 'a', email: 'a@x', name: 'A', deletedAt: 9 });
    await expect(resource.execute('restore', req({ id: 'a' }))).rejects.toMatchObject({
      statusCode: 500,
      code: 'CONFIGURATION_ERROR',
    });
  });
});

// ===========================================================================
// clone
// ===========================================================================

describe('clone', () => {
  it('duplicates the source with a fresh id + timestamps → 201', async () => {
    const { resource, store } = makeResource();
    store.set('a', { id: 'a', email: 'a@x', name: 'Source', qty: 7, createdAt: 1, updatedAt: 1 });

    const result = await resource.execute('clone', req({ id: 'a' }));
    expect(result.status).toBe(201);
    const body = result.body as { success: boolean; result: Row };
    expect(body.success).toBe(true);
    expect(body.result.id).not.toBe('a');
    expect(typeof body.result.id).toBe('string');
    expect(body.result.name).toBe('Source');
    expect(body.result.qty).toBe(7);
    expect(body.result.createdAt).not.toBe(1);
    expect(store.size).toBe(2);
  });

  it('applies validated body overrides (invalid override → VALIDATION_ERROR 400)', async () => {
    const { resource, store } = makeResource();
    store.set('a', { id: 'a', email: 'a@x', name: 'Source', qty: 7 });

    const ok = await resource.execute('clone', req({ id: 'a', body: { name: 'Renamed' } }));
    expect((ok.body as { result: Row }).result.name).toBe('Renamed');
    expect((ok.body as { result: Row }).result.qty).toBe(7);

    await expect(
      resource.execute('clone', req({ id: 'a', body: { name: '' } })),
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
  });

  it('clears clone.fieldsToReset before the insert (override still wins)', async () => {
    const { resource, store } = makeResource({ clone: { fieldsToReset: ['qty'] } });
    store.set('a', { id: 'a', email: 'a@x', name: 'Source', qty: 7 });

    const reset = await resource.execute('clone', req({ id: 'a' }));
    expect((reset.body as { result: Row }).result.qty).toBeUndefined();

    const overridden = await resource.execute('clone', req({ id: 'a', body: { qty: 99 } }));
    expect((overridden.body as { result: Row }).result.qty).toBe(99);
  });

  it("id:'client': clone requires an id override (400 without; kept with)", async () => {
    const { resource, store } = makeResource({ model: { id: 'client' } });
    store.set('a', { id: 'a', email: 'a@x', name: 'Source', qty: 7 });

    // The engine strips the source PK and has no generator under id:'client',
    // so a clone without an id override is a caller input error.
    await expect(resource.execute('clone', req({ id: 'a' }))).rejects.toMatchObject({
      statusCode: 400,
    });

    const ok = await resource.execute('clone', req({ id: 'a', body: { id: 'clone-1' } }));
    expect(ok.status).toBe(201);
    expect((ok.body as { result: Row }).result.id).toBe('clone-1');
    expect(store.get('clone-1')).toBeDefined();
  });

  it('404s for a missing source and for a soft-deleted source', async () => {
    const { resource, store } = makeResource();
    store.set('gone', { id: 'gone', email: 'g@x', name: 'Gone', deletedAt: 4 });

    await expect(resource.execute('clone', req({ id: 'missing' }))).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(resource.execute('clone', req({ id: 'gone' }))).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('scopes the source read to the tenant and stamps the tenant on the clone', async () => {
    const { resource, store } = makeResource({ model: { multiTenant: true } });
    store.set('a', { id: 'a', email: 'a@x', name: 'Source', tenantId: 't1' });

    await expect(
      resource.execute('clone', req({ id: 'a', vars: { tenantId: 't2' } })),
    ).rejects.toMatchObject({ statusCode: 404 });

    const ok = await resource.execute('clone', req({ id: 'a', vars: { tenantId: 't1' } }));
    expect((ok.body as { result: Row }).result.tenantId).toBe('t1');
  });
});

// ===========================================================================
// upsert
// ===========================================================================

describe('upsert', () => {
  const upsertCfg = { upsert: { keys: ['email'] } };

  it('rejects nested-write payloads with a loud 400 (no dispatch seam)', async () => {
    const PostSchema = z.object({ id: z.string(), authorId: z.string().optional(), title: z.string() });
    const { resource } = makeResource({
      ...upsertCfg,
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
        'upsert',
        req({ body: { email: 'x@x', name: 'X', posts: [{ title: 'p' }] } }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws a loud ConfigurationException when upsert.keys is not configured', async () => {
    const { resource } = makeResource();
    await expect(
      resource.execute('upsert', req({ body: { email: 'x@x', name: 'X' } })),
    ).rejects.toMatchObject({ statusCode: 500, code: 'CONFIGURATION_ERROR' });
  });

  it('creates when no row matches the keys → 201 created:true', async () => {
    const { resource, store } = makeResource(upsertCfg);
    const result = await resource.execute(
      'upsert',
      req({ body: { email: 'new@x', name: 'New', qty: 2 } }),
    );
    expect(result.status).toBe(201);
    const body = result.body as { success: boolean; result: Row; created: boolean };
    expect(body.success).toBe(true);
    expect(body.created).toBe(true);
    expect(body.result.email).toBe('new@x');
    expect(typeof body.result.id).toBe('string');
    expect(typeof body.result.createdAt).toBe('number');
    expect(store.size).toBe(1);
  });

  it('updates in place when a row matches the keys → 200 created:false (same id)', async () => {
    const { resource, store } = makeResource(upsertCfg);
    store.set('a', { id: 'a', email: 'dup@x', name: 'Old', createdAt: 1 });

    const result = await resource.execute(
      'upsert',
      req({ body: { email: 'dup@x', name: 'Fresh' } }),
    );
    expect(result.status).toBe(200);
    const body = result.body as { result: Row; created: boolean };
    expect(body.created).toBe(false);
    expect(body.result.id).toBe('a');
    expect(body.result.name).toBe('Fresh');
    expect(typeof body.result.updatedAt).toBe('number');
    expect(store.size).toBe(1);
  });

  it("id:'client': update leg keeps the matched row's PK; insert leg uses the body id", async () => {
    const { resource, store } = makeResource({ model: { id: 'client' }, ...upsertCfg });
    store.set('right', { id: 'right', email: 'a@x', name: 'Old' });

    const updated = await resource.execute(
      'upsert',
      req({ body: { id: 'wrong', email: 'a@x', name: 'New' } }),
    );
    expect(updated.status).toBe(200);
    const updatedBody = updated.body as { result: Row; created: boolean };
    expect(updatedBody.created).toBe(false);
    expect(updatedBody.result.id).toBe('right');
    expect(store.get('right')?.name).toBe('New');
    expect(store.get('wrong')).toBeUndefined();

    const inserted = await resource.execute(
      'upsert',
      req({ body: { id: 'fresh', email: 'b@x', name: 'B' } }),
    );
    expect(inserted.status).toBe(201);
    const insertedBody = inserted.body as { result: Row; created: boolean };
    expect(insertedBody.created).toBe(true);
    expect(insertedBody.result.id).toBe('fresh');
    expect(store.get('fresh')).toBeDefined();
  });

  it('match-and-restore: matching a soft-deleted row restores + updates it (created:false, 200)', async () => {
    const { resource, store } = makeResource(upsertCfg);
    store.set('a', { id: 'a', email: 'phoenix@x', name: 'Old', deletedAt: 999 });

    const result = await resource.execute(
      'upsert',
      req({ body: { email: 'phoenix@x', name: 'Reborn' } }),
    );
    expect(result.status).toBe(200);
    const body = result.body as { result: Row; created: boolean };
    expect(body.created).toBe(false);
    expect(body.result.id).toBe('a');
    expect(body.result.deletedAt).toBeNull();
    expect(body.result.name).toBe('Reborn');
    // Exactly one row with that email — restored in place, not duplicated.
    expect(Array.from(store.values()).filter((r) => r.email === 'phoenix@x')).toHaveLength(1);
  });

  it('runs beforeUpsert(isCreate) and afterUpsert(created), threading their return values', async () => {
    const seen: Array<{ phase: string; flag: boolean }> = [];
    const { resource } = makeResource({
      ...upsertCfg,
      hooks: {
        beforeUpsert: (_ctx: unknown, data: Row, isCreate: boolean) => {
          seen.push({ phase: 'before', flag: isCreate });
          return { ...data, name: `${data.name as string}!` };
        },
        afterUpsert: (_ctx: unknown, record: Row, created: boolean) => {
          seen.push({ phase: 'after', flag: created });
          return { ...record, tag: 'hooked' };
        },
      },
    });

    const result = await resource.execute('upsert', req({ body: { email: 'h@x', name: 'Hook' } }));
    expect(seen).toEqual([
      { phase: 'before', flag: true },
      { phase: 'after', flag: true },
    ]);
    const body = result.body as { result: Row };
    expect(body.result.name).toBe('Hook!');
    expect(body.result.tag).toBe('hooked');
  });

  it('scopes the key match to the tenant (a same-key row in another tenant does not match)', async () => {
    const { resource, store } = makeResource({ ...upsertCfg, model: { multiTenant: true } });
    store.set('a', { id: 'a', email: 'shared@x', name: 'Tenant1', tenantId: 't1' });

    const result = await resource.execute(
      'upsert',
      req({ body: { email: 'shared@x', name: 'Tenant2' }, vars: { tenantId: 't2' } }),
    );
    expect(result.status).toBe(201);
    const body = result.body as { result: Row; created: boolean };
    expect(body.created).toBe(true);
    expect(body.result.tenantId).toBe('t2');
    expect(store.size).toBe(2);
  });

  it('rejects an invalid body with VALIDATION_ERROR 400', async () => {
    const { resource } = makeResource(upsertCfg);
    await expect(
      resource.execute('upsert', req({ body: { email: 'x@x', name: '' } })),
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
  });

  it('uses the native upsertOne path when the adapter declares the upsert capability', async () => {
    const upsertOne = vi.fn();
    const store = new Map<string, Row>();
    const model = defineModel({
      name: 'item',
      tableName: 'items',
      schema: itemSchema,
      softDelete: true,
    });
    const base = fakeAdapter(store, { softDeleteField: 'deletedAt', native: true });
    const nativeUpsertOne = base.upsertOne!;
    base.upsertOne = async (input, scope) => {
      upsertOne(input);
      return nativeUpsertOne(input, scope);
    };
    const resource = defineResource('items', { model, adapter: base, upsert: { keys: ['email'] } });

    const createRes = await resource.execute(
      'upsert',
      req({ body: { email: 'nat@x', name: 'Native' } }),
    );
    expect(createRes.status).toBe(201);
    expect((createRes.body as { created: boolean }).created).toBe(true);
    expect(upsertOne).toHaveBeenCalledTimes(1);

    const updateRes = await resource.execute(
      'upsert',
      req({ body: { email: 'nat@x', name: 'Native 2' } }),
    );
    expect(updateRes.status).toBe(200);
    const updated = updateRes.body as { result: Row; created: boolean };
    expect(updated.created).toBe(false);
    expect(updated.result.name).toBe('Native 2');
    expect(store.size).toBe(1);
  });
});
