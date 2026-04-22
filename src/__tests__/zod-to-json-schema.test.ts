import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from '../openapi/index.js';

describe('zodToJsonSchema — primitives', () => {
  it('string', () => {
    expect(zodToJsonSchema(z.string())).toEqual({ type: 'string' });
  });

  it('string with email format', () => {
    const out = zodToJsonSchema(z.string().email());
    expect(out.type).toBe('string');
    expect(out.format).toBe('email');
  });

  it('string with url format', () => {
    const out = zodToJsonSchema(z.string().url());
    expect(out.type).toBe('string');
    expect(out.format).toBe('uri');
  });

  it('string with min/max length', () => {
    expect(zodToJsonSchema(z.string().min(3).max(10))).toEqual({
      type: 'string',
      minLength: 3,
      maxLength: 10,
    });
  });

  it('number', () => {
    expect(zodToJsonSchema(z.number())).toEqual({ type: 'number' });
  });

  it('number with int/min/max', () => {
    expect(zodToJsonSchema(z.number().int().min(0).max(100))).toEqual({
      type: 'integer',
      minimum: 0,
      maximum: 100,
    });
  });

  it('boolean', () => {
    expect(zodToJsonSchema(z.boolean())).toEqual({ type: 'boolean' });
  });

  it('datetime string', () => {
    // Zod v4 refuses to convert z.date() (not representable in JSON Schema).
    // Recommended pattern for API DTOs is z.string().datetime() / .iso.datetime().
    const out = zodToJsonSchema(z.string().datetime());
    expect(out.type).toBe('string');
    expect(out.format).toBe('date-time');
  });

  it('z.date() falls back to empty schema (Zod v4 cannot represent it)', () => {
    const out = zodToJsonSchema(z.date());
    expect(out).toEqual({});
  });
});

describe('zodToJsonSchema — composites', () => {
  it('array of strings', () => {
    expect(zodToJsonSchema(z.array(z.string()))).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
  });

  it('object with required fields', () => {
    const out = zodToJsonSchema(z.object({ a: z.string(), b: z.number() }));
    expect(out.type).toBe('object');
    expect(out.properties?.a).toEqual({ type: 'string' });
    expect(out.properties?.b).toEqual({ type: 'number' });
    expect(out.required).toEqual(['a', 'b']);
  });

  it('object with optional fields — not in required', () => {
    const out = zodToJsonSchema(z.object({ a: z.string(), b: z.number().optional() }));
    expect(out.required).toEqual(['a']);
  });

  it('object with default — field has default, still required post-parse', () => {
    // Zod v4 treats a defaulted field as always-present after parse, so it
    // emits it in `required`. The `default` sits on the property schema.
    const out = zodToJsonSchema(z.object({ a: z.string().default('x') }));
    expect(out.required).toContain('a');
    expect((out.properties?.a as { default: unknown }).default).toBe('x');
  });

  it('union → anyOf', () => {
    const out = zodToJsonSchema(z.union([z.string(), z.number()]));
    expect(out.anyOf).toHaveLength(2);
    expect(out.anyOf?.[0]).toEqual({ type: 'string' });
    expect(out.anyOf?.[1]).toEqual({ type: 'number' });
  });

  it('enum', () => {
    const out = zodToJsonSchema(z.enum(['a', 'b', 'c']));
    expect(out.enum).toEqual(['a', 'b', 'c']);
  });

  it('literal', () => {
    const out = zodToJsonSchema(z.literal('yes'));
    expect(out.const).toBe('yes');
    expect(out.type).toBe('string');
  });

  it('record → additionalProperties', () => {
    const out = zodToJsonSchema(z.record(z.string(), z.number()));
    expect(out.type).toBe('object');
    expect(out.additionalProperties).toEqual({ type: 'number' });
  });

  it('nullable → anyOf [value, null]', () => {
    const out = zodToJsonSchema(z.string().nullable());
    expect(out.anyOf).toHaveLength(2);
    expect(out.anyOf?.[0]).toEqual({ type: 'string' });
    expect(out.anyOf?.[1]).toEqual({ type: 'null' });
  });
});

describe('zodToJsonSchema — nested', () => {
  it('nested objects', () => {
    const schema = z.object({
      user: z.object({
        id: z.string().uuid(),
        name: z.string(),
      }),
    });
    const out = zodToJsonSchema(schema);
    expect(out.properties?.user?.type).toBe('object');
    expect((out.properties?.user?.properties as { id: { format: string } })?.id.format).toBe('uuid');
  });
});
