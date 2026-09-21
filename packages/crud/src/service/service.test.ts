import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import { Container, InjectionToken, defineProvider } from '@velajs/vela';
import type { StandardSchemaV1 } from '@velajs/vela';
import { testAdapter } from '../__tests__/test-adapter';
import { defineModel } from '../model/define-model';
import { defineStandardModel } from '../model/standard-model';
import { defineResource } from '../kernel/resource';
import { bindCrudService } from './index';

function fixture() {
  const store = new Map<string, Record<string, unknown>>();
  const inputTransform = vi.fn(async (amount: string) => Number(amount));
  const outputTransform = vi.fn(async (row: { id: string; amount: number }) => ({
    id: row.id,
    label: String(row.amount) + ' credits',
  }));
  const contracts = {
    id: z
      .string()
      .startsWith('order:')
      .transform((id) => id.slice(6)),
    create: z.object({
      id: z.string(),
      amount: z.string().transform(inputTransform),
      secret: z.string().optional(),
    }),
    update: z.object({ amount: z.string().transform(inputTransform) }),
    response: z.object({ id: z.string(), amount: z.number() }).transform(outputTransform),
  };
  const model = defineModel({
    name: 'order',
    tableName: 'orders',
    timestamps: false,
    id: 'client',
    multiTenant: true,
    schema: z.object({
      id: z.string(),
      amount: z.number(),
      tenantId: z.string(),
      secret: z.string().optional(),
    }),
    serializationProfile: { exclude: ['secret'] },
    policies: { operation: (ctx) => ctx.user !== 'denied' },
  });
  const adapter = testAdapter(store);
  const resource = defineResource('orders', { model, adapter, contracts, etag: true });
  return {
    store,
    inputTransform,
    outputTransform,
    contracts,
    resource,
    adapter,
    service: bindCrudService(resource, contracts),
  };
}
const context = { vars: { tenantId: 'a' } };

describe('typed headless CRUD service', () => {
  it('executes asynchronous input/output transforms once through the resource engine', async () => {
    const { service, inputTransform, outputTransform, store } = fixture();
    const created = await service.create({ id: 'one', amount: '42', secret: 'hidden' }, context);
    expect(created).toEqual({ status: 201, data: { id: 'one', label: '42 credits' }, headers: {} });
    expect(store.get('one')).toMatchObject({ amount: 42, tenantId: 'a' });
    expect(inputTransform).toHaveBeenCalledTimes(1);
    expect(outputTransform).toHaveBeenCalledTimes(1);
    const updated = await service.update('order:one', { amount: '43' }, context);
    expect(updated.data).toEqual({ id: 'one', label: '43 credits' });
    expect(inputTransform).toHaveBeenCalledTimes(2);
    expect(outputTransform).toHaveBeenCalledTimes(2);
    expect((await service.read('order:one', context)).data).toEqual(updated.data);
    const page = await service.list({ per_page: '1' }, context);
    expect(page.data.result).toEqual([updated.data]);
    expect(page.data.result_info).toMatchObject({ total_count: 1, per_page: 1 });
    expect(outputTransform).toHaveBeenCalledTimes(4);
    expect((await service.delete('order:one', context)).data).toEqual({ deleted: true });
    expect(store.size).toBe(0);
  });

  it('preserves policies and invocation tenant context without caching authority', async () => {
    const { service, adapter } = fixture();
    await Promise.all([
      service.create({ id: 'a', amount: '1' }, { vars: { tenantId: 'a' } }),
      service.create({ id: 'b', amount: '2' }, { vars: { tenantId: 'b' } }),
    ]);
    const list = vi.spyOn(adapter.runtime, 'list');
    await expect(service.list({}, { vars: { tenantId: 'a', user: 'denied' } })).rejects.toThrow();
    expect(list).not.toHaveBeenCalled();
    expect((await service.list({}, { vars: { tenantId: 'a' } })).data.result).toEqual([
      { id: 'a', label: '1 credits' },
    ]);
    expect((await service.list({}, { vars: { tenantId: 'b' } })).data.result).toEqual([
      { id: 'b', label: '2 credits' },
    ]);
    await expect(service.read('order:b', context)).rejects.toThrow();
    await expect(service.list()).rejects.toThrow();
  });

  it('preserves ETag headers and distinguishes a conditional 304 from row data', async () => {
    const { service } = fixture();
    await service.create({ id: 'one', amount: '4' }, context);
    const first = await service.read('order:one', context);
    expect(first.status).toBe(200);
    const cached = await service.read('order:one', {
      ...context,
      request: new Request('https://example.test/orders/one', {
        headers: { 'If-None-Match': first.headers.ETag! },
      }),
    });
    expect(cached).toEqual({ status: 304, data: undefined, headers: first.headers });
    if (cached.status === 304) expectTypeOf(cached.data).toEqualTypeOf<undefined>();
  });

  it('checks actual schema identity and rejects post-validation output replacements', () => {
    const { resource, contracts } = fixture();
    expect(() =>
      bindCrudService(resource, { ...contracts, update: z.object({ other: z.string() }) }),
    ).toThrow('contracts must match');
    expect(() =>
      bindCrudService(resource, { ...contracts, response: z.object({ falseClaim: z.string() }) }),
    ).toThrow('contracts must match');
    resource.config.hooks = {
      afterList: () => ({
        result: ['invalid'],
        result_info: { page: 1, per_page: 1, has_next_page: false, has_prev_page: false },
      }),
    };
    expect(() => bindCrudService(resource, contracts)).toThrow('afterList');
    resource.config.hooks = {};
    resource.config.envelope = { success: (value) => value, error: (value) => value };
    expect(() => bindCrudService(resource, contracts)).toThrow('default response envelope');
  });

  it('rejects mutated bindings before writes and invalid persisted rows before returning data', async () => {
    const { service, resource, store } = fixture();
    store.set('bad', { id: 'bad', tenantId: 'a', amount: 'not a number' });
    await expect(service.read('order:bad', context)).rejects.toThrow();
    resource.config.contracts = {
      ...resource.config.contracts,
      response: z.object({ id: z.string() }),
    };
    await expect(service.create({ id: 'blocked', amount: '2' }, context)).rejects.toThrow(
      'contracts must match',
    );
    expect(store.has('blocked')).toBe(false);
  });

  it('can be supplied through an ordinary typed Vela provider', () => {
    const { service } = fixture();
    const token = new InjectionToken<typeof service>('orders-service');
    const provider = defineProvider(token, { useFactory: () => service, inject: [] });
    const container = new Container();
    container.register(provider);
    expect(container.resolve(token)).toBe(service);
  });
});

async function authorTypes() {
  const { service } = fixture();
  const created = await service.create({ id: 'one', amount: '4' });
  expectTypeOf(created.data).toEqualTypeOf<{ id: string; label: string }>();
  expectTypeOf(created.status).toEqualTypeOf<201>();
  // @ts-expect-error The contract accepts raw text, not transformed numbers.
  await service.create({ id: 'one', amount: 4 });
  // @ts-expect-error Create requires an ID.
  await service.create({ amount: '4' });
  // @ts-expect-error Update input remains text.
  await service.update('order:one', { amount: 4 });
  // @ts-expect-error Identifier schema input is a string.
  await service.read({ id: 'one' });
  // @ts-expect-error Persisted fields excluded by projection are absent.
  void created.data.amount;
  // @ts-expect-error Invocation context cannot override the method's body.
  await service.create({ id: 'one', amount: '4' }, { body: { id: 'other' } });
}
void authorTypes;

it('keeps separate application resources with identical names isolated', async () => {
  const first = fixture().service;
  const second = fixture().service;
  await first.create({ id: 'one', amount: '1' }, context);
  await second.create({ id: 'one', amount: '2' }, context);
  expect((await first.read('order:one', context)).data?.label).toBe('1 credits');
  expect((await second.read('order:one', context)).data?.label).toBe('2 credits');
});

it("binds a Standard Model and preserves a non-Zod validator's scalar input type", async () => {
  const row = z.object({ id: z.string(), amount: z.number() });
  let validations = 0;
  const create: StandardSchemaV1<string, z.infer<typeof row>> = {
    '~standard': {
      version: 1,
      vendor: 'service-test',
      async validate(value) {
        validations++;
        if (typeof value !== 'string' || !/^\d+$/.test(value))
          return { issues: [{ message: 'Expected numeric text' }] };
        return { value: { id: 'standard', amount: Number(value) } };
      },
    },
  };
  const model = defineStandardModel({
    name: 'standard',
    tableName: 'standard',
    id: 'client',
    timestamps: false,
    schema: row,
    fields: { id: { type: 'string' }, amount: { type: 'number' } },
    contracts: { create, update: row.partial(), response: row },
  });
  const service = bindCrudService(
    defineResource('standard', { model, adapter: testAdapter(new Map()) }),
    model.contracts,
  );
  expectTypeOf<Parameters<typeof service.create>[0]>().toEqualTypeOf<string>();
  const result = await service.create('42');
  expect(result.data).toEqual({ id: 'standard', amount: 42 });
  expect(validations).toBe(1);
  expectTypeOf(result.data).toEqualTypeOf<{ id: string; amount: number }>();
  await expect(service.create('invalid')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  expect(validations).toBe(2);
});

it('retains complete composite identifier input types and forwards all parts', async () => {
  const schema = z.object({ id: z.string(), part: z.number(), amount: z.number() });
  const contracts = {
    id: z.object({ id: z.string(), part: z.number() }),
    create: schema,
    update: z.object({ amount: z.number() }),
    response: schema,
  };
  const model = defineModel({
    name: 'composite',
    tableName: 'composite',
    schema,
    primaryKeys: ['id', 'part'],
    id: 'client',
    timestamps: false,
  });
  const service = bindCrudService(
    defineResource('composite', { model, contracts, adapter: testAdapter(new Map()) }),
    contracts,
  );
  await service.create({ id: 'one', part: 2, amount: 3 });
  expect((await service.read({ id: 'one', part: 2 })).data).toEqual({
    id: 'one',
    part: 2,
    amount: 3,
  });
  await expect(service.read({ id: 'one', part: 1 })).rejects.toThrow();
  async function typeChecks() {
    // @ts-expect-error Composite identifiers require every component.
    await service.read({ id: 'one' });
    // @ts-expect-error Numeric composite parts remain numeric.
    await service.read({ id: 'one', part: '2' });
  }
  void typeChecks;
});
