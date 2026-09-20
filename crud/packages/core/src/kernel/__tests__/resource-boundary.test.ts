import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import { Crud } from '../../crud.decorator';
import { defineCrudFeature } from '../../synthesize-controller';
import { defineModel } from '../../model/define-model';
import { testAdapter } from '../../__tests__/test-adapter';
import { defineResource } from '../resource';

const schema = z.object({
  id: z.string(),
  title: z.string(),
  count: z.number(),
  secret: z.string().optional(),
});
const model = defineModel({
  name: 'typed',
  tableName: 'typed',
  schema,
  timestamps: false,
  softDelete: false,
});

describe('schema-bound resource authoring', () => {
  it('infers author hooks from the model through each public factory', () => {
    const adapter = testAdapter(new Map());
    defineResource('typed', {
      model,
      adapter,
      hooks: {
        beforeCreate(_ctx, input) {
          expectTypeOf(input.count).toEqualTypeOf<number | undefined>();
          // @ts-expect-error Schema-bound writes cannot claim text for a numeric column.
          input.count = 'wrong';
        },
        afterCreate(_ctx, row) {
          expectTypeOf(row.count).toEqualTypeOf<number>();
          expectTypeOf(row.id).toEqualTypeOf<string>();
          return row;
        },
        transformRead(_ctx, row) {
          expectTypeOf(row.title).toEqualTypeOf<string | undefined>();
          return row.title ?? 'hidden';
        },
      },
    });
    Crud({
      model,
      adapter,
      hooks: {
        afterCreate(_ctx, row) {
          expectTypeOf(row.count).toEqualTypeOf<number>();
        },
        // @ts-expect-error Author callback return types cannot widen the model's schema.
        beforeUpdate: () => ({ count: 'wrong' }),
      },
    });
    defineCrudFeature({
      path: '/typed',
      model,
      adapter,
      hooks: {
        afterUpdate(_ctx, prior, current) {
          expectTypeOf(prior.title).toEqualTypeOf<string>();
          expectTypeOf(current.count).toEqualTypeOf<number>();
          return current;
        },
        // @ts-expect-error Persisted replacements must include every required schema field.
        afterCreate: () => ({ count: 1 }),
      },
    });
  });

  it('rejects invalid persisted records before an author hook or read policy sees them', async () => {
    const afterCreate = vi.fn();
    const read = vi.fn(() => true);
    const invalidStore = new Map<string, Record<string, unknown>>([
      ['a', { id: 'a', title: 'Title', count: 'wrong' }],
    ]);
    const resource = defineResource('typed', {
      model: defineModel({
        name: 'typed',
        tableName: 'typed',
        schema,
        timestamps: false,
        softDelete: false,
        policies: { read },
      }),
      adapter: testAdapter(invalidStore),
      hooks: { afterCreate },
    });
    await expect(resource.execute('read', { id: 'a' })).rejects.toThrow();
    await expect(resource.execute('list', {})).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(afterCreate).not.toHaveBeenCalled();
  });

  it('retains before-update replacements and in-place after-update mutations', async () => {
    const store = new Map<string, Record<string, unknown>>([
      ['a', { id: 'a', title: 'Title', count: 1 }],
    ]);
    const resource = defineResource('typed', {
      model,
      adapter: testAdapter(store),
      hooks: {
        beforeUpdate: (_ctx, patch) => ({ ...patch, count: 4 }),
        afterUpdate: (_ctx, _prior, current) => {
          current.title = 'Returned';
        },
      },
    });
    const response = await resource.execute('update', { id: 'a', body: { count: 2 } });
    expect(store.get('a')?.count).toBe(4);
    expect(response.body).toMatchObject({ result: { title: 'Returned', count: 4 } });
  });

  it('keeps masked transforms sparse and supports arbitrary read/list output', async () => {
    const store = new Map<string, Record<string, unknown>>([
      ['a', { id: 'a', title: 'Title', count: 1, secret: 'hidden' }],
    ]);
    const resource = defineResource('typed', {
      model: defineModel({
        name: 'typed',
        tableName: 'typed',
        schema,
        timestamps: false,
        softDelete: false,
        serializationProfile: { exclude: ['secret'] },
      }),
      adapter: testAdapter(store),
      hooks: {
        transformRead: (_ctx, row) => {
          expect(row.secret).toBeUndefined();
          return row.title;
        },
        transformList: (_ctx, row) => {
          expect(row.secret).toBeUndefined();
          return row.count;
        },
        afterList: (_ctx, page) => ({ ...page, result: [...page.result, 'extra'] }),
      },
    });
    expect((await resource.execute('read', { id: 'a' })).body).toMatchObject({ result: 'Title' });
    expect((await resource.execute('list', {})).body).toMatchObject({ result: [1, 'extra'] });
  });
});
