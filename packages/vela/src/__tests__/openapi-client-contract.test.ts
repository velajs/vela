import { describe, expect, it } from 'vitest';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Module,
  Param,
  Post,
  Query,
  VelaFactory,
  Version,
} from '../index';
import { ApiResponse, createOpenApiDocument } from '../openapi/index';
import { defineDto, ValidationPipe } from '../validation/index';
import { z } from 'zod';

describe('OpenAPI HTTP client contract', () => {
  it('exports query DTO fields and retains unknown body shapes for diagnostics', () => {
    const Search = defineDto(z.object({ search: z.string(), page: z.string().optional() }), {
      name: 'Search',
    });
    @Controller('/contract-inputs')
    class Inputs {
      @Get()
      search(@Query(new ValidationPipe(Search)) query: ReturnType<typeof Search.parse>) {
        return query;
      }
      @Post()
      create(@Body() body: unknown) {
        return body;
      }
      @Get('/untyped')
      untyped(@Query() query: unknown) {
        return query;
      }
    }
    @Module({ controllers: [Inputs] })
    class App {}
    const document = createOpenApiDocument(App);
    const item = document.paths['/contract-inputs']!;
    expect(item.get!.parameters).toEqual([
      { name: 'search', in: 'query', required: true, schema: { type: 'string' } },
      { name: 'page', in: 'query', required: false, schema: { type: 'string' } },
    ]);
    expect(item.post!.requestBody!.content!['application/json']!.schema).toEqual({});
    expect(document.paths['/contract-inputs/untyped']!.get).toHaveProperty(
      'x-vela-client-unsupported',
    );
  });
  it('matches runtime versions, global prefixes and explicit response statuses', async () => {
    @Controller({ path: '/users', version: 1 })
    class Users {
      @Get('/:id')
      @Version([2, 3])
      @ApiResponse(200, {
        description: 'User',
        schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      })
      find(@Param('id') id: string) {
        return { id };
      }

      @Post()
      @HttpCode(201)
      @ApiResponse(201, { description: 'Created', schema: { type: 'object' } })
      create() {
        return { id: 'u1' };
      }
    }
    @Module({ controllers: [Users] })
    class App {}
    const app = await VelaFactory.create(App, { globalPrefix: '/api' });
    try {
      const document = createOpenApiDocument(App, { globalPrefix: app.getGlobalPrefix() });
      expect(Object.keys(document.paths).sort()).toEqual([
        '/api/v1/users',
        '/api/v2/users/{id}',
        '/api/v3/users/{id}',
      ]);
      expect(Object.keys(document.paths['/api/v1/users']!.post!.responses)).toEqual(['201']);
      for (const version of [2, 3]) {
        const response = await app.fetch(
          new Request(`https://example.com/api/v${version}/users/u1`),
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ id: 'u1' });
      }
      const created = await app.fetch(
        new Request('https://example.com/api/v1/users', { method: 'POST' }),
      );
      expect(created.status).toBe(201);
    } finally {
      await app.dispose();
    }
  });
});
