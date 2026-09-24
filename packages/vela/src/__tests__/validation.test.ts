import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { VelaFactory, Controller, Get, Post, Body, Query, Module, Injectable } from '../index.js';
import { defineDto, ValidationPipe } from '../validation/index.js';

// =============================================================================
// defineDto
// =============================================================================

describe('defineDto', () => {
  it('creates a descriptor that retains its runtime schema', () => {
    const schema = z.object({ name: z.string() });
    const Dto = defineDto(schema);

    expect(Dto.schema).toBe(schema);
    expect(typeof Dto).toBe('object');
  });

  it('produces validated data through parse', () => {
    const schema = z.object({ name: z.string() });
    const Dto = defineDto(schema);
    const value = Dto.parse({ name: 'Alice' });

    expect(value).toEqual({ name: 'Alice' });
  });

  it('should work with mapped types (partial)', () => {
    const schema = z.object({ name: z.string(), email: z.string().email() });
    const PartialDto = defineDto(schema.partial());

    const result = PartialDto.schema.parse({});
    expect(result).toEqual({});
  });

  it('should work with mapped types (pick)', () => {
    const schema = z.object({ name: z.string(), email: z.string().email() });
    const PickDto = defineDto(schema.pick({ name: true }));

    const result = PickDto.schema.parse({ name: 'Alice' });
    expect(result).toEqual({ name: 'Alice' });
  });

  it('should work with mapped types (omit)', () => {
    const schema = z.object({ name: z.string(), password: z.string() });
    const OmitDto = defineDto(schema.omit({ password: true }));

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
      metatype: String,
    });
    expect(result).toBe(value);
  });

  it('should validate and return parsed value', () => {
    const schema = z.object({ name: z.string() });
    const Dto = defineDto(schema);

    const result = pipe.transform(
      { name: 'Alice' },
      {
        type: 'body',
        metatype: Dto,
      },
    );
    expect(result).toEqual({ name: 'Alice' });
  });

  it('should strip unknown keys via Zod strict/strip behavior', () => {
    const schema = z.object({ name: z.string() });
    const Dto = defineDto(schema);

    const result = pipe.transform(
      { name: 'Alice', extra: true },
      {
        type: 'body',
        metatype: Dto,
      },
    );
    expect(result).toEqual({ name: 'Alice' });
  });

  it('should throw BadRequestException with Zod issues on invalid data', () => {
    const schema = z.object({ name: z.string(), email: z.string().email() });
    const Dto = defineDto(schema);

    expect(() =>
      pipe.transform(
        { name: 123, email: 'bad' },
        {
          type: 'body',
          metatype: Dto,
        },
      ),
    ).toThrow();

    try {
      pipe.transform(
        { name: 123, email: 'bad' },
        {
          type: 'body',
          metatype: Dto,
        },
      );
    } catch (error: unknown) {
      expect(error).toMatchObject({ statusCode: 400 });
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
    const Dto = defineDto(schema);

    const result = pipe.transform(
      { name: 'Alice', address: { street: '123 Main', city: 'NYC' } },
      { type: 'body', metatype: Dto },
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
    const Dto = defineDto(schema);

    expect(() =>
      pipe.transform(
        { name: 'Alice', address: { street: 123 } },
        {
          type: 'body',
          metatype: Dto,
        },
      ),
    ).toThrow();
  });
});

// =============================================================================
// Integration: Global ValidationPipe via HTTP
// =============================================================================

describe('ValidationPipe integration', () => {
  it('validates an explicit body descriptor alongside global pipes', async () => {
    const CreateUserSchema = z.object({
      name: z.string(),
      email: z.string().email(),
    });
    const CreateUserDto = defineDto(CreateUserSchema, { name: 'CreateUserDto' });
    type CreateUserDto = ReturnType<typeof CreateUserDto.parse>;

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
      create(@Body(new ValidationPipe(CreateUserDto)) dto: CreateUserDto) {
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
    expect(await invalidRes.json()).toMatchObject({
      error: {
        code: 'bad_request',
        message: 'Validation failed',
        details: { issues: expect.any(Array) },
      },
    });
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
    const UpdateUserDto = defineDto(CreateSchema.partial(), { name: 'UpdateUserDto' });
    type UpdateUserDto = ReturnType<typeof UpdateUserDto.parse>;

    @Controller('/users')
    class UserController {
      @Post('/update')
      update(@Body(new ValidationPipe(UpdateUserDto)) dto: UpdateUserDto) {
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
