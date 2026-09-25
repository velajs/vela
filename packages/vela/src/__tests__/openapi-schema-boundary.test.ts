import { describe, expect, it } from 'vitest';
import { parseJsonSchema } from '../openapi/json-schema';
import { zodToJsonSchema } from '../openapi/zod-to-json-schema';
import { Controller, Get, Module } from '../index';
import { ApiResponse, createOpenApiDocument } from '../openapi/index';

describe('OpenAPI schema reflection boundary', () => {
  it.each([
    { type: 42 },
    { type: 'function' },
    { type: 'object', properties: { id: { type: 42 } } },
    { items: [] },
    { required: [42] },
    { enum: [Number.NaN] },
    { anyOf: [null] },
    { nullable: 'true' },
    { additionalProperties: 'false' },
  ])('rejects malformed schemas from conversion callbacks: %j', (result) => {
    expect(() => zodToJsonSchema({ toJSONSchema: () => result })).toThrow();
  });

  it('preserves unknown schema extensions without asserting their types', () => {
    const schema = parseJsonSchema({
      type: 'object',
      properties: { id: { type: 'string' } },
      additionalProperties: false,
      'x-label': { title: 'ID' },
    });
    expect(schema.properties?.id?.type).toBe('string');
    expect(schema['x-label']).toEqual({ title: 'ID' });
  });

  it('rejects raw JSON Schema in @ApiResponse when the decorator is applied', () => {
    expect(() =>
      ApiResponse({
        status: 200,
        description: 'Invalid',
        // @ts-expect-error @ApiResponse documents a Standard Schema, not raw JSON Schema
        schema: { type: 'object', properties: { id: { type: 42 } } },
      }),
    ).toThrow('Standard Schema');
  });

  it('rejects a Standard Schema whose JSON Schema export is malformed during document generation', () => {
    const malformed = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: (value: unknown) => ({ value }),
        jsonSchema: {
          input: () => ({ type: 'object' }),
          output: () => ({ type: 'object', properties: { id: { type: 42 } } }),
        },
      },
    };
    @Controller('/malformed-schema')
    class Example {
      @Get()
      @ApiResponse({ status: 200, description: 'Invalid', schema: malformed })
      find() {
        return { id: 'u1' };
      }
    }
    @Module({ controllers: [Example] })
    class App {}
    expect(() => createOpenApiDocument(App)).toThrow('properties.id.type');
  });

  it('retains explicit missing-schema behavior when export is unavailable', () => {
    expect(
      zodToJsonSchema({
        toJSONSchema() {
          throw new Error('transform is not representable');
        },
      }),
    ).toEqual({});
  });
});
