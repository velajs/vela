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

  it('rejects invalid raw ApiResponse schemas during document generation', () => {
    @Controller('/malformed-schema')
    class Example {
      @Get()
      @ApiResponse(200, {
        description: 'Invalid',
        schema: { type: 'object', properties: { id: { type: 42 } } },
      })
      find() {
        return { id: 'u1' };
      }
    }
    @Module({ controllers: [Example] })
    class App {}
    expect(() => createOpenApiDocument(App)).toThrow('@ApiResponse schema.properties.id.type');
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
