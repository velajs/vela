import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import { compileHooks } from '../compile-hooks';
import { runBeforeChain } from '../run-hooks';
import type { HookContext, SchemaHooks, SchemaRow, SchemaWrite } from '../hook-types';

const schema = z.object({
  id: z.string(),
  title: z.string(),
  secret: z.string().default('private'),
  count: z.number().int().nonnegative(),
});
const ctx: HookContext = { db: { tx: undefined }, tenantId: 'tenant-a' };
const row = { id: 'r1', title: 'Title', secret: 'secret', count: 1 };

describe('compileHooks', () => {
  it('leaves absent hooks absent and preserves execution modes', () => {
    expect(compileHooks(schema, undefined)).toBeUndefined();
    const modes = { create: { beforeMode: 'parallel', afterMode: 'fire-and-forget' } } as const;
    const compiled = compileHooks(schema, {
      beforeMode: 'parallel',
      afterMode: 'sequential',
      modes,
    });
    expect(compiled?.beforeMode).toBe('parallel');
    expect(compiled?.afterMode).toBe('sequential');
    expect(compiled?.modes).toBe(modes);
    expect(compiled?.beforeCreate).toBeUndefined();
  });

  it('infers persisted, write, and shaped callback payloads from the actual parsers', () => {
    const hooks: SchemaHooks<typeof schema.shape> = {
      beforeCreate(_ctx, value) {
        expectTypeOf(value.id).toEqualTypeOf<string | undefined>();
        expectTypeOf(value.count).toEqualTypeOf<number | undefined>();
        expectTypeOf(value.extra).toEqualTypeOf<unknown>();
        return { title: 'Created' };
      },
      afterCreate(_ctx, value) {
        expectTypeOf(value.id).toEqualTypeOf<string>();
        expectTypeOf(value.count).toEqualTypeOf<number>();
        expectTypeOf(value.secret).toEqualTypeOf<string>();
        return value;
      },
      transformRead(_ctx, value) {
        expectTypeOf(value.id).toEqualTypeOf<string | undefined>();
        expectTypeOf(value.secret).toEqualTypeOf<string | undefined>();
        return value.title ?? null;
      },
      afterList(_ctx, page) {
        expectTypeOf(page.result).toEqualTypeOf<unknown[]>();
        return page;
      },
    };
    expect(compileHooks(schema, hooks)).toBeDefined();
    expectTypeOf<SchemaRow<typeof schema.shape>['id']>().toEqualTypeOf<string>();
    expectTypeOf<SchemaWrite<typeof schema.shape>['id']>().toEqualTypeOf<string | undefined>();
    const invalid: SchemaHooks<typeof schema.shape> = {
      // @ts-expect-error Numeric write columns cannot be replaced with text.
      beforeCreate: () => ({ count: 'invalid' }),
      // @ts-expect-error Persisted rows must include their primary key.
      afterRead: () => ({ title: 'Missing id', count: 1, secret: 'private' }),
    };
    expect(invalid).toBeDefined();
  });

  it('validates partial creates and preserves extension fields in both directions', async () => {
    const beforeCreate = vi.fn((_ctx: HookContext, value: SchemaWrite<typeof schema.shape>) => {
      expect(value).toEqual({ title: 'New', computed: { enabled: true } });
      return { ...value, count: 2, another: 'extension' };
    });
    const compiled = compileHooks(schema, { beforeCreate });
    await expect(
      compiled?.beforeCreate?.(ctx, { title: 'New', computed: { enabled: true } }),
    ).resolves.toEqual({
      title: 'New',
      count: 2,
      computed: { enabled: true },
      another: 'extension',
    });
    await expect(compiled?.beforeCreate?.(ctx, { count: 'invalid' })).rejects.toThrow();
    expect(beforeCreate).toHaveBeenCalledTimes(1);
  });

  it('does not add omitted defaulted fields to patches or shaped reads', async () => {
    const compiled = compileHooks(schema, {
      beforeUpdate: (_ctx, patch) => patch,
      transformRead: (_ctx, value) => value,
    });
    await expect(compiled?.beforeUpdate?.(ctx, { title: 'Changed' }, row)).resolves.toEqual({
      title: 'Changed',
    });
    await expect(compiled?.transformRead?.(ctx, { title: 'Public only' })).resolves.toEqual({
      title: 'Public only',
    });
  });

  it('validates update snapshots before calling author code', async () => {
    const beforeUpdate = vi.fn();
    const afterUpdate = vi.fn();
    const compiled = compileHooks(schema, { beforeUpdate, afterUpdate });
    await expect(compiled?.beforeUpdate?.(ctx, { count: 2 }, { ...row, id: 1 })).rejects.toThrow();
    await expect(compiled?.afterUpdate?.(ctx, row, { ...row, count: -1 })).rejects.toThrow();
    expect(beforeUpdate).not.toHaveBeenCalled();
    expect(afterUpdate).not.toHaveBeenCalled();
  });

  it('validates replacement rows and patches returned by author code', async () => {
    const compiled = compileHooks(schema, {
      beforeUpdate(_ctx, value) {
        Object.defineProperty(value, 'count', { value: 'not a number', enumerable: true });
        return value;
      },
      afterCreate(_ctx, value) {
        Object.defineProperty(value, 'id', { value: null, enumerable: true });
        return value;
      },
      afterUpdate(_ctx, _prior, current) {
        Object.defineProperty(current, 'count', { value: -1, enumerable: true });
        return current;
      },
    });
    await expect(compiled?.beforeUpdate?.(ctx, { count: 2 }, row)).rejects.toThrow();
    await expect(compiled?.afterCreate?.(ctx, row)).rejects.toThrow();
    await expect(compiled?.afterUpdate?.(ctx, row, row)).rejects.toThrow();
    expect(row.count).toBe(1);
  });

  it('preserves upsert flags and validates persisted results', async () => {
    const beforeUpsert = vi.fn(
      (_ctx: HookContext, value: SchemaWrite<typeof schema.shape>, created: boolean) => {
        expect(created).toBe(false);
        return { ...value, title: 'Updated' };
      },
    );
    const afterUpsert = vi.fn(
      (_ctx: HookContext, value: SchemaRow<typeof schema.shape>, created: boolean) => {
        expect(created).toBe(true);
        return { ...value, title: 'Created' };
      },
    );
    const compiled = compileHooks(schema, { beforeUpsert, afterUpsert });
    await expect(compiled?.beforeUpsert?.(ctx, { count: 2 }, false)).resolves.toEqual({
      count: 2,
      title: 'Updated',
    });
    await expect(compiled?.afterUpsert?.(ctx, row, true)).resolves.toMatchObject({
      title: 'Created',
    });
    await expect(compiled?.afterUpsert?.(ctx, { title: 'Incomplete' }, true)).rejects.toThrow();
    expect(afterUpsert).toHaveBeenCalledTimes(1);
  });

  it.each(['beforeBatchCreate', 'beforeBatchUpdate', 'beforeBatchUpsert'] as const)(
    'validates %s partial inputs and preserves item indices',
    async (name) => {
      const hook = vi.fn(
        (_ctx: HookContext, value: SchemaWrite<typeof schema.shape>, index: number) => {
          expect(index).toBe(3);
          return { ...value, count: 5 };
        },
      );
      const compiled = compileHooks(schema, { [name]: hook });
      await expect(compiled?.[name]?.(ctx, { title: 'Partial' }, 3)).resolves.toEqual({
        title: 'Partial',
        count: 5,
      });
      await expect(compiled?.[name]?.(ctx, { count: 'invalid' }, 3)).rejects.toThrow();
      expect(hook).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    'afterBatchCreate',
    'afterBatchUpdate',
    'afterBatchRestore',
    'afterBatchUpsert',
  ] as const)('validates %s persisted inputs and preserves item indices', async (name) => {
    const hook = vi.fn(
      (_ctx: HookContext, value: SchemaRow<typeof schema.shape>, index: number) => {
        expect(index).toBe(2);
        return { ...value, title: 'After' };
      },
    );
    const compiled = compileHooks(schema, { [name]: hook });
    await expect(compiled?.[name]?.(ctx, row, 2)).resolves.toMatchObject({ title: 'After' });
    await expect(compiled?.[name]?.(ctx, { title: 'Incomplete' }, 2)).rejects.toThrow();
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it.each(['beforeDelete', 'afterDelete'] as const)('validates %s observers', async (name) => {
    const hook = vi.fn();
    const compiled = compileHooks(schema, { [name]: hook });
    await compiled?.[name]?.(ctx, row);
    await expect(compiled?.[name]?.(ctx, { title: 'Incomplete' })).rejects.toThrow();
    expect(hook).toHaveBeenCalledExactlyOnceWith(ctx, row);
  });

  it.each(['beforeBatchDelete', 'afterBatchDelete', 'beforeBatchRestore'] as const)(
    'validates %s observers and preserves item indices',
    async (name) => {
      const hook = vi.fn();
      const compiled = compileHooks(schema, { [name]: hook });
      await compiled?.[name]?.(ctx, row, 4);
      await expect(compiled?.[name]?.(ctx, { title: 'Incomplete' }, 4)).rejects.toThrow();
      expect(hook).toHaveBeenCalledExactlyOnceWith(ctx, row, 4);
    },
  );

  it('keeps arbitrary transform values and validates afterList replacement pages', async () => {
    const compiled = compileHooks(schema, {
      transformRead: (_ctx, value) => [value.title, null, 5],
      transformList: () => 'scalar',
      afterList: (_ctx, page) => ({ ...page, result: [...page.result, null, 42] }),
    });
    await expect(compiled?.transformRead?.(ctx, { title: 'Projected' })).resolves.toEqual([
      'Projected',
      null,
      5,
    ]);
    await expect(compiled?.transformList?.(ctx, {})).resolves.toBe('scalar');
    const page = {
      result: ['scalar'],
      result_info: { page: 1, per_page: 20, has_next_page: false, has_prev_page: false },
    };
    await expect(compiled?.afterList?.(ctx, page)).resolves.toEqual({
      ...page,
      result: ['scalar', null, 42],
    });
    const invalid = compileHooks(schema, {
      afterList(_ctx, value) {
        Object.defineProperty(value.result_info, 'has_next_page', {
          value: 'invalid',
          enumerable: true,
        });
        return value;
      },
    });
    await expect(invalid?.afterList?.(ctx, page)).rejects.toThrow();
  });

  it.each(['sequential', 'parallel', 'fire-and-forget'] as const)(
    'preserves synchronous void-return mutations in %s mode',
    async (mode) => {
      const compiled = compileHooks(schema, {
        beforeCreate(_ctx, value) {
          value.title = 'Changed in place';
          value.count = 2;
          delete value.removeMe;
        },
      });
      const beforeCreate = compiled?.beforeCreate;
      if (!beforeCreate) throw new Error('Expected compiled beforeCreate hook');
      const input: Record<string, unknown> = { title: 'Original', removeMe: true };
      const result = await runBeforeChain(mode, [beforeCreate], ctx, input);
      expect(result).toBe(input);
      expect(input).toEqual({ title: 'Changed in place', count: 2 });
      expect(input).not.toHaveProperty('secret');
    },
  );

  it('preserves asynchronous void-return mutations and all update targets', async () => {
    const compiled = compileHooks(schema, {
      async beforeUpdate(_ctx, patch, prior) {
        await Promise.resolve();
        patch.title = `${prior.title} updated`;
      },
      afterUpdate(_ctx, prior, current) {
        current.count = prior.count + 1;
      },
      afterCreate(_ctx, value) {
        value.title = 'Created in place';
      },
      afterRead(_ctx, value) {
        value.title = 'Read in place';
      },
      beforeBatchUpdate(_ctx, value, index) {
        value.count = index;
      },
      afterBatchCreate(_ctx, value, index) {
        value.count = index;
      },
    });
    const patch: Record<string, unknown> = {};
    const current = { ...row };
    const created = { ...row };
    const read = { ...row };
    const batchPatch: Record<string, unknown> = {};
    const batchCreated = { ...row };
    await expect(compiled?.beforeUpdate?.(ctx, patch, row)).resolves.toBeUndefined();
    await expect(compiled?.afterUpdate?.(ctx, row, current)).resolves.toBeUndefined();
    await expect(compiled?.afterCreate?.(ctx, created)).resolves.toBeUndefined();
    await expect(compiled?.afterRead?.(ctx, read)).resolves.toBeUndefined();
    await expect(compiled?.beforeBatchUpdate?.(ctx, batchPatch, 3)).resolves.toBeUndefined();
    await expect(compiled?.afterBatchCreate?.(ctx, batchCreated, 4)).resolves.toBeUndefined();
    expect(patch).toEqual({ title: 'Title updated' });
    expect(current.count).toBe(2);
    expect(created.title).toBe('Created in place');
    expect(read.title).toBe('Read in place');
    expect(batchPatch).toEqual({ count: 3 });
    expect(batchCreated.count).toBe(4);
    expect(row).toEqual({ id: 'r1', title: 'Title', secret: 'secret', count: 1 });
  });

  it('preserves void-return afterList row and metadata mutations', async () => {
    const compiled = compileHooks(schema, {
      afterList(_ctx, page) {
        page.result.push(null, 42);
        page.result_info.has_next_page = true;
        page.result_info.next_cursor = 'next';
      },
    });
    const page = {
      result: ['value'],
      result_info: { page: 1, per_page: 20, has_next_page: false, has_prev_page: false },
    };
    await expect(compiled?.afterList?.(ctx, page)).resolves.toBeUndefined();
    expect(page.result).toEqual(['value', null, 42]);
    expect(page.result_info).toMatchObject({ has_next_page: true, next_cursor: 'next' });
  });

  it('rejects malformed void-return mutations before synchronizing runtime inputs', async () => {
    const compiled = compileHooks(schema, {
      beforeCreate(_ctx, value) {
        Object.defineProperty(value, 'count', { value: 'invalid', enumerable: true });
      },
      afterUpdate(_ctx, _prior, value) {
        Object.defineProperty(value, 'id', { value: null, enumerable: true });
      },
      afterList(_ctx, page) {
        Object.defineProperty(page.result_info, 'has_next_page', {
          value: 'invalid',
          enumerable: true,
        });
      },
    });
    const input = { count: 3 };
    const current = { ...row };
    const page = {
      result: ['value'],
      result_info: { page: 1, per_page: 20, has_next_page: false, has_prev_page: false },
    };
    await expect(compiled?.beforeCreate?.(ctx, input)).rejects.toThrow();
    await expect(compiled?.afterUpdate?.(ctx, row, current)).rejects.toThrow();
    await expect(compiled?.afterList?.(ctx, page)).rejects.toThrow();
    expect(input).toEqual({ count: 3 });
    expect(current).toEqual(row);
    expect(page.result_info.has_next_page).toBe(false);
  });

  it('preserves no-payload hooks and undefined mutation results', async () => {
    const beforeList = vi.fn();
    const beforeRead = vi.fn();
    const compiled = compileHooks(schema, {
      beforeList,
      beforeRead,
      beforeCreate: () => undefined,
      afterRead: () => undefined,
    });
    await compiled?.beforeList?.(ctx);
    await compiled?.beforeRead?.(ctx, 'r1');
    expect(beforeList).toHaveBeenCalledExactlyOnceWith(ctx);
    expect(beforeRead).toHaveBeenCalledExactlyOnceWith(ctx, 'r1');
    await expect(compiled?.beforeCreate?.(ctx, {})).resolves.toBeUndefined();
    await expect(compiled?.afterRead?.(ctx, row)).resolves.toBeUndefined();
    await expect(compiled?.afterRead?.(ctx, { title: 'Incomplete' })).rejects.toThrow();
  });
});
