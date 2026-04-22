import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  Module,
  MetadataRegistry,
  createZodDto,
  createOpenApiDocument,
  ApiDoc,
  ApiTags,
} from '../index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

describe('createOpenApiDocument — document shape', () => {
  it('produces a 3.1 document with info and empty paths for an empty module', () => {
    @Module({})
    class AppModule {}

    const doc = createOpenApiDocument(AppModule, {
      info: { title: 'My API', version: '1.0.0' },
    });

    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('My API');
    expect(doc.info.version).toBe('1.0.0');
    expect(doc.paths).toEqual({});
  });

  it('defaults info fields when not provided', () => {
    @Module({})
    class AppModule {}

    const doc = createOpenApiDocument(AppModule);

    expect(doc.openapi).toBe('3.1.0');
    expect(typeof doc.info.title).toBe('string');
    expect(typeof doc.info.version).toBe('string');
  });
});

describe('createOpenApiDocument — routes', () => {
  it('registers a simple GET route at the correct path + method', () => {
    @Controller('/users')
    class UsersController {
      @Get()
      list() {
        return [];
      }
    }

    @Module({ controllers: [UsersController] })
    class AppModule {}

    const doc = createOpenApiDocument(AppModule);

    expect(doc.paths['/users']).toBeDefined();
    expect(doc.paths['/users']!.get).toBeDefined();
    expect(doc.paths['/users']!.get!.responses).toBeDefined();
  });

  it('normalizes :id path parameters to {id}', () => {
    @Controller('/users')
    class UsersController {
      @Get('/:id')
      findOne(@Param('id') id: string) {
        return { id };
      }

      @Delete('/:id')
      remove(@Param('id') id: string) {
        return { id };
      }
    }

    @Module({ controllers: [UsersController] })
    class AppModule {}

    const doc = createOpenApiDocument(AppModule);

    expect(doc.paths['/users/{id}']).toBeDefined();
    expect(doc.paths['/users/{id}']!.get).toBeDefined();
    expect(doc.paths['/users/{id}']!.delete).toBeDefined();
    expect(doc.paths['/users/:id']).toBeUndefined();
  });

  it('emits path parameters with `in: path` + required: true', () => {
    @Controller('/users')
    class UsersController {
      @Get('/:id')
      findOne(@Param('id') id: string) {
        return { id };
      }
    }

    @Module({ controllers: [UsersController] })
    class AppModule {}

    const doc = createOpenApiDocument(AppModule);
    const op = doc.paths['/users/{id}']!.get!;
    const idParam = (op.parameters ?? []).find((p) => p.name === 'id');

    expect(idParam).toBeDefined();
    expect(idParam!.in).toBe('path');
    expect(idParam!.required).toBe(true);
  });

  it('emits query parameters with `in: query`', () => {
    @Controller('/users')
    class UsersController {
      @Get()
      list(@Query('search') _search?: string) {
        return [];
      }
    }

    @Module({ controllers: [UsersController] })
    class AppModule {}

    const doc = createOpenApiDocument(AppModule);
    const op = doc.paths['/users']!.get!;
    const searchParam = (op.parameters ?? []).find((p) => p.name === 'search');

    expect(searchParam).toBeDefined();
    expect(searchParam!.in).toBe('query');
    expect(searchParam!.required).toBe(false);
  });

  it('includes body schema from a Zod DTO class', () => {
    const CreateUserSchema = z.object({
      name: z.string(),
      email: z.string().email(),
    });
    class CreateUserDto extends createZodDto(CreateUserSchema) {}

    @Controller('/users')
    class UsersController {
      @Post()
      create(@Body() _dto: CreateUserDto) {
        return {};
      }
    }

    @Module({ controllers: [UsersController] })
    class AppModule {}

    const doc = createOpenApiDocument(AppModule);
    const op = doc.paths['/users']!.post!;

    expect(op.requestBody).toBeDefined();
    const schema = op.requestBody!.content!['application/json']!.schema;
    expect(schema.type).toBe('object');
    expect(schema.properties).toHaveProperty('name');
    expect(schema.properties).toHaveProperty('email');
    expect(schema.required).toContain('name');
    expect(schema.required).toContain('email');
  });

  it('walks imported modules recursively', () => {
    @Controller('/a')
    class AController {
      @Get() a() {
        return {};
      }
    }
    @Module({ controllers: [AController] })
    class AModule {}

    @Controller('/b')
    class BController {
      @Get() b() {
        return {};
      }
    }
    @Module({ controllers: [BController] })
    class BModule {}

    @Module({ imports: [AModule, BModule] })
    class AppModule {}

    const doc = createOpenApiDocument(AppModule);
    expect(doc.paths['/a']).toBeDefined();
    expect(doc.paths['/b']).toBeDefined();
  });

  it('applies a global prefix to all paths when configured', () => {
    @Controller('/items')
    class ItemsController {
      @Get() list() {
        return [];
      }
    }

    @Module({ controllers: [ItemsController] })
    class AppModule {}

    const doc = createOpenApiDocument(AppModule, { globalPrefix: '/api' });
    expect(doc.paths['/api/items']).toBeDefined();
    expect(doc.paths['/items']).toBeUndefined();
  });
});

describe('createOpenApiDocument — decorators', () => {
  it('picks up summary and description from @ApiDoc', () => {
    @Controller('/users')
    class UsersController {
      @Get()
      @ApiDoc({ summary: 'List users', description: 'Returns all users.' })
      list() {
        return [];
      }
    }

    @Module({ controllers: [UsersController] })
    class AppModule {}

    const doc = createOpenApiDocument(AppModule);
    const op = doc.paths['/users']!.get!;
    expect(op.summary).toBe('List users');
    expect(op.description).toBe('Returns all users.');
  });

  it('picks up operationId from @ApiDoc', () => {
    @Controller('/users')
    class UsersController {
      @Get('/:id')
      @ApiDoc({ operationId: 'getUserById' })
      findOne(@Param('id') id: string) {
        return { id };
      }
    }

    @Module({ controllers: [UsersController] })
    class AppModule {}

    const doc = createOpenApiDocument(AppModule);
    expect(doc.paths['/users/{id}']!.get!.operationId).toBe('getUserById');
  });

  it('picks up tags from @ApiTags on the controller', () => {
    @Controller('/users')
    @ApiTags('users', 'admin')
    class UsersController {
      @Get()
      list() {
        return [];
      }
    }

    @Module({ controllers: [UsersController] })
    class AppModule {}

    const doc = createOpenApiDocument(AppModule);
    const op = doc.paths['/users']!.get!;
    expect(op.tags).toEqual(expect.arrayContaining(['users', 'admin']));
  });

  it('merges handler-level @ApiTags with controller-level @ApiTags', () => {
    @Controller('/users')
    @ApiTags('users')
    class UsersController {
      @Get()
      @ApiTags('list')
      list() {
        return [];
      }
    }

    @Module({ controllers: [UsersController] })
    class AppModule {}

    const doc = createOpenApiDocument(AppModule);
    const op = doc.paths['/users']!.get!;
    expect(op.tags).toEqual(expect.arrayContaining(['users', 'list']));
  });
});
