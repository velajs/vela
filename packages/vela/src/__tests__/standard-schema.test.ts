import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import { z } from 'zod';
import { defineDto, ValidationPipe, validateSchema, type StandardSchemaV1 } from '../validation';
import { zodToJsonSchema } from '../openapi/zod-to-json-schema';

describe('Standard Schema validation', () => {
  it('supports Valibot transformations and retains distinct DTO input/output', async () => {
    const schema = v.pipe(v.string(), v.transform(Number));
    const dto = defineDto(schema, { name: 'Numeric', jsonSchema: { type: 'string' } });
    const output: number = await dto.parse('42');
    expect(output).toBe(42);
    expect(new ValidationPipe(dto).transform('42', { type: 'body' })).toBe(42);
    expect(dto.toJSONSchema()).toEqual({ type: 'string' });
  });

  it('awaits async Zod refinements and maps nested issues', async () => {
    const schema = z.object({ email: z.string().refine(async (email) => email.includes('@')) });
    const pipe = new ValidationPipe(defineDto(schema));
    expect(await pipe.transform({ email: 'a@b' }, { type: 'body' })).toEqual({ email: 'a@b' });
    await expect(pipe.transform({ email: 'bad' }, { type: 'body' })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('accepts an explicit undefined issues property and propagates validator failures', () => {
    const schema: StandardSchemaV1<string, number> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => ({ value: 7, issues: undefined }),
      },
    };
    expect(validateSchema(schema, '7')).toBe(7);
    const broken: StandardSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => {
          throw new Error('unavailable');
        },
      },
    };
    expect(() => new ValidationPipe(broken).transform('7', { type: 'body' })).toThrow(
      'unavailable',
    );
  });

  it('converts input and output documentation independently', () => {
    const schema = {
      '~standard': {
        jsonSchema: {
          input: () => ({ type: 'string' }),
          output: () => ({ type: 'number' }),
        },
      },
    };
    expect(zodToJsonSchema(schema, 'input')).toEqual({ type: 'string' });
    expect(zodToJsonSchema(schema, 'output')).toEqual({ type: 'number' });
  });
});

it('normalizes Standard issue paths and does not downgrade unexpected errors carrying issues', async () => {
  const invalid: StandardSchemaV1 = {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: async () => ({
        issues: [{ message: 'Required', path: [{ key: 'users' }, { key: 0 }, { key: 'email' }] }],
      }),
    },
  };
  try {
    await new ValidationPipe(invalid).transform({}, { type: 'body' });
    throw Error('expected validation');
  } catch (error) {
    expect(error).toMatchObject({ statusCode: 400 });
    expect((error as { getResponse(): unknown }).getResponse()).toMatchObject({
      errors: [{ path: ['users', 0, 'email'], message: 'Required' }],
    });
  }
  const failure = Object.assign(new Error('validator offline'), {
    issues: [{ message: 'internal' }],
  });
  const broken: StandardSchemaV1 = {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: () => {
        throw failure;
      },
    },
  };
  expect(() => new ValidationPipe(broken).transform({}, { type: 'body' })).toThrow(failure);
});
it('consumes validated objects once and revalidates objects changed by middleware', async () => {
  const schema = v.object({ amount: v.pipe(v.string(), v.transform(Number)) });
  const pipe = new ValidationPipe(schema);
  const value = await pipe.transform({ amount: '5' }, { type: 'body' });
  expect(ValidationPipe.consumeValidated(value, schema)).toBe(true);
  expect(ValidationPipe.consumeValidated(value, schema)).toBe(false);
  const mutated = await pipe.transform({ amount: '5' }, { type: 'body' });
  if (mutated && typeof mutated === 'object') Object.assign(mutated, { amount: '6' });
  expect(ValidationPipe.consumeValidated(mutated, schema)).toBe(false);
});
