import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { Controller, Get, Post, Module, HttpCode, VelaFactory } from '../index.js';
import { defineDto } from '../validation/index.js';
import {
  createOpenApiDocument,
  ApiResponse,
  type CreateOpenApiDocumentOptions,
  type OpenApiInfo,
} from '../openapi/index.js';
import type { Type } from '../index.js';

describe('OpenAPI document info', () => {
  it('types the info option with the exported OpenApiInfo', () => {
    const info: Partial<OpenApiInfo> = { title: 'Catalog', version: '2.0.0' };
    const options: CreateOpenApiDocumentOptions = { info };
    @Module({})
    class AppModule {}
    expect(createOpenApiDocument(AppModule, options).info).toMatchObject(info);
  });
});

describe('@ApiResponse', () => {
  it('registers a response with description and a Zod DTO schema (via $ref)', () => {
    const UserSchema = z.object({ id: z.string(), name: z.string() });
    const UserDto = defineDto(UserSchema, { name: 'UserDto' });

    @Controller('/users')
    class UsersController {
      @Get('/:id')
      @ApiResponse({ status: 200, description: 'User found', schema: UserDto })
      findOne() {
        return {};
      }
    }

    @Module({ controllers: [UsersController] })
    class AppModule {}

    const doc = createOpenApiDocument(AppModule);
    const op = doc.paths['/users/{id}']!.get!;
    const res = op.responses['200']!;
    expect(res.description).toBe('User found');
    const schema = res.content!['application/json']!.schema;
    expect(schema.$ref).toBe('#/components/schemas/UserDto');
    const resolved = doc.components!.schemas!['UserDto']!;
    expect(resolved.type).toBe('object');
    expect(resolved.properties).toHaveProperty('id');
    expect(resolved.properties).toHaveProperty('name');
  });

  it('supports multiple @ApiResponse on one handler for different status codes', () => {
    const ErrorSchema = z.object({ message: z.string() });
    const ErrorDto = defineDto(ErrorSchema, { name: 'ErrorDto' });

    @Controller('/users')
    class UsersController {
      @Get('/:id')
      @ApiResponse({ status: 200, description: 'OK' })
      @ApiResponse({ status: 404, description: 'Not found', schema: ErrorDto })
      @ApiResponse({ status: 500, description: 'Server error' })
      findOne() {
        return {};
      }
    }

    @Module({ controllers: [UsersController] })
    class AppModule {}

    const doc = createOpenApiDocument(AppModule);
    const op = doc.paths['/users/{id}']!.get!;
    expect(op.responses['200']!.description).toBe('OK');
    expect(op.responses['404']!.description).toBe('Not found');
    expect(op.responses['404']!.content!['application/json']!.schema.$ref).toBe(
      '#/components/schemas/ErrorDto',
    );
    expect(doc.components!.schemas!['ErrorDto']!.properties).toHaveProperty('message');
    expect(op.responses['500']!.description).toBe('Server error');
  });

  it('accepts a raw Zod schema (not a DTO descriptor)', () => {
    @Controller('/items')
    class ItemsController {
      @Post()
      @ApiResponse({
        status: 201,
        description: 'Created',
        schema: z.object({ id: z.string() }),
      })
      create() {
        return {};
      }
    }

    @Module({ controllers: [ItemsController] })
    class AppModule {}

    const doc = createOpenApiDocument(AppModule);
    const op = doc.paths['/items']!.post!;
    expect(op.responses['201']!.description).toBe('Created');
    expect(op.responses['201']!.content!['application/json']!.schema.properties).toHaveProperty(
      'id',
    );
  });

  it('rejects a raw JSON Schema object', () => {
    expect(() =>
      // @ts-expect-error a documented schema is a Standard Schema, not JSON Schema
      ApiResponse({ status: 200, description: 'OK', schema: { type: 'string' } }),
    ).toThrow(/Standard Schema/);
  });

  it("describes the route's success response without replacing its schema", () => {
    @Controller('/described')
    class DescribedController {
      @Get({ response: z.object({ ok: z.boolean() }) })
      @ApiResponse({ status: 200, description: 'Health', schema: z.string() })
      @ApiResponse({ status: '5XX', description: 'Unavailable' })
      handle() {
        return { ok: true };
      }
    }

    @Module({ controllers: [DescribedController] })
    class AppModule {}

    const responses = createOpenApiDocument(AppModule).paths['/described']!.get!.responses;
    expect(responses['200']).toMatchObject({
      description: 'Health',
      content: { 'application/json': { schema: { type: 'object' } } },
    });
    expect(responses['5XX']).toEqual({ description: 'Unavailable' });
  });

  it('preserves the default 200 response when no @ApiResponse is present', () => {
    @Controller('/default')
    class DefaultController {
      @Get()
      handle() {
        return {};
      }
    }

    @Module({ controllers: [DefaultController] })
    class AppModule {}

    const doc = createOpenApiDocument(AppModule);
    expect(doc.paths['/default']!.get!.responses['200']).toEqual({ description: 'OK' });
  });

  it('an @ApiResponse for the success status describes it', () => {
    @Controller('/override')
    class OverrideController {
      @Get()
      @ApiResponse({ status: 200, description: 'custom ok' })
      handle() {
        return {};
      }
    }

    @Module({ controllers: [OverrideController] })
    class AppModule {}

    const doc = createOpenApiDocument(AppModule);
    expect(doc.paths['/override']!.get!.responses['200']!.description).toBe('custom ok');
  });

  // The documented success statuses must include the one the runtime sends.
  async function sentStatus(module: Type, path: string): Promise<number> {
    const app = await VelaFactory.create(module);
    const response = await app.getHonoApp().request(path, { method: 'POST' });
    await app.close();
    return response.status;
  }

  it('keeps the 201 a POST sends beside an undeclared documented 2xx', async () => {
    @Controller('/created')
    class CreatedController {
      @Post()
      @ApiResponse({ status: 200, description: 'Replayed' })
      @ApiResponse({ status: 400, description: 'Validation failed' })
      create() {
        return {};
      }
    }

    @Module({ controllers: [CreatedController] })
    class AppModule {}

    const responses = createOpenApiDocument(AppModule).paths['/created']!.post!.responses;
    expect(Object.keys(responses).toSorted()).toEqual(['200', '201', '400']);
    expect(await sentStatus(AppModule, '/created')).toBe(201);
  });

  it('documents only the declared 2xx when @HttpCode makes the runtime send it', async () => {
    @Controller('/created')
    class CreatedController {
      @Post()
      @HttpCode(201)
      @ApiResponse({ status: 201, description: 'Created' })
      @ApiResponse({ status: 400, description: 'Validation failed' })
      create() {
        return {};
      }
    }

    @Module({ controllers: [CreatedController] })
    class AppModule {}

    const responses = createOpenApiDocument(AppModule).paths['/created']!.post!.responses;
    expect(Object.keys(responses).toSorted()).toEqual(['201', '400']);
    expect(responses['201']).toEqual({ description: 'Created' });
    expect(await sentStatus(AppModule, '/created')).toBe(201);
  });

  it('keeps the default 200 when only error responses are documented', () => {
    @Controller('/lookup')
    class LookupController {
      @Get()
      @ApiResponse({ status: 404, description: 'Not found' })
      find() {
        return {};
      }
    }

    @Module({ controllers: [LookupController] })
    class AppModule {}

    const responses = createOpenApiDocument(AppModule).paths['/lookup']!.get!.responses;
    expect(Object.keys(responses).toSorted()).toEqual(['200', '404']);
  });

  it('documents the @HttpCode status as the success response', () => {
    @Controller('/accepted')
    class AcceptedController {
      @Post()
      @HttpCode(202)
      @ApiResponse({ status: 400, description: 'Validation failed' })
      enqueue() {
        return {};
      }
    }

    @Module({ controllers: [AcceptedController] })
    class AppModule {}

    const responses = createOpenApiDocument(AppModule).paths['/accepted']!.post!.responses;
    expect(Object.keys(responses).toSorted()).toEqual(['202', '400']);
    expect(responses['202']).toEqual({ description: 'OK' });
  });
});
