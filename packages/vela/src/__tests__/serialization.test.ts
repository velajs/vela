import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { VelaFactory, Controller, Get, Post, Body, Module, Injectable } from '../index.js';
import { defineDto, ValidationPipe, type SchemaOutput } from '../validation/index.js';

// =============================================================================
// Response serialization: a route's `response` schema shapes what it sends
// =============================================================================

const UserSchema = z.object({
  id: z.number(),
  name: z.string(),
  password: z.string(),
});
const UserResponseDto = defineDto(UserSchema.omit({ password: true }), {
  name: 'UserResponseDto',
});

describe('Response serialization', () => {
  it('strips fields the response schema does not declare', async () => {
    @Injectable()
    class UserService {
      findOne() {
        return { id: 1, name: 'Alice', password: 'secret123' };
      }
    }

    @Controller('/users')
    class UserController {
      constructor(private userService: UserService) {}

      @Get('/me', { response: UserResponseDto })
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
    const res = await app.getHonoApp().request('/users/me');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: 1, name: 'Alice' });
    expect(body).not.toHaveProperty('password');
  });

  it('serializes every element of an array response', async () => {
    @Controller('/users')
    class UserController {
      @Get({ response: z.array(UserResponseDto.schema) })
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
    const res = await app.getHonoApp().request('/users');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ]);
  });

  it('passes a result through when the route declares no response', async () => {
    @Controller('/items')
    class ItemController {
      @Get()
      findAll() {
        return [{ id: 1, name: 'Widget', secret: 'data' }];
      }
    }

    @Module({ controllers: [ItemController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/items');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 1, name: 'Widget', secret: 'data' }]);
  });

  it('combines input validation and output serialization', async () => {
    const CreateUserDto = defineDto(
      z.object({
        name: z.string(),
        email: z.string().email(),
        password: z.string().min(6),
      }),
      { name: 'CreateUserDto' },
    );
    const UserView = defineDto(z.object({ id: z.number(), name: z.string(), email: z.string() }), {
      name: 'UserView',
    });

    @Injectable()
    class UserService {
      create(data: SchemaOutput<typeof CreateUserDto>) {
        return { id: 1, ...data };
      }
    }

    @Controller('/users')
    class UserController {
      constructor(private userService: UserService) {}

      @Post({ response: UserView })
      create(@Body(CreateUserDto) dto: SchemaOutput<typeof CreateUserDto>) {
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

    const validRes = await hono.request('/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Alice',
        email: 'alice@example.com',
        password: 'secure123',
      }),
    });
    expect(validRes.status).toBe(201);
    const body = await validRes.json();
    expect(body).toEqual({ id: 1, name: 'Alice', email: 'alice@example.com' });
    expect(body).not.toHaveProperty('password');

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
    expect(await invalidRes.json()).toMatchObject({
      error: {
        code: 'bad_request',
        message: 'Validation failed',
        details: { issues: expect.arrayContaining([expect.objectContaining({ path: ['email'] })]) },
      },
    });
  });
});
