import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Controller, Module, VelaFactory } from '@velajs/vela';
import { ValidationPipe } from '@velajs/vela/validation';
import { createOpenApiDocument } from '@velajs/vela/openapi';
import { Crud } from '../crud.decorator';
import { defineModel } from '../model/define-model';
import { defineResource } from '../kernel/resource';
import { testAdapter } from './test-adapter';

it('validates generated HTTP bodies once with isolated applications and shared contracts', async () => {
  const transform = vi.fn(async (value: string) => Number(value));
  const create = z.object({ id: z.string(), amount: z.string().transform(transform) });
  const model = defineModel({
    name: 'entry',
    tableName: 'entries',
    id: 'client',
    timestamps: false,
    schema: z.object({ id: z.string(), amount: z.number() }),
  });
  async function app() {
    const store = new Map<string, Record<string, unknown>>();
    @Controller('/entries')
    @Crud({
      model,
      contracts: { create, update: z.object({ amount: z.string().transform(transform) }) },
      adapter: testAdapter(store),
      only: ['create', 'update'],
    })
    class Entries {}
    @Module({ controllers: [Entries] })
    class App {}
    const instance = await VelaFactory.create(App);
    instance.useGlobalPipes(new ValidationPipe());
    return { instance, store, App };
  }
  const [a, b] = await Promise.all([app(), app()]);
  const send = (instance: typeof a.instance, amount: unknown, method = 'POST', suffix = '') =>
    instance.fetch(
      new Request(`https://test/entries${suffix}`, {
        method,
        body: JSON.stringify({ id: 'same', amount }),
        headers: { 'content-type': 'application/json' },
      }),
    );
  try {
    const responses = await Promise.all([send(a.instance, '4'), send(b.instance, '5')]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(transform).toHaveBeenCalledTimes(2);
    expect(a.store.get('same')?.amount).toBe(4);
    expect(b.store.get('same')?.amount).toBe(5);
    expect((await send(a.instance, '6', 'PATCH', '/same')).status).toBe(200);
    expect(transform).toHaveBeenCalledTimes(3);
    expect(a.store.get('same')?.amount).toBe(6);
    expect((await send(a.instance, false)).status).toBe(400);
    expect(transform).toHaveBeenCalledTimes(3);
    const doc = createOpenApiDocument(a.App);
    expect(JSON.stringify(doc)).toContain('"amount":{"type":"string"}');
  } finally {
    await Promise.all([a.instance.close(), b.instance.close()]);
  }
});

describe('headless input validation', () => {
  it('does not reuse validation authority from another boundary', async () => {
    const create = z.object({ id: z.string(), amount: z.string().transform(Number) });
    const model = defineModel({
      name: 'entry',
      tableName: 'entries',
      id: 'client',
      timestamps: false,
      schema: z.object({ id: z.string(), amount: z.number() }),
    });
    const resource = defineResource('entry', {
      model,
      contracts: { create },
      adapter: testAdapter(new Map()),
    });
    const parsed = await new ValidationPipe(create).transform(
      { id: 'one', amount: '7' },
      { type: 'body' },
    );
    await expect(resource.execute('create', { body: parsed })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect((await resource.execute('create', { body: { id: 'one', amount: '7' } })).status).toBe(
      201,
    );
  });
});

it('runs each async identifier, row, and response contract once per boundary', async () => {
  const rowTransform = vi.fn(async (value: { id: string; amount: number }) => value);
  const responseTransform = vi.fn(async (value: { id: string; amount: number }) => ({
    ...value,
    amount: String(value.amount),
  }));
  const identifierTransform = vi.fn(async (value: string) => value.toLowerCase());
  const row = z.object({ id: z.string(), amount: z.number() });
  const model = defineModel({
    name: 'entry',
    tableName: 'entries',
    schema: row,
    id: 'client',
    timestamps: false,
  });
  const store = new Map<string, Record<string, unknown>>([['one', { id: 'one', amount: 7 }]]);
  const resource = defineResource('entry', {
    model,
    adapter: testAdapter(store),
    contracts: {
      id: z.string().transform(identifierTransform),
      row: row.transform(rowTransform),
      response: row.transform(responseTransform),
    },
  });
  expect((await resource.execute('read', { id: 'ONE' })).body).toMatchObject({
    result: { id: 'one', amount: '7' },
  });
  expect(identifierTransform).toHaveBeenCalledTimes(1);
  expect(rowTransform).toHaveBeenCalledTimes(1);
  expect(responseTransform).toHaveBeenCalledTimes(1);
});
