import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Body,
  Controller,
  Cookie,
  Get,
  Headers,
  Module,
  Param,
  Post,
  Query,
  VelaFactory,
} from '../index.js';
import { createOpenApiDocument } from '../openapi/index.js';
import { defineDto } from '../validation/index.js';
import type { ArgumentMetadata, PipeTransform, Type } from '../index.js';
import type { StandardSchemaV1 } from '../validation/index.js';

// A validator from no particular library: a Standard Schema without Zod's
// `transform()` method, which the pipe-only signature used to reject.
function minLength(length: number): StandardSchemaV1<string, string> {
  return {
    '~standard': {
      version: 1,
      vendor: 'synthetic',
      validate: (value) =>
        typeof value === 'string' && value.length >= length
          ? { value }
          : { issues: [{ message: `Expected at least ${length} characters` }] },
    },
  };
}

async function request(module: Type, path: string, init?: RequestInit): Promise<Response> {
  const app = await VelaFactory.create(module);
  return app.getHonoApp().request(path, init);
}

function postJson(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('schema arguments on parameter decorators', () => {
  const CreateNote = z.object({
    title: z.string().min(1),
    tags: z.array(z.string()).default([]),
  });

  @Controller('/notes')
  class NotesController {
    @Post()
    create(@Body(CreateNote) body: z.output<typeof CreateNote>) {
      return body;
    }
  }

  @Module({ controllers: [NotesController] })
  class NotesModule {}

  it('validates @Body(schema) and hands the handler its parsed output', async () => {
    const valid = await request(NotesModule, '/notes', postJson({ title: 'Plan' }));
    expect(valid.status).toBe(201);
    expect(await valid.json()).toEqual({ title: 'Plan', tags: [] });

    const invalid = await request(NotesModule, '/notes', postJson({ title: '' }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: {
        code: 'bad_request',
        message: 'Validation failed',
        details: { issues: [expect.objectContaining({ path: ['title'] })] },
      },
    });
  });

  it('documents the @Body schema as the OpenAPI request body', () => {
    const operation = createOpenApiDocument(NotesModule).paths['/notes']?.post;
    const schema = operation?.requestBody?.content?.['application/json']?.schema;
    expect(operation?.requestBody?.required).toBe(true);
    expect(schema?.type).toBe('object');
    expect(Object.keys(schema?.properties ?? {})).toEqual(['title', 'tags']);
    expect(schema?.required).toEqual(['title']);
  });

  it('references a defineDto descriptor as a named component and validates with it', async () => {
    const RenameNote = defineDto(z.object({ title: z.string().min(1) }), { name: 'RenameNote' });

    @Controller('/renames')
    class RenamesController {
      @Post()
      rename(@Body(RenameNote) body: ReturnType<typeof RenameNote.parse>) {
        return body;
      }
    }

    @Module({ controllers: [RenamesController] })
    class RenamesModule {}

    const document = createOpenApiDocument(RenamesModule);
    expect(
      document.paths['/renames']?.post?.requestBody?.content?.['application/json']?.schema,
    ).toEqual({ $ref: '#/components/schemas/RenameNote' });
    expect(document.components?.schemas?.RenameNote?.required).toEqual(['title']);

    const invalid = await request(RenamesModule, '/renames', postJson({}));
    expect(invalid.status).toBe(400);
  });

  it('validates @Query(schema) and @Query(name, schema)', async () => {
    const Page = z.object({ page: z.coerce.number().int().min(1) });

    @Controller('/search')
    class SearchController {
      @Get()
      list(
        @Query(Page) query: z.output<typeof Page>,
        @Query('limit', z.coerce.number().int().max(50)) limit: number,
      ) {
        return { page: query.page, limit };
      }
    }

    @Module({ controllers: [SearchController] })
    class SearchModule {}

    const valid = await request(SearchModule, '/search?page=2&limit=10');
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ page: 2, limit: 10 });
    expect((await request(SearchModule, '/search?page=0&limit=10')).status).toBe(400);
    expect((await request(SearchModule, '/search?page=1&limit=500')).status).toBe(400);

    const parameters = createOpenApiDocument(SearchModule).paths['/search']?.get?.parameters;
    expect(parameters?.map(({ name, in: location }) => `${location}:${name}`)).toEqual([
      'query:page',
      'query:limit',
    ]);
    expect(parameters?.find(({ name }) => name === 'limit')?.schema?.maximum).toBe(50);
  });

  it('validates @Param(name, schema) and documents the path parameter', async () => {
    @Controller('/items')
    class ItemsController {
      @Get('/:id')
      show(@Param('id', z.uuid()) id: string) {
        return { id };
      }
    }

    @Module({ controllers: [ItemsController] })
    class ItemsModule {}

    const id = '8f14e45f-ceea-4e7a-9c1b-2f5d8a1e0b3c';
    expect((await request(ItemsModule, `/items/${id}`)).status).toBe(200);
    expect((await request(ItemsModule, '/items/not-a-uuid')).status).toBe(400);

    const [parameter] =
      createOpenApiDocument(ItemsModule).paths['/items/{id}']?.get?.parameters ?? [];
    expect(parameter).toMatchObject({ name: 'id', in: 'path', schema: { format: 'uuid' } });
  });

  it('accepts any Standard Schema for @Headers(name, schema) and @Cookie(name, schema)', async () => {
    @Controller('/tenant')
    class TenantController {
      @Get()
      show(
        @Headers('x-tenant', minLength(3)) tenant: string,
        @Cookie('theme', z.enum(['light', 'dark'])) theme: 'light' | 'dark',
      ) {
        return { tenant, theme };
      }
    }

    @Module({ controllers: [TenantController] })
    class TenantModule {}

    const valid = await request(TenantModule, '/tenant', {
      headers: { 'x-tenant': 'acme', cookie: 'theme=dark' },
    });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ tenant: 'acme', theme: 'dark' });

    const shortTenant = await request(TenantModule, '/tenant', {
      headers: { 'x-tenant': 'ab', cookie: 'theme=dark' },
    });
    expect(shortTenant.status).toBe(400);
    expect(await shortTenant.json()).toMatchObject({
      error: { details: { issues: [{ message: 'Expected at least 3 characters' }] } },
    });

    const unknownTheme = await request(TenantModule, '/tenant', {
      headers: { 'x-tenant': 'acme', cookie: 'theme=blue' },
    });
    expect(unknownTheme.status).toBe(400);
  });

  it('runs pipes written after a schema on its validated output', async () => {
    class DoublePipe implements PipeTransform<number, number> {
      transform(value: number, _metadata: ArgumentMetadata): number {
        return value * 2;
      }
    }

    @Controller('/double')
    class DoubleController {
      @Get()
      double(@Query('n', z.coerce.number(), DoublePipe) n: number) {
        return { n };
      }
    }

    @Module({ controllers: [DoubleController] })
    class DoubleModule {}

    const valid = await request(DoubleModule, '/double?n=4');
    expect(await valid.json()).toEqual({ n: 8 });
    expect((await request(DoubleModule, '/double?n=four')).status).toBe(400);
  });

  it('keeps a pipe instance that holds a schema as a pipe', async () => {
    class EnvelopePipe implements PipeTransform {
      constructor(readonly schema: z.ZodString) {}

      transform(value: unknown, _metadata: ArgumentMetadata): unknown {
        return { received: value };
      }
    }

    @Controller('/envelope')
    class EnvelopeController {
      @Post()
      wrap(@Body(new EnvelopePipe(z.string())) body: unknown) {
        return body;
      }
    }

    @Module({ controllers: [EnvelopeController] })
    class EnvelopeModule {}

    const response = await request(EnvelopeModule, '/envelope', postJson({ any: 1 }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ received: { any: 1 } });
  });
});
