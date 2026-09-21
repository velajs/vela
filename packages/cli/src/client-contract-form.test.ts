import { describe, expect, it } from 'vitest';
import { generateClientContract } from './client-contract';

function document(schema: unknown, contentType = 'multipart/form-data', encoding?: unknown) {
  return {
    openapi: '3.1.0',
    paths: {
      '/forms': {
        post: {
          requestBody: {
            required: true,
            content: { [contentType]: { schema, ...(encoding !== undefined ? { encoding } : {}) } },
          },
          responses: {
            201: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      size: { type: 'integer' },
                      files: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['name', 'size', 'files'],
                    additionalProperties: false,
                  },
                },
              },
            },
            400: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { message: { type: 'string' } },
                    required: ['message'],
                    additionalProperties: false,
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

const form = {
  type: 'object',
  properties: {
    title: { type: 'string', enum: ['public', 'private'] },
    tags: { type: 'array', items: { type: 'string' } },
    file: { type: 'string', format: 'binary' },
    files: {
      type: 'array',
      items: { type: 'string', format: 'binary', contentEncoding: 'binary' },
    },
  },
  required: ['title', 'file'],
  additionalProperties: false,
};

describe('form client contract generation', () => {
  it('visits shared JSON component references once when checking binary serialization', () => {
    const schemas: Record<string, unknown> = { Leaf: { type: 'string' } };
    for (let index = 30; index >= 0; index--) {
      const child = { $ref: `#/components/schemas/${index === 30 ? 'Leaf' : `Node${index + 1}`}` };
      schemas[`Node${index}`] = {
        type: 'object',
        properties: { left: child, right: child },
        additionalProperties: false,
      };
    }
    const input = {
      ...document({ $ref: '#/components/schemas/Node0' }, 'application/json'),
      components: { schemas },
    };
    expect(generateClientContract(input).warnings).toEqual([]);
  });
  it('emits file types, literal fields, encoding metadata and every response variant', () => {
    const generated = generateClientContract(
      document(form, 'multipart/form-data', { tags: { style: 'form', explode: true } }),
    );
    expect(generated.warnings).toEqual([]);
    expect(generated.source).toContain(
      'form: { "file": (File | Blob); "files"?: Array<(File | Blob)>; "tags"?: Array<(string)>; "title": ("public" | "private") & (string); };',
    );
    expect(generated.source).toContain('"name": (string); "size": (number);');
    expect(generated.source).toContain('status: 201');
    expect(generated.source).toContain('status: 400');
    expect(generated.source).toContain('withFormEncoding(formEncodings, yourFetch)');
    expect(generated.source).toContain('"contentType": "multipart/form-data"');
  });

  it('resolves component form and binary references without making files strings', () => {
    const input = {
      ...document({ $ref: '#/components/schemas/Upload' }),
      components: {
        schemas: {
          Upload: {
            type: 'object',
            properties: { file: { $ref: '#/components/schemas/File' } },
            required: ['file'],
            additionalProperties: false,
          },
          File: { type: 'string', format: 'binary' },
        },
      },
    };
    const generated = generateClientContract(input);
    expect(generated.warnings).toEqual([]);
    expect(generated.source).toContain('form: { "file": (File | Blob); };');
    expect(generated.source).toContain('"File": (File | Blob)');
  });

  it.each([
    [{ type: 'object' }, 'named fields'],
    [{ ...form, additionalProperties: true }, 'named fields'],
    [{ ...form, oneOf: [{ type: 'object' }] }, 'named fields'],
    [{ type: 'object', properties: { value: { type: 'number' } } }, 'wire fields'],
    [
      {
        type: 'object',
        properties: {
          value: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
        },
      },
      'wire fields',
    ],
    [
      {
        type: 'object',
        properties: {
          value: { anyOf: [{ type: 'string' }, { type: 'string', format: 'binary' }] },
        },
      },
      'ambiguous',
    ],
    [{ type: 'object', properties: { value: { type: 'string', nullable: true } } }, 'ambiguous'],
    [
      { type: 'object', properties: { value: { type: 'string', contentEncoding: 'base64' } } },
      'contentEncoding',
    ],
    [{ type: 'object', properties: { value: { type: 'string', enum: [1] } } }, 'scalar literal'],
    [
      {
        type: 'object',
        properties: { value: { type: 'string', format: 'binary', const: 'file' } },
      },
      'scalar literal',
    ],
    [
      { type: 'object', properties: { value: { type: 'string', writeOnly: true } } },
      'readOnly/writeOnly',
    ],
    [
      { type: 'object', properties: { value: { $ref: 'remote.json#/File' } } },
      'unresolved reference',
    ],
  ])('rejects unrepresentable form schemas %o', (schema, error) => {
    expect(() => generateClientContract(document(schema))).toThrow(error);
  });

  it.each([
    { tags: { style: 'spaceDelimited' } },
    { tags: { explode: false } },
    { file: { contentType: 'application/octet-stream' } },
    { file: { headers: {} } },
    { title: { allowReserved: true } },
    { missing: {} },
    [],
    null,
  ])('rejects unsupported part serialization %o', (encoding) => {
    expect(() => generateClientContract(document(form, 'multipart/form-data', encoding))).toThrow(
      /form (serialization|encoding)/,
    );
  });

  it('rejects files in URL-encoded bodies, binary JSON and multiple request media', () => {
    expect(() =>
      generateClientContract(document(form, 'application/x-www-form-urlencoded')),
    ).toThrow('files require multipart');
    expect(() => generateClientContract(document(form, 'application/json'))).toThrow(
      'binary files require multipart',
    );
    const input = document(form);
    input.paths['/forms'].post.requestBody.content['application/json'] = {
      schema: { type: 'string' },
    };
    expect(() => generateClientContract(input)).toThrow('exactly one');
  });

  it('rejects binary JSON responses through component references', () => {
    const input = {
      ...document({ type: 'object', properties: {} }),
      components: { schemas: { File: { type: 'string', format: 'binary' } } },
    };
    const response = {
      content: { 'application/json': { schema: { $ref: '#/components/schemas/File' } } },
    };
    expect(() =>
      generateClientContract({
        ...input,
        paths: { '/files': { get: { responses: { 200: response } } } },
      }),
    ).toThrow('binary files require multipart');
  });
});
