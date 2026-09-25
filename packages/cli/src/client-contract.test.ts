import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OpenApiDocument } from '@velajs/vela/openapi';
import { afterEach, describe, expect, it } from 'vitest';
import { generateClientContract } from './client-contract.js';

export const clientDocument: OpenApiDocument = {
  openapi: '3.1.0',
  info: { title: 'Test', version: '1' },
  components: {
    schemas: {
      User: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          next: { $ref: '#/components/schemas/User', nullable: true },
        },
        required: ['id', 'name'],
        additionalProperties: false,
      },
      CreateUser: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      },
    },
  },
  paths: {
    '/users/{id}': {
      get: {
        parameters: [
          { in: 'query', name: 'page', schema: { type: 'integer' } },
          {
            in: 'query',
            name: 'expand',
            schema: { type: 'array', items: { type: 'string', enum: ['team', 'roles'] } },
          },
        ],
        responses: {
          200: {
            description: 'User',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } },
          },
          404: {
            description: 'Missing',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { error: { type: 'string' } },
                  required: ['error'],
                  additionalProperties: false,
                },
              },
            },
          },
        },
      },
    },
    '/users': {
      post: {
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateUser' } } },
        },
        responses: {
          201: {
            description: 'Created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } },
          },
        },
      },
    },
    '/empty': { delete: { responses: { 204: { description: 'Deleted' } } } },
    '/health': {
      get: {
        responses: {
          200: {
            description: 'OK',
            content: { 'text/plain': { schema: { type: 'string', const: 'ok' } } },
          },
        },
      },
    },
  },
};

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('generateClientContract', () => {
  it('generates a deterministic type-only contract with references and statuses', () => {
    const result = generateClientContract(clientDocument);
    expect(result.warnings).toEqual([]);
    expect(result.source).toContain('"/users/:id"');
    expect(result.source).toContain('query?:');
    expect(result.source).toContain('"page"?: string');
    expect(result.source).toContain('"expand"?: Array<"team" | "roles">');
    expect(result.source).toContain('status: 404');
    expect(result.source).not.toContain('@velajs/vela');
    expect(result.source).not.toContain('import {');
    expect(
      generateClientContract({
        ...clientDocument,
        paths: Object.fromEntries(Object.entries(clientDocument.paths).toReversed()),
      }).source,
    ).toBe(result.source);
  });

  it('compiles generated hc inputs and status-narrowed responses with negative type checks', () => {
    const dir = mkdtempSync(join(process.cwd(), '.client-types-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'api.ts'), generateClientContract(clientDocument).source);
    writeFileSync(
      join(dir, 'consumer.ts'),
      `
      import { hc } from '@velajs/client/http';
      import type { InferRequestType, InferResponseType } from '@velajs/client/http';
      import type { AppType, Schemas } from './api.js';
      const client = hc<AppType>('https://example.com');
      const input: InferRequestType<typeof client.users.$post> = { json: { name: 'Ada' } };
      const created: Schemas['User'] = await (await client.users.$post(input)).json();
      created.name.toUpperCase();
      type Found = InferResponseType<typeof client.users[':id']['$get'], 200>;
      const found: Found = created;
      found.id.toUpperCase();
      const response = await client.users[':id'].$get({ param: { id: 'u1' }, query: { page: '2', expand: ['team'] } });
      if (response.status === 404) { const error: string = (await response.json()).error; error.toUpperCase(); }
      if (response.ok) { const name: string = (await response.json()).name; name.toUpperCase(); }
      await client.empty.$delete();
      const health: 'ok' = await (await client.health.$get()).text();
      health.toUpperCase();
      // @ts-expect-error unknown route
      client.missing.$get();
      // @ts-expect-error missing path
      client.users[':id'].$get();
      // @ts-expect-error wrong body
      client.users.$post({ json: { name: 1 } });
      // @ts-expect-error required JSON body
      client.users.$post();
      // @ts-expect-error query values use wire strings
      client.users[':id'].$get({ param: { id: 'u1' }, query: { page: 2 } });
      // @ts-expect-error enum constrained array
      client.users[':id'].$get({ param: { id: 'u1' }, query: { expand: ['invalid'] } });
      // @ts-expect-error wrong method
      client.users.$get();
    `,
    );
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          noUnusedLocals: true,
          skipLibCheck: false,
          types: [],
          target: 'ES2024',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          lib: ['ES2024', 'DOM', 'DOM.Iterable'],
        },
        include: ['*.ts'],
      }),
    );
    const tsc = join(
      dirname(fileURLToPath(import.meta.resolve('typescript/package.json'))),
      'bin/tsc',
    );
    try {
      execFileSync(process.execPath, [tsc, '-p', join(dir, 'tsconfig.json')], { encoding: 'utf8' });
    } catch (error) {
      throw new Error(String(error instanceof Error && 'stdout' in error ? error.stdout : error), {
        cause: error,
      });
    }
  });

  it('warns for unknown schemas instead of inventing types', () => {
    const document: OpenApiDocument = {
      ...clientDocument,
      components: undefined,
      paths: { '/unknown': { get: { responses: { 200: { description: 'OK' } } } } },
    };
    const result = generateClientContract(document);
    expect(result.source).toContain('output: unknown');
    expect(result.warnings).toEqual(['GET /unknown response 200: no schema; emitted unknown.']);
  });

  it('handles unions, nullable arrays, dictionaries and boolean schemas', () => {
    const document: OpenApiDocument = {
      ...clientDocument,
      components: {
        schemas: {
          Choice: {
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: ['integer', 'null'] } }],
            nullable: true,
          },
          Map: { type: 'object', additionalProperties: { type: 'boolean' } },
          Closed: { type: 'object', additionalProperties: false },
        },
      },
      paths: {},
    };
    const result = generateClientContract(document);
    expect(result.warnings).toEqual([]);
    expect(result.source).toContain('Array<');
    expect(result.source).toContain('[key: string]: (boolean)');
    expect(result.source).toContain('Record<string, never>');
  });

  it.each(['/users/{id}.json', '/users/:id?', '/users/*', '/index', '/then', '/users//other'])(
    'rejects a path that hc cannot represent: %s',
    (path) => {
      expect(() =>
        generateClientContract({
          ...clientDocument,
          paths: { [path]: clientDocument.paths['/users']! },
        }),
      ).toThrow(/path/i);
    },
  );

  it('rejects unresolved refs and unsupported body encodings', () => {
    const document = structuredClone(clientDocument);
    document.components!.schemas!.User = { $ref: 'remote.json#/User' };
    expect(() => generateClientContract(document)).toThrow('unresolved reference');
    document.components = clientDocument.components;
    document.paths['/users']!.post!.requestBody = {
      content: { 'multipart/form-data': { schema: { type: 'object' } } },
    };
    expect(() => generateClientContract(document)).toThrow('named fields');
  });

  it('keeps status ranges and default responses disjoint from explicit statuses', () => {
    const response = {
      description: 'Error',
      content: { 'application/json': { schema: { type: 'string' } } },
    };
    const result = generateClientContract({
      ...clientDocument,
      components: undefined,
      paths: {
        '/status': { get: { responses: { 404: response, '4XX': response, default: response } } },
      },
    });
    expect(result.warnings).toEqual([]);
    expect(result.source).toContain('HttpApp, HttpStatus');
    expect(result.source).toContain('status: 404');
    expect(result.source).toContain('Exclude<Extract<HttpStatus, 400');
    expect(result.source).toContain('499>, 404>');
    expect(result.source).toContain('Exclude<HttpStatus, 404 | Extract<HttpStatus');
  });

  it('sends array query parameters documented as form/explode as repeated keys', () => {
    const tag = (serialization: { style?: 'form'; explode?: boolean }) => ({
      ...clientDocument,
      components: undefined,
      paths: {
        '/search': {
          get: {
            parameters: [
              {
                in: 'query' as const,
                name: 'tag',
                schema: { type: 'array', items: { type: 'string' } },
                ...serialization,
              },
            ],
            responses: { 200: { description: 'OK' } },
          },
        },
      },
    });
    expect(generateClientContract(tag({ style: 'form', explode: true })).source).toContain(
      'query?: { "tag"?: Array<string>; }',
    );
    expect(() => generateClientContract(tag({ style: 'form', explode: false }))).toThrow(
      'custom parameter serialization',
    );
    const path = {
      ...clientDocument,
      components: undefined,
      paths: {
        '/items/{id}': {
          get: {
            parameters: [
              { in: 'path' as const, name: 'id', required: true, style: 'form' as const },
            ],
            responses: { 200: { description: 'OK' } },
          },
        },
      },
    };
    expect(() => generateClientContract(path)).toThrow('custom parameter serialization');
  });

  it('types a query parameter documented as one value or repeated keys', () => {
    const oneOrMany = (location: 'query' | 'header') => ({
      ...clientDocument,
      components: undefined,
      paths: {
        '/search': {
          get: {
            parameters: [
              {
                in: location,
                name: 'role',
                schema: {
                  oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
                },
                ...(location === 'query' ? { style: 'form' as const, explode: true } : {}),
              },
            ],
            responses: { 200: { description: 'OK' } },
          },
        },
      },
    });
    expect(generateClientContract(oneOrMany('query')).source).toContain(
      'query?: { "role"?: string | Array<string>; }',
    );
    expect(() => generateClientContract(oneOrMany('header'))).toThrow(
      'only query parameters support arrays',
    );
    const structured = oneOrMany('query');
    structured.paths['/search'].get.parameters[0]!.schema.oneOf.push({ type: 'object' });
    expect(() => generateClientContract(structured)).toThrow('structured parameters');
  });

  it('rejects unsupported statuses and direction-dependent schemas', () => {
    const document = structuredClone(clientDocument);
    document.paths['/empty']!.delete!.responses = { 299: { description: 'Unofficial' } };
    expect(() => generateClientContract(document)).toThrow('unsupported response status 299');
    document.paths['/empty'] = clientDocument.paths['/empty'];
    document.components!.schemas!.User!.properties!.id!.readOnly = true;
    expect(() => generateClientContract(document)).toThrow('readOnly/writeOnly');
  });
});
