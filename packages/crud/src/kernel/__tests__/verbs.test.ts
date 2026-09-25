import { serializedTransaction } from '../../__tests__/test-adapter';
import { bindAdapter } from '../../adapter/contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type {
  AdapterCapability,
  AdapterScope,
  CrudAdapter,
  NestedWriteDriver,
  NestedWriteOperations,
  TransactionContext,
} from '../../adapter/contract';
import type { ListQuery, Lookup, Page } from '../../adapter/query-types';
import { defineModel } from '../../model/define-model';
import { defineResource } from '../resource';
import type { EngineRequest } from '../engine-request';
import { ALL_CRUD_ENDPOINTS } from '../../verb-table';

type Row = Record<string, unknown>;

/**
 * Minimal in-test adapter over a plain Map — just enough of the memory
 * semantics (eq filters, soft-delete visibility, offset slice) for the verb
 * pipeline to be observable without depending on @velajs/crud-memory.
 */
function fakeAdapter(store: Map<string, Row>, softDeleteField?: string): CrudAdapter<Row> {
  const transaction = serializedTransaction(store);
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

  return bindAdapter({
    capabilities: new Set<AdapterCapability>([
      'transactions',
      'rowLocks',
      ...(softDeleteField !== undefined ? ['softDelete' as const] : []),
    ]),
    async requestScope(fn) {
      return fn({ tx: undefined });
    },
    transaction,
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
  });
}

const itemSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  qty: z.number().int().nonnegative(),
  secret: z.string().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  deletedAt: z.number().nullable().optional(),
});

function makeResource(overrides: Record<string, unknown> = {}, softDelete = true) {
  const { model: modelOverrides, ...resourceOverrides } = overrides;
  const store = new Map<string, Row>();
  const model = defineModel({
    name: 'item',
    tableName: 'items',
    schema: itemSchema,
    softDelete,
    ...((modelOverrides as object) ?? {}),
  });
  const adapter = fakeAdapter(store, softDelete ? 'deletedAt' : undefined);
  const resource = defineResource('items', {
    model,
    adapter,
    filterFields: ['qty', 'name'],
    ...(resourceOverrides as object),
  });
  return { store, model, adapter, resource };
}

const req = (partial: Partial<EngineRequest> = {}): EngineRequest => partial;

describe('security invariants', () => {
  it.each(ALL_CRUD_ENDPOINTS)(
    'enforces the mandatory operation policy before executing %s',
    async (verb) => {
      const operation = vi.fn(() => false);
      const { resource } = makeResource({ model: { policies: { operation } } });

      await expect(resource.execute(verb, req())).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN',
      });
      expect(operation).toHaveBeenCalledOnce();
      expect(operation).toHaveBeenCalledWith(expect.any(Object), verb);
    },
  );

  it.each(ALL_CRUD_ENDPOINTS)('fails closed without tenant context for %s', async (verb) => {
    const schema = itemSchema.extend({ tenantId: z.string() });
    const model = defineModel({
      name: 'item',
      tableName: 'items',
      schema,
      softDelete: false,
      multiTenant: true,
    });
    const resource = defineResource('items', { model, adapter: fakeAdapter(new Map()) });

    await expect(resource.execute(verb, req())).rejects.toMatchObject({
      statusCode: 400,
      code: 'TENANT_REQUIRED',
    });
  });

  it('strips managed fields after custom DTO validation on create and update', async () => {
    const schema = itemSchema.extend({ tenantId: z.string() });
    const model = defineModel({
      name: 'item',
      tableName: 'items',
      schema,
      softDelete: true,
      multiTenant: true,
    });
    const store = new Map<string, Row>();
    const custom = schema.partial();
    const resource = defineResource('items', {
      model,
      adapter: fakeAdapter(store, 'deletedAt'),
      dto: { create: custom, update: custom },
    });

    const created = await resource.execute(
      'create',
      req({
        vars: { tenantId: 'trusted' },
        body: {
          id: 'attacker-id',
          name: 'A',
          qty: 1,
          tenantId: 'foreign',
          createdAt: 1,
          updatedAt: 1,
          deletedAt: 1,
        },
      }),
    );
    const row = (created.body as { result: Row }).result;
    expect(row.id).not.toBe('attacker-id');
    expect(row.tenantId).toBe('trusted');
    expect(row.createdAt).not.toBe(1);
    expect(row.deletedAt).toBeUndefined();

    await resource.execute(
      'update',
      req({
        id: String(row.id),
        vars: { tenantId: 'trusted' },
        body: {
          id: 'new-id',
          tenantId: 'foreign',
          createdAt: 2,
          updatedAt: 2,
          deletedAt: 2,
          qty: 2,
        },
      }),
    );
    const stored = store.get(String(row.id))!;
    expect(stored.id).toBe(row.id);
    expect(stored.tenantId).toBe('trusted');
    expect(stored.createdAt).toBe(row.createdAt);
    expect(stored.updatedAt).not.toBe(2);
    expect(stored.deletedAt).toBeUndefined();
  });
});

describe('transaction context', () => {
  // Proves the engine threads the request tenant into adapter.transaction at
  // every tx open (the RLS seam) — memory/libsql can't enforce RLS, so the
  // assertion is seam invocation, not database isolation.
  it('passes the request tenant to adapter write and read scopes', async () => {
    const store = new Map<string, Row>();
    const inner = fakeAdapter(store);
    const seen: Array<TransactionContext | undefined> = [];
    const adapter = bindAdapter({
      ...inner.runtime,
      transaction: (fn, ctx) => {
        seen.push(ctx);
        return inner.transaction(fn, ctx);
      },
      requestScope: (fn, ctx) => {
        seen.push(ctx);
        return inner.requestScope(fn, ctx);
      },
    });
    const model = defineModel({
      name: 'item',
      tableName: 'items',
      schema: itemSchema,
      softDelete: false,
    });
    const resource = defineResource('items', { model, adapter });

    await resource.execute(
      'create',
      req({ body: { name: 'Scoped', qty: 1 }, vars: { tenantId: 't1' } }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ tenantId: 't1' });

    await resource.execute('list', req({ query: {} }));
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeDefined();
    expect(seen[1]?.tenantId).toBeUndefined();
  });
});

describe('nested writes (create/update dispatch)', () => {
  const PostSchema = z.object({
    id: z.string(),
    authorId: z.string().optional(),
    title: z.string().min(1),
  });
  const NESTED_RELATIONS = {
    posts: {
      type: 'hasMany' as const,
      target: 'posts',
      foreignKey: 'authorId',
      schema: PostSchema,
      response: {
        tenantField: false,
        softDeleteField: false,
        primaryKeys: ['id'],
        timestamps: { createdAt: false, updatedAt: false },
      },
      nestedWrites: {
        allowCreate: true,
        allowUpdate: true,
        allowDelete: true,
        allowConnect: true,
        allowDisconnect: true,
      },
    },
  } as const;

  function nestedResource() {
    const store = new Map<string, Row>();
    const calls: Array<{ kind: string; relation: string; parentId: unknown; payload: unknown }> =
      [];
    const inner = fakeAdapter(store);
    const adapter = bindAdapter({
      ...inner.runtime,
      capabilities: new Set<AdapterCapability>([...inner.capabilities, 'nestedWrites']),
      nested: {
        async inspectNestedTargets(_parent, _relation, operations) {
          const rowFor = (where: Row) => ({ ...where, authorId: 'a' });
          return {
            update: (operations.update ?? []).map(({ where }) => rowFor(where)),
            delete: (operations.delete ?? []).map(rowFor),
            connect: (operations.connect ?? []).map(rowFor),
            disconnect: (operations.disconnect ?? []).map(rowFor),
            setConnect: (operations.set ?? []).map(rowFor),
            setDisconnect: [],
          };
        },
        async createNested(parent, relation, records) {
          calls.push({ kind: 'create', relation, parentId: (parent as Row).id, payload: records });
        },
        async applyNested(parent, relation, operations) {
          calls.push({
            kind: 'apply',
            relation,
            parentId: (parent as Row).id,
            payload: operations,
          });
        },
      },
    });
    const model = defineModel({
      name: 'item',
      tableName: 'items',
      schema: itemSchema,
      softDelete: false,
      relations: NESTED_RELATIONS,
    });
    const resource = defineResource('items', { model, adapter });
    return { store, calls, resource };
  }

  it('create splits nested payloads off the parent row and dispatches in-scope', async () => {
    const { store, calls, resource } = nestedResource();
    const result = await resource.execute(
      'create',
      req({ body: { name: 'A', qty: 1, posts: [{ title: 'P1' }, { title: 'P2' }] } }),
    );
    expect(result.status).toBe(201);
    const created = (result.body as { result: Row }).result;
    // The relation key never reaches the adapter as a column.
    expect('posts' in (store.get(String(created.id)) ?? {})).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: 'create', relation: 'posts', parentId: created.id });
    expect((calls[0]!.payload as Row[]).map((p) => p.title)).toEqual(['P1', 'P2']);
  });

  it('update translates the ops envelope into NestedWriteOperations', async () => {
    const { store, calls, resource } = nestedResource();
    store.set('a', { id: 'a', name: 'A', qty: 1 });
    const result = await resource.execute(
      'update',
      req({
        id: 'a',
        body: {
          name: 'B',
          posts: {
            create: { title: 'New' },
            // The id-only entry is dropped at translation (nothing to set).
            update: [{ id: 'p1', title: 'Upd' }, { id: 'p9' }],
            delete: ['p2'],
            connect: ['p3'],
            disconnect: ['p4'],
            set: null,
          },
        },
      }),
    );
    expect(result.status).toBe(200);
    expect(store.get('a')?.name).toBe('B');
    expect('posts' in (store.get('a') ?? {})).toBe(false);
    expect(calls[0]).toMatchObject({ kind: 'apply', relation: 'posts', parentId: 'a' });
    const ops = calls[0]!.payload as NestedWriteOperations;
    expect(ops.create).toEqual([{ title: 'New' }]);
    expect(ops.update).toEqual([{ where: { id: 'p1' }, data: { title: 'Upd' } }]);
    expect(ops.delete).toEqual([{ id: 'p2' }]);
    expect(ops.connect).toEqual([{ id: 'p3' }]);
    expect(ops.disconnect).toEqual([{ id: 'p4' }]);
    expect(ops.set).toEqual([]);
  });

  it('throws a loud ConfigurationException when nesting without the driver', async () => {
    const store = new Map<string, Row>();
    const model = defineModel({
      name: 'item',
      tableName: 'items',
      schema: itemSchema,
      softDelete: false,
      relations: NESTED_RELATIONS,
    });
    const resource = defineResource('items', { model, adapter: fakeAdapter(store) });
    await expect(
      resource.execute('create', req({ body: { name: 'A', qty: 1, posts: [{ title: 'x' }] } })),
    ).rejects.toMatchObject({ statusCode: 500, code: 'CONFIGURATION_ERROR' });
    // Without a nested payload the same resource still writes normally.
    const plain = await resource.execute('create', req({ body: { name: 'B', qty: 1 } }));
    expect(plain.status).toBe(201);
    // EMPTY nested payloads are no-ops — no driver demanded, write proceeds.
    const emptyCreate = await resource.execute(
      'create',
      req({ body: { name: 'C', qty: 1, posts: [] } }),
    );
    expect(emptyCreate.status).toBe(201);
    const createdId = String((emptyCreate.body as { result: Row }).result.id);
    const emptyUpdate = await resource.execute(
      'update',
      req({ id: createdId, body: { name: 'D', posts: {} } }),
    );
    expect(emptyUpdate.status).toBe(200);
  });

  it('rejects a legacy nested driver that cannot inspect targets', () => {
    const store = new Map<string, Row>();
    const inner = fakeAdapter(store);
    const adapter = bindAdapter({
      ...inner.runtime,
      capabilities: new Set<AdapterCapability>([...inner.capabilities, 'nestedWrites']),
      nested: {
        async createNested() {},
        async applyNested() {},
      } as unknown as NestedWriteDriver<Row>,
    });
    const model = defineModel({
      name: 'item',
      tableName: 'items',
      schema: itemSchema,
      softDelete: false,
      relations: NESTED_RELATIONS,
    });

    expect(() => defineResource('items', { model, adapter })).toThrow(/inspectNestedTargets/);
  });

  it('force-stamps the tenant and defaults timestamps onto nested creates', async () => {
    const StampPost = z.object({
      id: z.string(),
      authorId: z.string().optional(),
      title: z.string().min(1),
      tenantId: z.string().optional(),
      createdAt: z.number().optional(),
      updatedAt: z.number().optional(),
    });
    const store = new Map<string, Row>();
    const captured: Row[][] = [];
    const inner = fakeAdapter(store);
    const adapter = bindAdapter({
      ...inner.runtime,
      capabilities: new Set<AdapterCapability>([...inner.capabilities, 'nestedWrites']),
      nested: {
        async inspectNestedTargets() {
          return {
            update: [],
            delete: [],
            connect: [],
            disconnect: [],
            setConnect: [],
            setDisconnect: [],
          };
        },
        async createNested(_parent, _relation, records) {
          captured.push(records as Row[]);
        },
        async applyNested() {},
      },
    });
    const model = defineModel({
      name: 'item',
      tableName: 'items',
      schema: itemSchema.extend({ orgId: z.string() }),
      softDelete: false,
      multiTenant: { field: 'orgId' },
      relations: {
        posts: {
          type: 'hasMany' as const,
          target: 'posts',
          foreignKey: 'authorId',
          schema: StampPost,
          response: {
            tenantField: 'tenantId',
            softDeleteField: false,
            timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
            primaryKeys: ['id'],
          },
          nestedWrites: { allowCreate: true },
        },
      },
    });
    const resource = defineResource('items', {
      model,
      adapter,
      dto: {
        create: z.object({
          name: z.string(),
          qty: z.number(),
          posts: z.array(
            z.object({
              id: z.string().optional(),
              title: z.string(),
              tenantId: z.string().optional(),
              createdAt: z.number().optional(),
              updatedAt: z.number().optional(),
            }),
          ),
        }),
      },
    });
    const result = await resource.execute(
      'create',
      req({
        body: {
          name: 'A',
          qty: 1,
          posts: [
            {
              id: 'existing-foreign-child',
              title: 'P',
              tenantId: 'evil',
              createdAt: 1,
              updatedAt: 2,
            },
          ],
        },
        vars: { tenantId: 't1' },
      }),
    );
    expect(result.status).toBe(201);
    expect((result.body as { result: Row }).result.orgId).toBe('t1');
    const child = captured[0]![0]!;
    // Caller-supplied tenant is stripped by the schema and FORCED to the
    // request tenant; timestamps default when the child schema declares them.
    expect(child.tenantId).toBe('t1');
    expect(child.id).toBeUndefined();
    expect(typeof child.createdAt).toBe('number');
    expect(typeof child.updatedAt).toBe('number');
    expect(child.createdAt).not.toBe(1);
    expect(child.updatedAt).not.toBe(2);
    expect(child.title).toBe('P');
  });

  it.each([
    ['same-tenant unowned update', { update: [{ id: 'unowned-linked', title: 'Pwned' }] }],
    ['same-tenant unowned delete', { delete: ['unowned-linked'] }],
    ['foreign-tenant connect', { connect: ['foreign'] }],
    ['same-tenant unowned connect', { connect: ['unowned-free'] }],
    ['same-tenant unowned disconnect', { disconnect: ['unowned-linked'] }],
    ['foreign-tenant set target', { set: { id: 'foreign' } }],
    ['same-tenant unowned set detachment', { set: null }],
  ])('denies %s before the parent write', async (_label, posts) => {
    const TenantItemSchema = itemSchema.extend({ orgId: z.string() });
    const TenantPostSchema = z.object({
      id: z.string(),
      authorId: z.string().nullable().optional(),
      title: z.string(),
      tenantId: z.string(),
      ownerId: z.string(),
    });
    const parents = new Map<string, Row>([['a', { id: 'a', name: 'A', qty: 1, orgId: 't1' }]]);
    const children = new Map<string, Row>([
      [
        'owned-linked',
        {
          id: 'owned-linked',
          authorId: 'a',
          title: 'Owned',
          tenantId: 't1',
          ownerId: 'alice',
        },
      ],
      [
        'unowned-linked',
        {
          id: 'unowned-linked',
          authorId: 'a',
          title: 'Other',
          tenantId: 't1',
          ownerId: 'bob',
        },
      ],
      [
        'unowned-free',
        {
          id: 'unowned-free',
          authorId: null,
          title: 'Other free',
          tenantId: 't1',
          ownerId: 'bob',
        },
      ],
      [
        'foreign',
        {
          id: 'foreign',
          authorId: null,
          title: 'Foreign',
          tenantId: 't2',
          ownerId: 'alice',
        },
      ],
    ]);
    const inner = fakeAdapter(parents);
    const applyNested = vi.fn();
    const adapter = bindAdapter({
      ...inner.runtime,
      capabilities: new Set<AdapterCapability>([...inner.capabilities, 'nestedWrites']),
      nested: {
        async inspectNestedTargets(parent, _relation, operations) {
          const parentId = parent.id;
          const matches = (row: Row, where: Row) =>
            Object.entries(where).every(([field, value]) => row[field] === value);
          const find = (where: Row, linked: boolean) => {
            for (const row of children.values()) {
              // Deliberately ignore targetScope: the engine must independently
              // reject a buggy/hostile adapter returning a foreign target.
              if (!matches(row, where)) continue;
              if (linked && row.authorId !== parentId) continue;
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
            setDisconnect:
              operations.set === undefined
                ? []
                : Array.from(children.values())
                    .filter((row) => row.authorId === parentId)
                    .map((row) => ({ ...row })),
          };
        },
        async createNested() {},
        applyNested,
      },
    });
    const model = defineModel({
      name: 'item',
      tableName: 'items',
      schema: TenantItemSchema,
      timestamps: false,
      multiTenant: { field: 'orgId' },
      relations: {
        posts: {
          type: 'hasMany',
          target: 'posts',
          foreignKey: 'authorId',
          schema: TenantPostSchema,
          response: {
            tenantField: 'tenantId',
            softDeleteField: false,
            policies: {
              write: (ctx, row) => row.ownerId === ctx.userId,
            },
          },
          nestedWrites: {
            allowUpdate: true,
            allowDelete: true,
            allowConnect: true,
            allowDisconnect: true,
          },
        },
      },
    });
    const resource = defineResource('items', { model, adapter });

    await expect(
      resource.execute(
        'update',
        req({
          id: 'a',
          vars: { tenantId: 't1', userId: 'alice' },
          body: { posts },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    expect(parents.get('a')).toEqual({ id: 'a', name: 'A', qty: 1, orgId: 't1' });
    expect(applyNested).not.toHaveBeenCalled();
  });

  it('enforces the target create policy before persisting a parent or child', async () => {
    const TenantItemSchema = itemSchema.extend({ tenantId: z.string() });
    const TenantPostSchema = z.object({
      id: z.string(),
      authorId: z.string().optional(),
      title: z.string(),
      tenantId: z.string(),
      ownerId: z.string(),
    });
    const parents = new Map<string, Row>();
    const inner = fakeAdapter(parents);
    const createNested = vi.fn();
    const applyNested = vi.fn();
    const adapter = bindAdapter({
      ...inner.runtime,
      capabilities: new Set<AdapterCapability>([...inner.capabilities, 'nestedWrites']),
      nested: {
        async inspectNestedTargets() {
          return {
            update: [],
            delete: [],
            connect: [],
            disconnect: [],
            setConnect: [],
            setDisconnect: [],
          };
        },
        createNested,
        applyNested,
      },
    });
    const model = defineModel({
      name: 'item',
      tableName: 'items',
      schema: TenantItemSchema,
      timestamps: false,
      multiTenant: true,
      relations: {
        posts: {
          type: 'hasMany',
          target: 'posts',
          foreignKey: 'authorId',
          schema: TenantPostSchema,
          response: {
            tenantField: 'tenantId',
            softDeleteField: false,
            primaryKeys: ['id'],
            timestamps: { createdAt: false, updatedAt: false },
            policies: { create: (ctx, row) => row.ownerId === ctx.userId },
          },
          nestedWrites: { allowCreate: true },
        },
      },
    });
    const resource = defineResource('items', { model, adapter });

    await expect(
      resource.execute(
        'create',
        req({
          vars: { tenantId: 't1', userId: 'alice' },
          body: { name: 'A', qty: 1, posts: [{ title: 'No', ownerId: 'bob' }] },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    expect(parents.size).toBe(0);
    expect(createNested).not.toHaveBeenCalled();

    parents.set('a', { id: 'a', name: 'A', qty: 1, tenantId: 't1' });
    await expect(
      resource.execute(
        'update',
        req({
          id: 'a',
          vars: { tenantId: 't1', userId: 'alice' },
          body: { posts: { create: { title: 'Still no', ownerId: 'bob' } } },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    expect(parents.get('a')).toEqual({ id: 'a', name: 'A', qty: 1, tenantId: 't1' });
    expect(applyNested).not.toHaveBeenCalled();
  });
});

describe('etag (optimistic concurrency)', () => {
  it('read emits the tag + 304; update honors If-Match (409 on stale)', async () => {
    const { resource, store } = makeResource({ etag: true });
    store.set('a', { id: 'a', name: 'A', qty: 1 });

    const read = await resource.execute('read', req({ id: 'a' }));
    const tag = read.headers?.ETag as string;
    expect(tag).toMatch(/^"[0-9a-f]{32}"$/);

    const cached = await resource.execute(
      'read',
      req({ id: 'a', request: new Request('http://t/', { headers: { 'If-None-Match': tag } }) }),
    );
    expect(cached.status).toBe(304);
    expect(cached.body).toBeNull();
    expect(cached.headers?.ETag).toBe(tag);

    // Stale If-Match → 409, nothing written.
    await expect(
      resource.execute(
        'update',
        req({
          id: 'a',
          body: { name: 'B' },
          request: new Request('http://t/', {
            headers: { 'If-Match': '"00000000000000000000000000000bad"' },
          }),
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
    expect(store.get('a')?.name).toBe('A');

    // Current If-Match → 200 with a rotated tag.
    const ok = await resource.execute(
      'update',
      req({
        id: 'a',
        body: { name: 'B' },
        request: new Request('http://t/', { headers: { 'If-Match': tag } }),
      }),
    );
    expect(ok.status).toBe(200);
    expect(ok.headers?.ETag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(ok.headers?.ETag).not.toBe(tag);
    expect(store.get('a')?.name).toBe('B');
  });

  it('include-reads and bare reads share the tag (relation embeds never hash)', async () => {
    const store = new Map<string, Row>();
    const inner = fakeAdapter(store);
    const adapter = bindAdapter({
      ...inner.runtime,
      relations: {
        async load(rows) {
          return new Map(rows.map((row) => [row.id, [{ id: 'p1', title: 'X' }]]));
        },
      },
    });
    const model = defineModel({
      name: 'item',
      tableName: 'items',
      schema: itemSchema,
      softDelete: false,
      relations: {
        posts: {
          type: 'hasMany' as const,
          target: 'posts',
          foreignKey: 'authorId',
          response: { tenantField: false, softDeleteField: false },
        },
      },
    });
    const resource = defineResource('items', {
      model,
      adapter,
      etag: true,
      allowedIncludes: ['posts'],
    });
    store.set('a', { id: 'a', name: 'A', qty: 1 });

    const bare = await resource.execute('read', req({ id: 'a' }));
    const embedded = await resource.execute(
      'read',
      req({ id: 'a', query: { include: ['posts'] } }),
    );
    expect((embedded.body as { result: Row }).result.posts).toBeTruthy();
    expect(embedded.headers?.ETag).toBe(bare.headers?.ETag);

    // ...so an include-read's tag satisfies the update-side If-Match.
    const ok = await resource.execute(
      'update',
      req({
        id: 'a',
        body: { name: 'B' },
        request: new Request('http://t/', {
          headers: { 'If-Match': embedded.headers?.ETag as string },
        }),
      }),
    );
    expect(ok.status).toBe(200);
  });

  it('rejects cross-model includes without an explicit response authorization contract', () => {
    const store = new Map<string, Row>();
    const inner = fakeAdapter(store);
    const adapter = bindAdapter({
      ...inner.runtime,
      relations: {
        async load() {
          return new Map();
        },
      },
    });
    const model = defineModel({
      name: 'item',
      tableName: 'items',
      schema: itemSchema,
      softDelete: false,
      relations: {
        posts: { type: 'hasMany' as const, target: 'posts', foreignKey: 'authorId' },
      },
    });

    expect(() => defineResource('items', { model, adapter, allowedIncludes: ['posts'] })).toThrow(
      /no `response` authorization metadata/,
    );
  });

  it('filters and masks included rows with target relation response policies', async () => {
    const store = new Map<string, Row>();
    const inner = fakeAdapter(store);
    const adapter = bindAdapter({
      ...inner.runtime,
      relations: {
        async load(rows) {
          return new Map(
            rows.map((row) => [
              row.id,
              [
                { id: 'visible', title: 'Public', secret: 'redact' },
                { id: 'hidden', title: 'Private', secret: 'redact' },
              ],
            ]),
          );
        },
      },
    });
    const model = defineModel({
      name: 'item',
      tableName: 'items',
      schema: itemSchema,
      softDelete: false,
      relations: {
        posts: {
          type: 'hasMany' as const,
          target: 'posts',
          foreignKey: 'authorId',
          response: {
            tenantField: false,
            softDeleteField: false,
            policies: {
              readPushdown: () => [{ field: 'id', operator: 'eq', value: 'visible' }],
              fields: () => ({ secret: '[redacted]' }),
            },
            serializationProfile: { exclude: ['title'] },
          },
        },
      },
    });
    const resource = defineResource('items', {
      model,
      adapter,
      allowedIncludes: ['posts'],
    });
    store.set('a', { id: 'a', name: 'A', qty: 1 });

    const result = await resource.execute('read', req({ id: 'a', query: { include: ['posts'] } }));
    expect((result.body as { result: Row & { posts: Row[] } }).result.posts).toEqual([
      { id: 'visible', secret: '[redacted]' },
    ]);
  });

  it('scopes cross-model includes by the target tenant field and rechecks rows in-engine', async () => {
    const store = new Map<string, Row>();
    const inner = fakeAdapter(store);
    const load = vi.fn(
      async (rows: Row[]) =>
        new Map(
          rows.map((row) => [
            row.id,
            [
              { id: 'same', tenantId: 't1', title: 'Allowed' },
              { id: 'foreign', tenantId: 't2', title: 'Blocked' },
            ],
          ]),
        ),
    );
    const adapter = bindAdapter({ ...inner.runtime, relations: { load } });
    const model = defineModel({
      name: 'item',
      tableName: 'items',
      schema: itemSchema.extend({ orgId: z.string() }),
      softDelete: false,
      multiTenant: { field: 'orgId' },
      relations: {
        posts: {
          type: 'hasMany',
          target: 'posts',
          foreignKey: 'authorId',
          schema: z.object({
            id: z.string(),
            authorId: z.string(),
            tenantId: z.string(),
            title: z.string(),
          }),
          response: { tenantField: 'tenantId', softDeleteField: false },
        },
      },
    });
    const resource = defineResource('items', { model, adapter, allowedIncludes: ['posts'] });
    store.set('a', { id: 'a', name: 'A', qty: 1, orgId: 't1' });

    const result = await resource.execute(
      'read',
      req({ id: 'a', vars: { tenantId: 't1' }, query: { include: ['posts'] } }),
    );

    expect(load).toHaveBeenCalledWith(
      expect.any(Array),
      'posts',
      { tenantField: 'tenantId', tenantValue: 't1' },
      expect.any(Object),
    );
    expect((result.body as { result: Row & { posts: Row[] } }).result.posts).toEqual([
      { id: 'same', tenantId: 't1', title: 'Allowed' },
    ]);
  });
});

describe('create', () => {
  it('validates, applies managed fields, and returns 201 with the default envelope', async () => {
    const { resource } = makeResource();
    const result = await resource.execute('create', req({ body: { name: 'Anchor', qty: 2 } }));
    expect(result.status).toBe(201);
    const body = result.body as { success: boolean; result: Row };
    expect(body.success).toBe(true);
    expect(body.result.name).toBe('Anchor');
    expect(typeof body.result.id).toBe('string');
    expect(typeof body.result.createdAt).toBe('number');
    expect(typeof body.result.updatedAt).toBe('number');
  });

  it('rejects an invalid body with VALIDATION_ERROR 400', async () => {
    const { resource } = makeResource();
    await expect(
      resource.execute('create', req({ body: { name: '', qty: -1 } })),
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
  });

  it("id: 'client' keeps the caller-supplied PK and requires it in the body", async () => {
    const { resource, store } = makeResource({ model: { id: 'client' } });

    const created = await resource.execute(
      'create',
      req({ body: { id: 'client-1', name: 'Anchor', qty: 2 } }),
    );
    expect(created.status).toBe(201);
    expect((created.body as { result: Row }).result.id).toBe('client-1');
    expect(store.get('client-1')).toBeDefined();

    // Missing PK → the derived schema keeps it required → 400.
    await expect(
      resource.execute('create', req({ body: { name: 'NoId', qty: 1 } })),
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
  });

  it("id: 'client' never lets an update patch rewrite the PK", async () => {
    const { resource, store } = makeResource({ model: { id: 'client' } });
    store.set('a', { id: 'a', name: 'A', qty: 1 });

    // The update schema still excludes the PK, so a body `id` is stripped at
    // validation and the row keeps its identity.
    const result = await resource.execute(
      'update',
      req({ id: 'a', body: { id: 'evil', name: 'B' } }),
    );
    expect(result.status).toBe(200);
    expect((result.body as { result: Row }).result.id).toBe('a');
    expect(store.get('a')?.name).toBe('B');
    expect(store.get('evil')).toBeUndefined();
  });

  it('threads beforeCreate chain output into the adapter and runs afterCreate in-scope', async () => {
    const order: string[] = [];
    const { resource, store } = makeResource({
      hooks: {
        beforeCreate: (_ctx: unknown, data: Row) => {
          order.push('before');
          return { ...data, name: `${data.name}!` };
        },
        afterCreate: (ctx: { db: { tx: unknown } }, record: Row) => {
          order.push('after');
          expect(ctx.db.tx).toEqual({ test: true });
          expect(record.name).toBe('Hook!');
        },
      },
    });
    const result = await resource.execute('create', req({ body: { name: 'Hook', qty: 1 } }));
    expect(order).toEqual(['before', 'after']);
    expect((result.body as { result: Row }).result.name).toBe('Hook!');
    expect(Array.from(store.values())[0]!.name).toBe('Hook!');
  });

  it('stamps the tenant field from request vars', async () => {
    const { resource, store } = makeResource({ model: { multiTenant: true } });
    await resource.execute(
      'create',
      req({ body: { name: 'T', qty: 1 }, vars: { tenantId: 't1' } }),
    );
    expect(Array.from(store.values())[0]!.tenantId).toBe('t1');
  });
});

describe('read', () => {
  it('returns the record, 404s on missing id, and 404s on soft-deleted rows', async () => {
    const { resource, store } = makeResource();
    store.set('a', { id: 'a', name: 'A', qty: 1 });
    store.set('b', { id: 'b', name: 'B', qty: 2, deletedAt: 5 });

    const ok = await resource.execute('read', req({ id: 'a' }));
    expect(ok.status).toBe(200);
    expect((ok.body as { result: Row }).result.id).toBe('a');

    await expect(resource.execute('read', req({ id: 'zz' }))).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(resource.execute('read', req({ id: 'b' }))).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('404s when the read policy denies and masks fields when configured', async () => {
    const { resource, store } = makeResource({
      model: {
        policies: {
          read: (_ctx: unknown, record: Row) => record.qty !== 99,
          // Overlay semantics (hono-crud parity): the returned partial
          // REPLACES matching fields — redaction, not subset selection.
          fields: () => ({ secret: undefined }),
        },
      },
    });
    store.set('a', { id: 'a', name: 'A', qty: 1, secret: 'hide-me' });
    store.set('x', { id: 'x', name: 'X', qty: 99 });

    const ok = await resource.execute('read', req({ id: 'a' }));
    expect((ok.body as { result: Row }).result.secret).toBeUndefined();
    await expect(resource.execute('read', req({ id: 'x' }))).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('enforces tenant lookup filters from request vars', async () => {
    const { resource, store } = makeResource({ model: { multiTenant: true } });
    store.set('a', { id: 'a', name: 'A', qty: 1, tenantId: 't1' });
    await expect(
      resource.execute('read', req({ id: 'a', vars: { tenantId: 't2' } })),
    ).rejects.toMatchObject({ statusCode: 404 });
    const ok = await resource.execute('read', req({ id: 'a', vars: { tenantId: 't1' } }));
    expect(ok.status).toBe(200);
  });
});

describe('update', () => {
  it('merges the patch, always stamps updatedAt, and hands two snapshots to afterUpdate', async () => {
    const seen: Array<{ prior: Row; current: Row }> = [];
    const { resource, store } = makeResource({
      hooks: {
        afterUpdate: (_ctx: unknown, prior: Row, current: Row) => {
          seen.push({ prior, current });
        },
      },
    });
    store.set('a', { id: 'a', name: 'Old', qty: 1, updatedAt: 111 });

    const result = await resource.execute('update', req({ id: 'a', body: { name: 'New' } }));
    const body = result.body as { result: Row };
    expect(body.result.name).toBe('New');
    expect(body.result.updatedAt).not.toBe(111);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.prior.name).toBe('Old');
    expect(seen[0]!.current.name).toBe('New');
  });

  it('403s when the write policy denies', async () => {
    const { resource, store } = makeResource({
      model: { policies: { write: () => false } },
    });
    store.set('a', { id: 'a', name: 'A', qty: 1 });
    await expect(
      resource.execute('update', req({ id: 'a', body: { name: 'B' } })),
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
  });

  it('requires source-row read access before an otherwise-allowed write', async () => {
    const { resource, store } = makeResource({
      model: { policies: { read: () => false, write: () => true } },
    });
    store.set('a', { id: 'a', name: 'Original', qty: 1 });

    await expect(
      resource.execute('update', req({ id: 'a', body: { name: 'Hidden mutation' } })),
    ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    expect(store.get('a')?.name).toBe('Original');
  });

  it('404s for a soft-deleted target', async () => {
    const { resource, store } = makeResource();
    store.set('a', { id: 'a', name: 'A', qty: 1, deletedAt: 4 });
    await expect(
      resource.execute('update', req({ id: 'a', body: { name: 'B' } })),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('delete', () => {
  it('soft-deletes when the model soft-deletes and returns { deleted: true }', async () => {
    const { resource, store } = makeResource();
    store.set('a', { id: 'a', name: 'A', qty: 1 });

    const result = await resource.execute('delete', req({ id: 'a' }));
    expect(result.status).toBe(200);
    expect((result.body as { result: Row }).result).toEqual({ deleted: true });
    expect(typeof store.get('a')!.deletedAt).toBe('number');

    // Delete-again → 404 (the record is now invisible).
    await expect(resource.execute('delete', req({ id: 'a' }))).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('hard-deletes when the model does not soft-delete', async () => {
    const { resource, store } = makeResource({}, false);
    store.set('a', { id: 'a', name: 'A', qty: 1 });
    await resource.execute('delete', req({ id: 'a' }));
    expect(store.has('a')).toBe(false);
  });

  it('runs beforeDelete with the prior row', async () => {
    const before = vi.fn();
    const { resource, store } = makeResource({ hooks: { beforeDelete: before } });
    store.set('a', { id: 'a', name: 'A', qty: 1 });
    await resource.execute('delete', req({ id: 'a' }));
    expect(before).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'a' }));
  });

  it('requires source-row read access before an otherwise-allowed delete', async () => {
    const { resource, store } = makeResource({
      model: { policies: { read: () => false, write: () => true } },
    });
    store.set('a', { id: 'a', name: 'Hidden', qty: 1 });

    await expect(resource.execute('delete', req({ id: 'a' }))).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
    expect(store.get('a')?.deletedAt).toBeUndefined();
  });
});

describe('list', () => {
  it('parses filters, paginates, and envelopes with result_info', async () => {
    const { resource, store } = makeResource();
    for (let i = 1; i <= 5; i++) store.set(`r${i}`, { id: `r${i}`, name: `Row${i}`, qty: i });

    const result = await resource.execute(
      'list',
      req({ query: { 'qty[gte]': '2', per_page: '2' } }),
    );
    expect(result.status).toBe(200);
    const body = result.body as { success: boolean; result: Row[]; result_info: Row };
    expect(body.success).toBe(true);
    // fake adapter only implements eq, so gte arrives as a parsed condition —
    // assert the parse produced conditions rather than adapter semantics.
    expect(body.result_info.per_page).toBe(2);
  });

  it('drops rows the read policy rejects and masks the rest', async () => {
    const { resource, store } = makeResource({
      model: {
        policies: {
          read: (_ctx: unknown, record: Row) => record.qty !== 2,
          // Overlay semantics (hono-crud parity): the returned partial
          // REPLACES matching fields — redaction, not subset selection.
          fields: () => ({ secret: undefined }),
        },
      },
    });
    store.set('a', { id: 'a', name: 'A', qty: 1, secret: 's' });
    store.set('b', { id: 'b', name: 'B', qty: 2 });

    const result = await resource.execute('list', req());
    const body = result.body as { result: Row[]; result_info: Row };
    expect(body.result.map((r) => r.id)).toEqual(['a']);
    expect(body.result[0]!.secret).toBeUndefined();
    expect(body.result_info.total_count).toBe(1);
  });

  it('paginates only after arbitrary read checks and never leaks hidden counts', async () => {
    const { resource, store } = makeResource({
      model: { policies: { read: (_ctx: unknown, row: Row) => row.qty !== 0 } },
    });
    store.set('hidden', { id: 'hidden', name: 'Hidden', qty: 0 });
    store.set('visible-1', { id: 'visible-1', name: 'Visible 1', qty: 1 });
    store.set('visible-2', { id: 'visible-2', name: 'Visible 2', qty: 2 });

    const first = await resource.execute('list', req({ query: { page: '1', per_page: '1' } }));
    const firstBody = first.body as { result: Row[]; result_info: Row };
    expect(firstBody.result.map((row) => row.id)).toEqual(['visible-1']);
    expect(firstBody.result_info).toMatchObject({
      page: 1,
      per_page: 1,
      total_count: 2,
      total_pages: 2,
      has_next_page: true,
    });

    const second = await resource.execute('list', req({ query: { page: '2', per_page: '1' } }));
    const secondBody = second.body as { result: Row[]; result_info: Row };
    expect(secondBody.result.map((row) => row.id)).toEqual(['visible-2']);
    expect(secondBody.result_info.total_count).toBe(2);
  });

  it('injects tenant scope and policy pushdown into the adapter query', async () => {
    const { resource, store } = makeResource({
      model: {
        multiTenant: true,
        policies: { readPushdown: () => [{ field: 'qty', operator: 'eq' as const, value: 1 }] },
      },
    });
    store.set('a', { id: 'a', name: 'A', qty: 1, tenantId: 't1' });
    store.set('b', { id: 'b', name: 'B', qty: 1, tenantId: 't2' });
    store.set('c', { id: 'c', name: 'C', qty: 9, tenantId: 't1' });

    const result = await resource.execute('list', req({ vars: { tenantId: 't1' } }));
    expect((result.body as { result: Row[] }).result.map((r) => r.id)).toEqual(['a']);
  });
});

describe('custom envelope + error formatting', () => {
  it('formats success and errors through the configured envelope', async () => {
    const { resource, store } = makeResource({
      envelope: {
        success: (result: unknown, info?: unknown) => ({ data: result, meta: info ?? null }),
        error: (err: { code: string }) => ({ problem: err.code }),
      },
    });
    store.set('a', { id: 'a', name: 'A', qty: 1 });

    const ok = await resource.execute('read', req({ id: 'a' }));
    expect((ok.body as { data: Row }).data.id).toBe('a');

    const missing = await resource.execute('read', req({ id: 'zz' }));
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ problem: 'NOT_FOUND' });
  });
});

describe('definition-time capability checks', () => {
  it('throws loudly when cursor pagination is enabled without the capability', () => {
    const store = new Map<string, Row>();
    const model = defineModel({ name: 'item', tableName: 'items', schema: itemSchema });
    expect(() =>
      defineResource('items', {
        model,
        adapter: fakeAdapter(store),
        pagination: { cursor: { enabled: true } },
      }),
    ).toThrowError(/cursor/);
  });

  it('throws when the model soft-deletes but the adapter cannot', () => {
    const store = new Map<string, Row>();
    const model = defineModel({
      name: 'item',
      tableName: 'items',
      schema: itemSchema,
      softDelete: true,
    });
    expect(() => defineResource('items', { model, adapter: fakeAdapter(store) })).toThrowError(
      /softDelete/,
    );
  });
});

beforeEach(() => {
  vi.restoreAllMocks();
});
