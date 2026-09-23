import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  VelaFactory,
  Controller,
  Get,
  Post,
  Body,
  Module,
  Injectable,
  UseInterceptors,
  defineDto,
  ValidationPipe,
  Serialize,
  SerializerInterceptor,
} from '../index.js';

// =============================================================================
// Serialization: @Serialize + SerializerInterceptor
// =============================================================================

describe('Serialization', () => {
  it('should strip fields from response via @Serialize', async () => {
    const UserSchema = z.object({
      id: z.number(),
      name: z.string(),
      password: z.string(),
    });

    const UserResponseDto = defineDto(UserSchema.omit({ password: true }), {
      name: 'UserResponseDto',
    });
    type UserResponseDto = ReturnType<typeof UserResponseDto.parse>;

    @Injectable()
    class UserService {
      findOne() {
        return { id: 1, name: 'Alice', password: 'secret123' };
      }
    }

    @Controller('/users')
    @UseInterceptors(SerializerInterceptor)
    class UserController {
      constructor(private userService: UserService) {}

      @Get('/me')
      @Serialize(UserResponseDto)
      me() {
        return this.userService.findOne();
      }
    }

    @Module({
      providers: [UserService],
      controllers: [UserController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/users/me');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: 1, name: 'Alice' });
    expect(body).not.toHaveProperty('password');
  });

  it('should handle array responses', async () => {
    const UserSchema = z.object({
      id: z.number(),
      name: z.string(),
      password: z.string(),
    });
    const UserResponseDto = defineDto(UserSchema.omit({ password: true }), {
      name: 'UserResponseDto',
    });
    type UserResponseDto = ReturnType<typeof UserResponseDto.parse>;

    @Controller('/users')
    @UseInterceptors(SerializerInterceptor)
    class UserController {
      @Get()
      @Serialize(UserResponseDto)
      findAll() {
        return [
          { id: 1, name: 'Alice', password: 'secret1' },
          { id: 2, name: 'Bob', password: 'secret2' },
        ];
      }
    }

    @Module({ controllers: [UserController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/users');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any[];
    expect(body).toEqual([
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ]);
    expect(body[0]).not.toHaveProperty('password');
    expect(body[1]).not.toHaveProperty('password');
  });

  it('should pass through response when no @Serialize is set', async () => {
    @Controller('/items')
    @UseInterceptors(SerializerInterceptor)
    class ItemController {
      @Get()
      findAll() {
        return [{ id: 1, name: 'Widget', secret: 'data' }];
      }
    }

    @Module({ controllers: [ItemController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/items');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any[];
    expect(body).toEqual([{ id: 1, name: 'Widget', secret: 'data' }]);
  });

  it('should combine input validation and output serialization', async () => {
    const CreateUserSchema = z.object({
      name: z.string(),
      email: z.string().email(),
      password: z.string().min(6),
    });
    const CreateUserDto = defineDto(CreateUserSchema, { name: 'CreateUserDto' });
    type CreateUserDto = ReturnType<typeof CreateUserDto.parse>;

    const UserResponseSchema = z.object({
      id: z.number(),
      name: z.string(),
      email: z.string(),
    });
    const UserResponseDto = defineDto(UserResponseSchema, { name: 'UserResponseDto' });
    type UserResponseDto = ReturnType<typeof UserResponseDto.parse>;

    @Injectable()
    class UserService {
      create(data: { name: string; email: string; password: string }) {
        return { id: 1, ...data };
      }
    }

    @Controller('/users')
    @UseInterceptors(SerializerInterceptor)
    class UserController {
      constructor(private userService: UserService) {}

      @Post()
      @Serialize(UserResponseDto)
      create(@Body(new ValidationPipe(CreateUserDto)) dto: CreateUserDto) {
        return this.userService.create(dto as any);
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

    // Valid: input validated, output serialized (password stripped)
    const validRes = await hono.request('/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Alice',
        email: 'alice@example.com',
        password: 'secure123',
      }),
    });
    expect(validRes.status).toBe(200);
    const body = await validRes.json();
    expect(body).toEqual({ id: 1, name: 'Alice', email: 'alice@example.com' });
    expect(body).not.toHaveProperty('password');

    // Invalid: validation rejects bad input
    const invalidRes = await hono.request('/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Alice',
        email: 'not-email',
        password: '123',
      }),
    });
    expect(invalidRes.status).toBe(400);
    const errorBody = (await invalidRes.json()) as any;
    expect(errorBody.message).toBe('Validation failed');
    expect(errorBody.errors.length).toBeGreaterThan(0);
  });
});
