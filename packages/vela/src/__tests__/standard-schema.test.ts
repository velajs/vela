import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import { z } from 'zod';
import { defineDto, ValidationPipe, validateSchema, type StandardSchemaV1 } from '../validation';
import { BadRequestException } from '../errors/http-exception';
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
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error).toMatchObject({ statusCode: 400, message: 'Validation failed' });
    expect((error as BadRequestException).getDetails()).toEqual([
      { path: ['users', 0, 'email'], message: 'Required' },
    ]);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      details: [{ path: ['users', 0, 'email'], message: 'Required' }],
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
it('does not retain validation authority across boundaries', async () => {
  const schema = v.object({ amount: v.pipe(v.string(), v.transform(Number)) });
  const value = await new ValidationPipe(schema).transform({ amount: '5' }, { type: 'body' });
  expect(ValidationPipe.consumeValidated(value, schema)).toBe(false);
  expect(ValidationPipe.consumeValidated(value, schema)).toBe(false);
});

it('lets generated handlers own validation while retaining explicit pipe behavior', async () => {
  const schema = v.object({ amount: v.pipe(v.string(), v.transform(Number)) });
  const metatype = { ...defineDto(schema), validationOwner: 'handler' };
  const raw = { amount: '5' };
  expect(new ValidationPipe().transform(raw, { type: 'body', metatype })).toBe(raw);
  expect(await new ValidationPipe(schema).transform(raw, { type: 'body', metatype })).toEqual({
    amount: 5,
  });
});

it('maps async legacy input failures without forwarding vendor values', async () => {
  const pipe = new ValidationPipe({
    parse: async () => {
      throw { issues: [{ message: 'Invalid', path: ['value'], input: 'secret' }] };
    },
  });
  try {
    await pipe.transform({}, { type: 'body' });
    throw new Error('expected rejection');
  } catch (error) {
    expect(error).toMatchObject({ statusCode: 400 });
    const details = error instanceof BadRequestException ? error.getDetails() : undefined;
    expect(details).toEqual([{ message: 'Invalid', path: ['value'] }]);
    expect(JSON.stringify(details)).not.toContain('secret');
  }
});

it('offers explicit async pipe execution without changing synchronous transform results', async () => {
  let calls = 0;
  const schema = z.string().transform(async (value) => {
    calls += 1;
    return Number(value);
  });
  const pipe = new ValidationPipe(schema);
  expect(await pipe.transformAsync('7', { type: 'body' })).toBe(7);
  expect(calls).toBe(1);
  const sync = new ValidationPipe(z.string());
  expect(sync.transform('sync', { type: 'body' })).toBe('sync');
  await expect(pipe.transformAsync(false, { type: 'body' })).rejects.toMatchObject({
    statusCode: 400,
  });
});
