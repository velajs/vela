import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import {
  Controller,
  Get,
  Post,
  Module,
  MetadataRegistry,
  defineDto,
  createOpenApiDocument,
  ApiResponse,
  HttpCode,
  VelaFactory,
} from '../index.js';
import type { Type } from '../index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

describe('@ApiResponse', () => {
  it('registers a response with description and a Zod DTO schema (via $ref)', () => {
    const UserSchema = z.object({ id: z.string(), name: z.string() });
    const UserDto = defineDto(UserSchema, { name: 'UserDto' });

    @Controller('/users')
    class UsersController {
      @Get('/:id')
      @ApiResponse(200, { description: 'User found', schema: UserDto })
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
      @ApiResponse(200, { description: 'OK' })
      @ApiResponse(404, { description: 'Not found', schema: ErrorDto })
      @ApiResponse(500, { description: 'Server error' })
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
      @ApiResponse(201, {
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

  it('accepts a raw JSON Schema object', () => {
    @Controller('/text')
    class TextController {
      @Get()
      @ApiResponse(200, {
        description: 'OK',
        schema: { type: 'string' } as const,
      })
      handle() {
        return 'hi';
      }
    }

    @Module({ controllers: [TextController] })
    class AppModule {}

    const doc = createOpenApiDocument(AppModule);
    const op = doc.paths['/text']!.get!;
    expect(op.responses['200']!.content!['application/json']!.schema).toEqual({ type: 'string' });
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

  it('explicit @ApiResponse(200, ...) overrides the default', () => {
    @Controller('/override')
    class OverrideController {
      @Get()
      @ApiResponse(200, { description: 'custom ok' })
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

  it('keeps the default 200 the runtime sends beside an undeclared documented 2xx', async () => {
    @Controller('/created')
    class CreatedController {
      @Post()
      @ApiResponse(201, { description: 'Created' })
      @ApiResponse(400, { description: 'Validation failed' })
      create() {
        return {};
      }
    }

    @Module({ controllers: [CreatedController] })
    class AppModule {}

    const responses = createOpenApiDocument(AppModule).paths['/created']!.post!.responses;
    expect(Object.keys(responses).toSorted()).toEqual(['200', '201', '400']);
    expect(await sentStatus(AppModule, '/created')).toBe(200);
  });

  it('documents only the declared 2xx when @HttpCode makes the runtime send it', async () => {
    @Controller('/created')
    class CreatedController {
      @Post()
      @HttpCode(201)
      @ApiResponse(201, { description: 'Created' })
      @ApiResponse(400, { description: 'Validation failed' })
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
      @ApiResponse(404, { description: 'Not found' })
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
      @ApiResponse(400, { description: 'Validation failed' })
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
