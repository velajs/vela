/// <reference types="node" />
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import * as v from 'valibot';
import {
  defineDto,
  parseSchema,
  parseSchemaAsync,
  SchemaValidationError,
  type StandardSchemaV1,
} from '../validation';

describe('shared schema boundary', () => {
  it('preserves sync DTO parsing and adds async parsing for Zod refinements', async () => {
    const sync = defineDto(z.string().transform((value) => value.length));
    expect(sync.parse('abc')).toBe(3);
    const dto = defineDto(z.string().refine(async (value) => value === 'yes'));
    expect(await dto.parseAsync('yes')).toBe('yes');
    await expect(dto.parseAsync('no')).rejects.toBeInstanceOf(SchemaValidationError);
  });

  it('runs async Zod refinements and transforms once, without a speculative sync parse', async () => {
    const transform = vi.fn(async (value: string) => Number(value));
    const schema = z.object({ value: z.string().transform(transform) });
    expect(await parseSchemaAsync(schema, { value: '4' })).toEqual({ value: 4 });
    expect(transform).toHaveBeenCalledTimes(1);
    const failure = Object.assign(new Error('offline'), {
      issues: [{ message: 'not input data' }],
    });
    const broken = z.string().transform(async () => {
      throw failure;
    });
    await expect(parseSchemaAsync(broken, 'value')).rejects.toBe(failure);
  });

  it('parses Standard-only descriptors once, including transformations', async () => {
    const transform = vi.fn(async (value: string) => Number(value));
    const schema = v.pipeAsync(v.string(), v.transformAsync(transform));
    const dto = defineDto(schema, { jsonSchema: { type: 'string' } });
    expect(await parseSchema(dto, '42')).toBe(42);
    expect(transform).toHaveBeenCalledTimes(1);
  });

  it('prefers legacy parseAsync and preserves its receiver', async () => {
    const schema = {
      number: 7,
      parse: vi.fn(() => {
        throw new Error('sync path');
      }),
      async parseAsync() {
        return this.number;
      },
    };
    expect(await parseSchemaAsync(schema, null)).toBe(7);
    expect(schema.parse).not.toHaveBeenCalled();
    expect(parseSchema({ parse: (value) => value }, 'sync')).toBe('sync');
  });

  it('normalizes legacy validation failures but keeps unrelated failures internal', async () => {
    const invalid = {
      parse: () =>
        Promise.reject({
          issues: [
            {
              message: 'Required',
              path: ['a.b', 0],
              code: 'required',
              input: 'secret',
              extra: true,
            },
          ],
        }),
    };
    await expect(parseSchemaAsync(invalid, {})).rejects.toMatchObject({
      issues: [{ message: 'Required', path: ['a.b', 0], code: 'required' }],
    });
    try {
      await parseSchemaAsync(invalid, {});
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaValidationError);
      if (error instanceof SchemaValidationError)
        expect(error.issues[0]).not.toHaveProperty('input');
    }
    const failure = Object.assign(new Error('offline'), { issues: [{ message: 'internal' }] });
    const schema: StandardSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: async () => {
          throw failure;
        },
      },
    };
    await expect(parseSchemaAsync(schema, {})).rejects.toBe(failure);
  });

  it('accepts promises across realms and rejects malformed vendor result data', async () => {
    const { runInNewContext } = await import('node:vm');
    const result: unknown = runInNewContext('Promise.resolve({ value: 12 })');
    const schema = { '~standard': { version: 1 as const, vendor: 'test', validate: () => result } };
    // Runtime protocol checks reject malformed schemas/results, even from untyped integrations.
    // @ts-expect-error intentionally unknown result from an external realm
    expect(await parseSchemaAsync(schema, null)).toBe(12);
    const invalid = {
      parse: () => {
        throw { issues: [{ path: [null] }] };
      },
    };
    await expect(parseSchemaAsync(invalid, null)).rejects.toBeInstanceOf(TypeError);
  });
});
