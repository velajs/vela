import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import {
  VelaFactory,
  Controller,
  Get,
  Post,
  Body,
  Query,
  Module,
  Injectable,
  MetadataRegistry,
  createZodDto,
  ValidationPipe,
} from '../index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

// =============================================================================
// createZodDto
// =============================================================================

describe('createZodDto', () => {
  it('should create a class with static schema property', () => {
    const schema = z.object({ name: z.string() });
    const Dto = createZodDto(schema);

    expect(Dto.schema).toBe(schema);
    expect(typeof Dto).toBe('function');
  });

  it('should be instantiable', () => {
    const schema = z.object({ name: z.string() });
    const Dto = createZodDto(schema);
    const instance = new Dto();

    expect(instance).toBeDefined();
  });

  it('should work with mapped types (partial)', () => {
    const schema = z.object({ name: z.string(), email: z.string().email() });
    const PartialDto = createZodDto(schema.partial());

    const result = PartialDto.schema.parse({});
    expect(result).toEqual({});
  });

  it('should work with mapped types (pick)', () => {
    const schema = z.object({ name: z.string(), email: z.string().email() });
    const PickDto = createZodDto(schema.pick({ name: true }));

    const result = PickDto.schema.parse({ name: 'Alice' });
    expect(result).toEqual({ name: 'Alice' });
  });

  it('should work with mapped types (omit)', () => {
    const schema = z.object({ name: z.string(), password: z.string() });
    const OmitDto = createZodDto(schema.omit({ password: true }));

    const result = OmitDto.schema.parse({ name: 'Alice' });
    expect(result).toEqual({ name: 'Alice' });
  });
});

// =============================================================================
// ValidationPipe (unit)
// =============================================================================

describe('ValidationPipe', () => {
  const pipe = new ValidationPipe();

  it('should pass through when metatype has no schema', () => {
    const value = { name: 'Alice' };
    const result = pipe.transform(value, { type: 'body', metatype: undefined });
    expect(result).toBe(value);
  });

  it('should pass through for non-Zod metatypes', () => {
    const value = 'hello';
    const result = pipe.transform(value, {
      type: 'body',
      metatype: String as any,
    });
    expect(result).toBe(value);
  });

  it('should validate and return parsed value', () => {
    const schema = z.object({ name: z.string() });
    const Dto = createZodDto(schema);

    const result = pipe.transform(
      { name: 'Alice' },
      {
        type: 'body',
        metatype: Dto as any,
      },
    );
    expect(result).toEqual({ name: 'Alice' });
  });

  it('should strip unknown keys via Zod strict/strip behavior', () => {
    const schema = z.object({ name: z.string() });
    const Dto = createZodDto(schema);

    const result = pipe.transform(
      { name: 'Alice', extra: true },
      {
        type: 'body',
        metatype: Dto as any,
      },
    );
    expect(result).toEqual({ name: 'Alice' });
  });

  it('should throw BadRequestException with Zod issues on invalid data', () => {
    const schema = z.object({ name: z.string(), email: z.string().email() });
    const Dto = createZodDto(schema);

    expect(() =>
      pipe.transform(
        { name: 123, email: 'bad' },
        {
          type: 'body',
          metatype: Dto as any,
        },
      ),
    ).toThrow();

    try {
      pipe.transform(
        { name: 123, email: 'bad' },
        {
          type: 'body',
          metatype: Dto as any,
        },
      );
    } catch (err: any) {
      expect(err.statusCode).toBe(400);
      const response = err.getResponse() as any;
      expect(response.message).toBe('Validation failed');
      expect(response.errors).toBeDefined();
      expect(Array.isArray(response.errors)).toBe(true);
    }
  });

  it('should work with nested schemas', () => {
    const addressSchema = z.object({
      street: z.string(),
      city: z.string(),
    });
    const schema = z.object({
      name: z.string(),
      address: addressSchema,
    });
    const Dto = createZodDto(schema);

    const result = pipe.transform(
      { name: 'Alice', address: { street: '123 Main', city: 'NYC' } },
      { type: 'body', metatype: Dto as any },
    );
    expect(result).toEqual({
      name: 'Alice',
      address: { street: '123 Main', city: 'NYC' },
    });
  });

  it('should reject invalid nested data', () => {
    const schema = z.object({
      name: z.string(),
      address: z.object({ street: z.string() }),
    });
    const Dto = createZodDto(schema);

    expect(() =>
      pipe.transform(
        { name: 'Alice', address: { street: 123 } },
        {
          type: 'body',
          metatype: Dto as any,
        },
      ),
    ).toThrow();
  });
});

// =============================================================================
// Integration: Global ValidationPipe via HTTP
// =============================================================================

describe('ValidationPipe integration', () => {
  it('should auto-validate @Body() with Zod DTO via global pipe', async () => {
    const CreateUserSchema = z.object({
      name: z.string(),
      email: z.string().email(),
    });
    class CreateUserDto extends createZodDto(CreateUserSchema) {}

    @Injectable()
    class UserService {
      create(data: unknown) {
        return { id: 1, ...(data as object) };
      }
    }

    @Controller('/users')
    class UserController {
      constructor(private userService: UserService) {}

      @Post()
      create(@Body() dto: CreateUserDto) {
        return this.userService.create(dto);
      }
    }

    @Module({
      providers: [UserService],
      controllers: [UserController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    app.useGlobalPipes(new ValidationPipe());

    const hono = app.getHonoApp();

    // Valid request
    const validRes = await hono.request('/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice', email: 'alice@example.com' }),
    });
    expect(validRes.status).toBe(200);
    const validBody = await validRes.json();
    expect(validBody).toEqual({ id: 1, name: 'Alice', email: 'alice@example.com' });

    // Invalid request
    const invalidRes = await hono.request('/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice', email: 'not-an-email' }),
    });
    expect(invalidRes.status).toBe(400);
    const errorBody = (await invalidRes.json()) as any;
    expect(errorBody.message).toBe('Validation failed');
    expect(errorBody.errors).toBeDefined();
  });

  it('should pass through params without Zod schemas', async () => {
    @Controller('/items')
    class ItemController {
      @Get('/:id')
      findOne(@Query('search') search: string) {
        return { search };
      }
    }

    @Module({ controllers: [ItemController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    app.useGlobalPipes(new ValidationPipe());

    const hono = app.getHonoApp();
    const res = await hono.request('/items/1?search=hello');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ search: 'hello' });
  });

  it('should work with partial schemas (mapped types)', async () => {
    const CreateSchema = z.object({
      name: z.string(),
      email: z.string().email(),
    });
    class UpdateUserDto extends createZodDto(CreateSchema.partial()) {}

    @Controller('/users')
    class UserController {
      @Post('/update')
      update(@Body() dto: UpdateUserDto) {
        return dto;
      }
    }

    @Module({ controllers: [UserController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    app.useGlobalPipes(new ValidationPipe());

    const hono = app.getHonoApp();

    // Only name — email is optional
    const res = await hono.request('/users/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bob' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'Bob' });
  });
});
