import { describe, expect, it } from 'vitest';
import { generateClientContract } from './client-contract.js';

function document(schema: unknown): unknown {
  return {
    openapi: '3.1.0',
    paths: {
      '/value': { get: { responses: { 200: { content: { 'application/json': { schema } } } } } },
    },
  };
}

describe('unknown OpenAPI contract boundary', () => {
  it.each([
    { type: 42 },
    { type: ['string', 42] },
    { type: [] },
    { type: 'function' },
    { type: 'object', properties: { child: { type: 42 } } },
    { type: 'array', items: { properties: [] } },
    { required: 'id' },
    { enum: 'red' },
    { enum: [Number.NaN] },
    { const: Number.POSITIVE_INFINITY },
    { nullable: 'yes' },
    { readOnly: 'yes' },
    { additionalProperties: 'yes' },
    { allOf: {} },
    { anyOf: [null] },
    { $ref: 42 },
  ])('rejects malformed nested schemas without pretending they are typed: %j', (schema) => {
    expect(() => generateClientContract(document(schema))).toThrow(
      'Invalid OpenAPI client contract',
    );
  });

  it.each([
    { get: [] },
    { get: { responses: [] } },
    { get: { responses: { 200: null } } },
    { get: { responses: {}, parameters: {} } },
    { get: { responses: {}, parameters: [{ name: 'id', in: 'elsewhere' }] } },
    { get: { responses: {}, parameters: [{ name: 'id', in: 'query', required: 'yes' }] } },
    { get: { responses: {}, 'x-vela-client-unsupported': 'bad' } },
    { post: { responses: {}, requestBody: { content: [] } } },
  ])('rejects invalid operation shapes: %j', (item) => {
    expect(() => generateClientContract({ openapi: '3.0.3', paths: { '/value': item } })).toThrow(
      'Invalid OpenAPI client contract',
    );
  });

  it('preserves valid OpenAPI 3.0 input and boolean/nullable schemas', () => {
    const result = generateClientContract({
      openapi: '3.0.3',
      paths: {},
      components: {
        schemas: {
          Anything: true,
          Nothing: false,
          Nested: { type: 'object', properties: { forbidden: false } },
          Nullable: {
            type: ['object', 'null'],
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
        },
      },
    });
    expect(result.warnings).toEqual([]);
    expect(result.source).toContain('"Anything": unknown');
    expect(result.source).toContain('"Nothing": never');
    expect(result.source).toContain('"forbidden"?: never');
    expect(result.source).toContain('| (null)');
  });

  it('does not silently discard unresolved response refs or unsupported schema keywords', () => {
    expect(() =>
      generateClientContract({
        openapi: '3.1.0',
        paths: { '/value': { get: { responses: { 200: { $ref: '#/components/responses/Ok' } } } } },
      }),
    ).toThrow('resolve response references');
    expect(() =>
      generateClientContract(
        document({ type: 'object', patternProperties: { '^x': { type: 'string' } } }),
      ),
    ).toThrow('unsupported schema keyword patternProperties');
  });

  it('reports object cycles instead of overflowing; recursive $refs remain supported', () => {
    const schema: { type: string; properties: Record<string, unknown> } = {
      type: 'object',
      properties: {},
    };
    schema.properties.self = schema;
    expect(() => generateClientContract(document(schema))).toThrow('contains a cycle');
  });
});
