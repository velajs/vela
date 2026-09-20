import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BadRequestException } from '../errors/http-exception';
import { defineDto, ValidationPipe } from '../validation';

describe('schema DTO descriptors', () => {
  it('keeps names and schemas as frozen metadata while parse returns actual data', () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const dto = defineDto(schema, { name: 'CreateUser' });
    expect(dto.name).toBe('CreateUser');
    expect(dto.schema).toBe(schema);
    expect(Object.isFrozen(dto)).toBe(true);
    expect(dto.parse({ name: 'Alice', age: 30, ignored: true })).toEqual({
      name: 'Alice',
      age: 30,
    });
    expect(() => dto.parse({})).toThrow();
  });

  it('preserves scalar, array, and transformed outputs without constructing fake instances', () => {
    expect(defineDto(z.number()).parse(42)).toBe(42);
    expect(defineDto(z.array(z.string())).parse(['Alice'])).toEqual(['Alice']);
    const length = defineDto(z.string().transform((value) => value.length));
    expect(length.parse('hello')).toBe(5);
    expect(() => length.parse(42)).toThrow();
  });

  it('delegates JSON schema generation and fails explicitly when it is unavailable', () => {
    const schema = z.object({ name: z.string() });
    expect(defineDto(schema).toJSONSchema()).toEqual(schema.toJSONSchema());
    const parser = {
      parse(value: unknown): unknown {
        return value;
      },
    };
    const dto = defineDto(parser, { name: 'CustomParser' });
    expect(dto.parse('value')).toBe('value');
    expect(() => dto.toJSONSchema()).toThrow("DTO 'CustomParser' does not provide toJSONSchema()");
  });
});

describe('validation schema boundaries', () => {
  it('shares the exact explicit parser with route introspection', () => {
    const dto = defineDto(z.string().transform((value) => value.length));
    const pipe = new ValidationPipe(dto);
    expect(pipe.parser).toBe(dto);
    expect(pipe.transform('hello', { type: 'body' })).toBe(5);
  });

  it('accepts descriptors and schema-bearing metadata through unknown metatype', () => {
    const dto = defineDto(z.object({ name: z.string() }));
    const pipe = new ValidationPipe();
    const value = { name: 'Alice', ignored: true };
    expect(pipe.transform(value, { type: 'body', metatype: dto })).toEqual({ name: 'Alice' });
    expect(pipe.transform(value, { type: 'body', metatype: { schema: dto.schema } })).toEqual({
      name: 'Alice',
    });
    expect(() =>
      pipe.transform(value, { type: 'body', metatype: { schema: { parse: true } } }),
    ).toThrow('schema without a parse() function');
  });

  it('formats validation issues but preserves unrelated parser failures', () => {
    const pipe = new ValidationPipe(z.object({ name: z.string() }));
    expect(() => pipe.transform({ name: 123 }, { type: 'body' })).toThrow(BadRequestException);
    const failure = new Error('schema unavailable');
    const broken = new ValidationPipe({
      parse(): never {
        throw failure;
      },
    });
    expect(() => broken.transform({}, { type: 'body' })).toThrow(failure);
  });
});
