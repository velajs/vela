import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import {
  Controller,
  Get,
  Post,
  Body,
  Module,
  MetadataRegistry,
  createZodDto,
  createOpenApiDocument,
  ApiResponse,
} from '../index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

describe('OpenAPI — $ref components for DTO classes', () => {
  it('@Body() DTO produces a $ref and registers the schema under components', () => {
    const UserSchema = z.object({ name: z.string(), email: z.string().email() });
    class CreateUserDto extends createZodDto(UserSchema, { name: 'CreateUserDto' }) {}

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
    const body = doc.paths['/users']!.post!.requestBody!;
    expect(body.content!['application/json']!.schema.$ref).toBe(
      '#/components/schemas/CreateUserDto',
    );
    expect(doc.components!.schemas!['CreateUserDto']!.type).toBe('object');
    expect(doc.components!.schemas!['CreateUserDto']!.properties).toHaveProperty('name');
  });

  it('DTO used as response schema produces a $ref and registers components', () => {
    const UserSchema = z.object({ id: z.string(), name: z.string() });
    class UserDto extends createZodDto(UserSchema, { name: 'UserDto' }) {}

    @Controller('/users')
    class UsersController {
      @Get('/:id')
      @ApiResponse(200, { description: 'OK', schema: UserDto })
      findOne() {
        return {};
      }
    }

    @Module({ controllers: [UsersController] })
    class AppModule {}

    const doc = createOpenApiDocument(AppModule);
    const resSchema =
      doc.paths['/users/{id}']!.get!.responses['200']!.content!['application/json']!.schema;
    expect(resSchema.$ref).toBe('#/components/schemas/UserDto');
    expect(doc.components!.schemas!['UserDto']).toBeDefined();
  });

  it('same DTO used in multiple places produces one components entry; refs share it', () => {
    const UserSchema = z.object({ id: z.string() });
    class UserDto extends createZodDto(UserSchema, { name: 'UserDto' }) {}

    @Controller('/users')
    class UsersController {
      @Post()
      create(@Body() _dto: UserDto) {
        return {};
      }

      @Get('/:id')
      @ApiResponse(200, { description: 'OK', schema: UserDto })
      findOne() {
        return {};
      }
    }

    @Module({ controllers: [UsersController] })
    class AppModule {}

    const doc = createOpenApiDocument(AppModule);
    expect(Object.keys(doc.components!.schemas!)).toEqual(['UserDto']);
    expect(doc.paths['/users']!.post!.requestBody!.content!['application/json']!.schema.$ref).toBe(
      '#/components/schemas/UserDto',
    );
    expect(
      doc.paths['/users/{id}']!.get!.responses['200']!.content!['application/json']!.schema.$ref,
    ).toBe('#/components/schemas/UserDto');
  });

  it('two distinct DTOs produce two components entries', () => {
    class CreateUserDto extends createZodDto(z.object({ name: z.string() }), {
      name: 'CreateUserDto',
    }) {}
    class UserDto extends createZodDto(z.object({ id: z.string(), name: z.string() }), {
      name: 'UserDto',
    }) {}

    @Controller('/users')
    class UsersController {
      @Post()
      @ApiResponse(201, { description: 'Created', schema: UserDto })
      create(@Body() _dto: CreateUserDto) {
        return {};
      }
    }

    @Module({ controllers: [UsersController] })
    class AppModule {}

    const doc = createOpenApiDocument(AppModule);
    expect(Object.keys(doc.components!.schemas!).sort()).toEqual(['CreateUserDto', 'UserDto']);
  });

  it('name collision: two classes with same name get suffixed unique keys', () => {
    // Two different schemas both named "Thing" via the { name } option.
    // Use @ApiResponse to reference them (accepts runtime values, unlike
    // @Body() which requires a TypeScript class type for design:paramtypes).
    const A = createZodDto(z.object({ a: z.string() }), { name: 'Thing' });
    const B = createZodDto(z.object({ b: z.number() }), { name: 'Thing' });

    @Controller('/a')
    class AController {
      @Get()
      @ApiResponse(200, { description: 'a', schema: A })
      get() {
        return {};
      }
    }

    @Controller('/b')
    class BController {
      @Get()
      @ApiResponse(200, { description: 'b', schema: B })
      get() {
        return {};
      }
    }

    @Module({ controllers: [AController, BController] })
    class AppModule {}

    const doc = createOpenApiDocument(AppModule);
    const keys = Object.keys(doc.components!.schemas!).sort();
    expect(keys).toHaveLength(2);
    expect(keys.every((k) => k.startsWith('Thing'))).toBe(true);
    expect(keys[0]).not.toBe(keys[1]);
    // Refs point to distinct entries
    const aRef = doc.paths['/a']!.get!.responses['200']!.content!['application/json']!.schema.$ref;
    const bRef = doc.paths['/b']!.get!.responses['200']!.content!['application/json']!.schema.$ref;
    expect(aRef).not.toBe(bRef);
  });

  it('raw Zod schema (not a DTO class) is inlined, not componentized', () => {
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
    const schema =
      doc.paths['/items']!.post!.responses['201']!.content!['application/json']!.schema;
    expect(schema.$ref).toBeUndefined();
    expect(schema.type).toBe('object');
    expect(doc.components?.schemas).toBeUndefined();
  });

  it('raw JSON Schema object is inlined, not componentized', () => {
    @Controller('/text')
    class TextController {
      @Get()
      @ApiResponse(200, {
        description: 'OK',
        schema: { type: 'string' } as const,
      })
      handle() {
        return '';
      }
    }

    @Module({ controllers: [TextController] })
    class AppModule {}

    const doc = createOpenApiDocument(AppModule);
    const schema = doc.paths['/text']!.get!.responses['200']!.content!['application/json']!.schema;
    expect(schema).toEqual({ type: 'string' });
    expect(doc.components?.schemas).toBeUndefined();
  });
});
