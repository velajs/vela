import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AdapterScope, CrudAdapter } from '../../adapter/contract';
import type { ListQuery, Lookup, Page } from '../../adapter/query-types';
import { defineModel } from '../../model/define-model';
import { defineResource } from '../resource';

type Row = Record<string, unknown>;

/** Minimal fake: enough for create/read/update round-trips. */
function fakeAdapter(store: Map<string, Row>): CrudAdapter<Row> {
  const scope: AdapterScope = { tx: null };
  const find = (lookup: Lookup): Row | null => {
    for (const row of store.values()) {
      if (String(row[lookup.field]) === lookup.value) return row;
    }
    return null;
  };
  return {
    capabilities: new Set(),
    async transaction(fn) {
      return fn(scope);
    },
    async create(input) {
      const row = { ...input } as Row;
      store.set(String(row.id), row);
      return row;
    },
    async readOne(lookup) {
      return find(lookup);
    },
    async update(lookup, patch) {
      const existing = find(lookup);
      if (!existing) return null;
      const updated = { ...existing, ...patch };
      store.set(String(existing.id), updated);
      return updated;
    },
    async delete(lookup) {
      const existing = find(lookup);
      if (existing) store.delete(String(existing.id));
      return existing;
    },
    async list(_q: ListQuery): Promise<Page<Row>> {
      const rows = [...store.values()];
      return {
        result: rows,
        result_info: { page: 1, per_page: 20, has_next_page: false, has_prev_page: false },
      };
    },
  };
}

const baseSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
});

const tenantSchema = baseSchema.extend({
  // Tenant t1 has a REQUIRED custom field (the erpos custom-fields shape).
  custom1: z.string().min(1),
});

function makeResource(overrides: Record<string, unknown> = {}) {
  const store = new Map<string, Row>();
  const resolveSchema = vi.fn(({ tenantId }: { tenantId?: string }) =>
    tenantId === 't1' ? tenantSchema : baseSchema,
  );
  const model = defineModel({
    name: 'item',
    tableName: 'items',
    schema: baseSchema,
    timestamps: false,
    resolveSchema: resolveSchema as never,
  });
  const resource = defineResource('items', {
    model,
    adapter: fakeAdapter(store),
    ...(overrides as object),
  });
  return { store, resource, resolveSchema };
}

describe('Model.resolveSchema (per-tenant body schemas)', () => {
  it('create validates against the tenant-resolved schema', async () => {
    const { resource, resolveSchema } = makeResource();

    // t1 requires custom1 → missing it is a 400.
    await expect(
      resource.execute('create', { body: { name: 'A' }, vars: { tenantId: 't1' } }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });

    // t1 with custom1 → created and persisted.
    const created = await resource.execute('create', {
      body: { name: 'A', custom1: 'x' },
      vars: { tenantId: 't1' },
    });
    expect(created.status).toBe(201);
    expect((created.body as { result: Row }).result.custom1).toBe('x');

    // t2 resolves the base schema → no custom1 required (and stripped if sent).
    const other = await resource.execute('create', {
      body: { name: 'B', custom1: 'ignored' },
      vars: { tenantId: 't2' },
    });
    expect(other.status).toBe(201);
    expect((other.body as { result: Row }).result.custom1).toBeUndefined();

    expect(resolveSchema).toHaveBeenCalledWith({ tenantId: 't1' });
    expect(resolveSchema).toHaveBeenCalledWith({ tenantId: 't2' });
  });

  it("id: 'client' keeps the caller PK required through the tenant-resolved schema", async () => {
    const store = new Map<string, Row>();
    let resolved = 0;
    const model = defineModel({
      name: 'item',
      tableName: 'items',
      schema: baseSchema,
      timestamps: false,
      id: 'client',
      resolveSchema: () => {
        resolved += 1;
        return baseSchema;
      },
    });
    const resource = defineResource('items', { model, adapter: fakeAdapter(store) });

    // The re-derived body schema retains the PK, so a missing id is a 400.
    await expect(
      resource.execute('create', { body: { name: 'A' }, vars: { tenantId: 't1' } }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });

    const created = await resource.execute('create', {
      body: { id: 'client-1', name: 'A' },
      vars: { tenantId: 't1' },
    });
    expect(created.status).toBe(201);
    expect((created.body as { result: Row }).result.id).toBe('client-1');
    expect(store.get('client-1')).toBeDefined();
    expect(resolved).toBeGreaterThan(0);
  });

  it('update validates the patch against the tenant-resolved schema', async () => {
    const { resource, store } = makeResource();
    store.set('a', { id: 'a', name: 'A', custom1: 'x' });

    const updated = await resource.execute('update', {
      id: 'a',
      body: { custom1: 'y' },
      vars: { tenantId: 't1' },
    });
    expect((updated.body as { result: Row }).result.custom1).toBe('y');

    // For t2 the field is not in the schema → stripped, name still updatable.
    const stripped = await resource.execute('update', {
      id: 'a',
      body: { name: 'Z', custom1: 'nope' },
      vars: { tenantId: 't2' },
    });
    expect((stripped.body as { result: Row }).result.name).toBe('Z');
    expect((stripped.body as { result: Row }).result.custom1).toBe('y'); // unchanged
  });

  it("id: 'client' + a custom dto.create omitting the PK fails at definition time", () => {
    const model = defineModel({
      name: 'item',
      tableName: 'items',
      schema: baseSchema,
      timestamps: false,
      id: 'client',
    });
    expect(() =>
      defineResource('items', {
        model,
        adapter: fakeAdapter(new Map<string, Row>()),
        dto: { create: z.object({ name: z.string() }) },
      }),
    ).toThrow(/dto\.create to include the primary key/);
  });

  it('an explicit dto override wins and resolveSchema is not consulted', async () => {
    const dtoSchema = z.object({ name: z.string().min(3) });
    const { resource, resolveSchema } = makeResource({ dto: { create: dtoSchema } });

    await expect(
      resource.execute('create', { body: { name: 'ab' }, vars: { tenantId: 't1' } }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const ok = await resource.execute('create', {
      body: { name: 'abc', id: 'x1' },
      vars: { tenantId: 't1' },
    });
    expect(ok.status).toBe(201);
    expect(resolveSchema).not.toHaveBeenCalled();
  });
});
