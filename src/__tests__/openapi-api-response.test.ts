import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import {
  Controller,
  Get,
  Post,
  Module,
  MetadataRegistry,
  createZodDto,
  createOpenApiDocument,
  ApiResponse,
} from '../index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

describe('@ApiResponse', () => {
  it('registers a response with description and a Zod DTO schema', () => {
    const UserSchema = z.object({ id: z.string(), name: z.string() });
    class UserDto extends createZodDto(UserSchema) {}

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
    expect(schema.type).toBe('object');
    expect(schema.properties).toHaveProperty('id');
    expect(schema.properties).toHaveProperty('name');
  });

  it('supports multiple @ApiResponse on one handler for different status codes', () => {
    const ErrorSchema = z.object({ message: z.string() });
    class ErrorDto extends createZodDto(ErrorSchema) {}

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
    expect(op.responses['404']!.content!['application/json']!.schema.properties).toHaveProperty('message');
    expect(op.responses['500']!.description).toBe('Server error');
  });

  it('accepts a raw Zod schema (not a DTO class)', () => {
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
    expect(op.responses['201']!.content!['application/json']!.schema.properties).toHaveProperty('id');
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
});
