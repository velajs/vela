import { describe, it, expect, vi, expectTypeOf } from 'vitest';
import { z } from 'zod';
import * as v from 'valibot';
import { defineModel, defineStandardModel, defineResource } from '@velajs/crud';
import type { AuthorizationPlan } from '@velajs/crud/kernel';
import { hmacCursorCodec } from '@velajs/crud/query';
import { MemoryStore, transactionalMemoryAdapter } from '@velajs/crud-memory';
import { ValidationPipe, defineDto } from '@velajs/vela';
const schema = z.object({
  part: z.string(),
  id: z.string(),
  tenantId: z.string(),
  parent: z.string(),
  rank: z.number(),
});
const model = defineModel({
  name: 'entry',
  tableName: 'entries',
  schema,
  primaryKeys: ['part', 'id'],
  id: 'client',
  multiTenant: true,
  timestamps: false,
});
const vars = { tenantId: 'a' },
  params = { parentId: 'p' };
function fixture() {
  const store = new MemoryStore(),
    adapter = transactionalMemoryAdapter({
      store,
      tableName: 'entries',
      primaryKeys: ['part', 'id'],
    });
  return { store, adapter };
}
describe('edge CRUD contracts', () => {
  it('supports complete composite IDs, immutable parent scopes and instance-owned rollback', async () => {
    const { adapter } = fixture(),
      resource = defineResource('entries', {
        model,
        adapter,
        collection: { parents: { parent: 'parentId' } },
      });
    for (const part of ['one', 'two'])
      await resource.execute('create', {
        vars,
        params,
        body: { part, id: 'same', rank: 1, parent: 'p' },
      });
    expect(
      (await resource.execute('read', { vars, params, id: { part: 'two', id: 'same' } })).body,
    ).toMatchObject({ result: { part: 'two' } });
    await expect(resource.execute('read', { vars, params, id: 'same' })).rejects.toThrow();
    await expect(
      resource.execute('read', {
        vars,
        params: { parentId: 'other' },
        id: { part: 'two', id: 'same' },
      }),
    ).rejects.toThrow();
    await expect(
      resource.execute('update', {
        vars,
        params,
        id: { part: 'two', id: 'same' },
        body: { parent: 'escape' },
      }),
    ).rejects.toThrow();
    await resource.execute('batchUpdate', {
      vars,
      params,
      body: { items: [{ id: { part: 'two', id: 'same' }, data: { rank: 2 } }] },
    });
    expect(
      (await resource.execute('read', { vars, params, id: { part: 'one', id: 'same' } })).body,
    ).toMatchObject({ result: { rank: 1 } });
    const broken = defineResource('entries', {
      model,
      adapter,
      hooks: {
        afterCreate: () => {
          throw new Error('rollback');
        },
      },
    });
    await expect(
      broken.execute('create', { vars, body: { part: 'bad', id: 'same', rank: 0, parent: 'p' } }),
    ).rejects.toThrow('rollback');
    await expect(
      resource.execute('read', { vars, params, id: { part: 'bad', id: 'same' } }),
    ).rejects.toThrow();
    await expect(
      defineResource('other', { model, adapter: fixture().adapter }).execute('read', {
        vars,
        id: { part: 'one', id: 'same' },
      }),
    ).rejects.toThrow();
  });
  it('applies structured authorization before totals and binds signed cursors to tenant and parent', async () => {
    const { adapter } = fixture(),
      plain = defineResource('entries', { model, adapter });
    for (const tenantId of ['a', 'b'])
      for (let n = 0; n < 4; n++)
        await plain.execute('create', {
          vars: { tenantId },
          body: { part: tenantId, id: String(n), rank: n, parent: 'p' },
        });
    const key = await crypto.subtle.generateKey(
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign', 'verify'],
    );
    const resource = defineResource('entries', {
      model,
      adapter,
      collection: { parents: { parent: 'parentId' } },
      authorization: async () => ({
        kind: 'conditional',
        predicate: {
          op: 'and',
          args: [
            { op: 'gte', field: 'rank', value: 1 },
            { op: 'not', arg: { op: 'eq', field: 'rank', value: 3 } },
          ],
        },
      }),
      pagination: {
        cursor: {
          enabled: true,
          field: 'rank',
          codec: hmacCursorCodec({ activeKeyId: 'a', keys: new Map([['a', key]]) }),
        },
      },
    });
    const page = z
      .object({
        result: schema.array(),
        result_info: z.object({ total_count: z.number(), next_cursor: z.string() }),
      })
      .parse((await resource.execute('list', { vars, params, query: { limit: '1' } })).body);
    expect(page.result_info.total_count).toBe(2);
    expect(page.result[0]?.rank).toBe(1);
    expect(
      (await resource.execute('aggregate', { vars, params, query: { count: '*' } })).body,
    ).toMatchObject({ result: { values: { count: 2 } } });
    expect(
      (
        await resource.execute('list', {
          vars,
          params,
          query: { limit: '1', cursor: page.result_info.next_cursor },
        })
      ).body,
    ).toMatchObject({ result: [{ rank: 2 }] });
    for (const target of [
      { vars: { tenantId: 'b' }, params },
      { vars, params: { parentId: 'other' } },
    ])
      await expect(
        resource.execute('list', {
          ...target,
          query: { limit: '1', cursor: page.result_info.next_cursor },
        }),
      ).rejects.toThrow();
    await expect(
      resource.execute('delete', { vars, params, id: { part: 'a', id: '0' } }),
    ).rejects.toThrow();
  });
  it('projects a page once and reports delivery failure after a committed write', async () => {
    const { adapter } = fixture(),
      project = vi.fn(async (rows: readonly unknown[]) => rows.map(() => ({ count: 7 }))),
      report = vi.fn();
    const resource = defineResource('entries', {
      model,
      adapter,
      projectPage: project,
      afterCommit: () => {
        throw new Error('queue down');
      },
      onAfterCommitError: report,
    });
    expect(
      (
        await resource.execute('create', {
          vars,
          body: { part: 'one', id: '1', rank: 1, parent: 'p' },
        })
      ).status,
    ).toBe(201);
    expect(report).toHaveBeenCalledOnce();
    expect((await resource.execute('list', { vars })).body).toMatchObject({
      result: [{ count: 7 }],
    });
    expect(project).toHaveBeenCalledOnce();
    expect((await resource.execute('read', { vars, id: { part: 'one', id: '1' } })).status).toBe(
      200,
    );
  });
  it('supports asynchronous Valibot input transforms and separate row/response schemas', async () => {
    const create = v.objectAsync({
      id: v.string(),
      amount: v.pipeAsync(
        v.string(),
        v.transformAsync(async (value) => Number(value)),
      ),
    });
    const row = v.object({ id: v.string(), amount: v.number() });
    const standard = defineStandardModel({
      name: 'standard',
      tableName: 'standard',
      schema: row,
      id: 'client',
      timestamps: false,
      fields: { id: { type: 'string' }, amount: { type: 'number' } },
      contracts: {
        create,
        update: v.partial(row),
        response: v.object({ id: v.string(), amount: v.number() }),
      },
    });
    expectTypeOf<v.InferInput<typeof standard.contracts.create>>().toEqualTypeOf<{
      id: string;
      amount: string;
    }>();
    expectTypeOf<v.InferOutput<typeof standard.contracts.create>>().toEqualTypeOf<{
      id: string;
      amount: number;
    }>();
    expectTypeOf<v.InferOutput<typeof standard.contracts.row>>().toEqualTypeOf<{
      id: string;
      amount: number;
    }>();
    const resource = defineResource('standard', {
      model: standard,
      adapter: transactionalMemoryAdapter({ store: new MemoryStore(), tableName: 'standard' }),
    });
    const body = await new ValidationPipe(defineDto(create)).transform(
      { id: 'one', amount: '42' },
      { type: 'body' },
    );
    expect((await resource.execute('create', { body })).body).toEqual({
      success: true,
      result: { id: 'one', amount: 42 },
    });
  });
});

it('applies identifier contracts to point and batch requests, and rejects invalid translations before querying', async () => {
  const { adapter } = fixture();
  const resource = defineResource('entries', {
    model,
    adapter,
    contracts: {
      id: z.object({
        part: z.string().transform((s) => s.toLowerCase()),
        id: z.string().regex(/^\d+$/),
      }),
    },
  });
  await resource.execute('create', { vars, body: { part: 'one', id: '1', parent: 'p', rank: 1 } });
  expect((await resource.execute('read', { vars, id: { part: 'ONE', id: '1' } })).status).toBe(200);
  await resource.execute('batchUpdate', {
    vars,
    body: { items: [{ id: { part: 'ONE', id: '1' }, data: { rank: 2 } }] },
  });
  expect(
    (await resource.execute('read', { vars, id: { part: 'one', id: '1' } })).body,
  ).toMatchObject({ result: { rank: 2 } });
  await expect(
    resource.execute('read', { vars, id: { part: 'one', id: 'bad' } }),
  ).rejects.toMatchObject({ statusCode: 400 });
  await expect(
    resource.execute('batchDelete', { vars, body: { ids: [{ part: 'one', id: 'bad' }] } }),
  ).rejects.toMatchObject({ statusCode: 400 });
  const list = vi.spyOn(adapter.runtime, 'list');
  const invalid = defineResource('entries', {
    model,
    adapter,
    authorization: () => ({
      kind: 'conditional',
      predicate: { op: 'eq', field: 'missing', value: 1 },
    }),
  });
  await expect(invalid.execute('list', { vars })).rejects.toThrow('Unknown');
  for (const result of [undefined, null, false, {}, { kind: 'unrecognized' }]) {
    const invalidPlan = defineResource('entries', {
      model,
      adapter,
      authorization: async () => result as AuthorizationPlan,
    });
    await expect(invalidPlan.execute('list', { vars })).rejects.toThrow(
      'Invalid authorization plan',
    );
  }
  expect(list).not.toHaveBeenCalled();
});
it('rolls back batched writes without delivering commit events and detaches committed memory rows', async () => {
  const { adapter } = fixture(),
    delivered = vi.fn();
  const failing = defineResource('entries', {
    model,
    adapter,
    afterCommit: delivered,
    hooks: {
      afterBatchCreate: (_ctx, item, index) => {
        if (index === 1) throw Error('abort batch');
        return item;
      },
    },
  });
  await expect(
    failing.execute('batchCreate', {
      vars,
      body: {
        items: [
          { part: 'one', id: '1', parent: 'p', rank: 1 },
          { part: 'one', id: '2', parent: 'p', rank: 2 },
        ],
      },
    }),
  ).rejects.toThrow('abort batch');
  expect(delivered).not.toHaveBeenCalled();
  expect((await failing.execute('list', { vars })).body).toMatchObject({ result: [] });
  const retained = await adapter.runtime.transaction((scope) =>
    adapter.runtime.create({ part: 'one', id: '3', parent: 'p', tenantId: 'a', rank: 3 }, scope),
  );
  retained.rank = 99;
  expect(
    (await failing.execute('read', { vars, id: { part: 'one', id: '3' } })).body,
  ).toMatchObject({ result: { rank: 3 } });
});

it('pushes relation predicates before loading and rolls back denied nested mutations', async () => {
  const store = new MemoryStore(),
    childSchema = z.object({
      id: z.string(),
      parentId: z.string(),
      tenantId: z.string(),
      rank: z.number(),
    });
  const parent = defineModel({
    name: 'parent',
    tableName: 'parents',
    schema: z.object({ id: z.string(), tenantId: z.string(), name: z.string() }),
    id: 'client',
    multiTenant: true,
    timestamps: false,
    relations: {
      children: {
        type: 'hasMany',
        target: 'children',
        foreignKey: 'parentId',
        schema: childSchema,
        nestedWrites: { allowUpdate: true, allowDelete: true },
        response: {
          tenantField: 'tenantId',
          primaryKeys: ['id'],
          softDeleteField: false,
          timestamps: { createdAt: false, updatedAt: false },
          authorization: async () => ({
            kind: 'conditional',
            predicate: { op: 'lt', field: 'rank', value: 10 },
          }),
        },
      },
    },
  });
  const adapter = transactionalMemoryAdapter({
    store,
    tableName: 'parents',
    relations: { children: { type: 'hasMany', table: 'children', foreignKey: 'parentId' } },
  });
  const children = transactionalMemoryAdapter({ store, tableName: 'children' });
  const resource = defineResource('parents', {
    model: parent,
    adapter,
    allowedIncludes: ['children'],
  });
  await resource.execute('create', { vars, body: { id: 'p', name: 'before' } });
  await children.runtime.transaction(async (scope) => {
    for (const [id, rank] of [
      ['yes', 1],
      ['no', 20],
    ] as const)
      await children.runtime.create({ id, parentId: 'p', tenantId: 'a', rank }, scope);
  });
  expect(
    (await resource.execute('read', { vars, id: 'p', query: { include: 'children' } })).body,
  ).toMatchObject({ result: { children: [{ id: 'yes' }] } });
  await expect(
    resource.execute('update', {
      vars,
      id: 'p',
      body: { name: 'after', children: { update: [{ id: 'no', rank: 0 }] } },
    }),
  ).rejects.toThrow();
  expect((await resource.execute('read', { vars, id: 'p' })).body).toMatchObject({
    result: { name: 'before' },
  });
  await resource.execute('update', {
    vars,
    id: 'p',
    body: { children: { update: [{ id: 'yes', rank: 2 }] } },
  });
  expect(
    (await resource.execute('read', { vars, id: 'p', query: { include: 'children' } })).body,
  ).toMatchObject({ result: { children: [{ id: 'yes', rank: 2 }] } });
});
