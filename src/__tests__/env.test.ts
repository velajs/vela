import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  VelaFactory,
  Controller,
  Get,
  Module,
  MetadataRegistry,
} from '@velajs/vela';
import { Env } from '../decorators/env';

beforeEach(() => {
  MetadataRegistry.clear();
});

describe('@Env() decorator', () => {
  it('should inject the full env object when no binding name is specified', async () => {
    @Controller('/test')
    class TestController {
      @Get()
      handle(@Env() env: Record<string, unknown>) {
        return { keys: Object.keys(env) };
      }
    }

    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/test', undefined, {
      MY_KV: { fake: true },
      DB: { fake: true },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { keys: string[] };
    expect(data.keys).toContain('MY_KV');
    expect(data.keys).toContain('DB');
  });

  it('should inject a specific binding when name is provided', async () => {
    const mockKV = { get: () => 'hello' };

    @Controller('/test')
    class TestController {
      @Get()
      handle(@Env('MY_KV') kv: unknown) {
        return { kv: (kv as { get: () => string }).get() };
      }
    }

    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/test', undefined, { MY_KV: mockKV });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { kv: string };
    expect(data.kv).toBe('hello');
  });

  it('should return undefined when env is not available', async () => {
    @Controller('/test')
    class TestController {
      @Get()
      handle(@Env('MISSING') val: unknown) {
        return { val: val ?? null };
      }
    }

    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    // No env bindings passed
    const res = await hono.request('/test');
    expect(res.status).toBe(200);
    const data = (await res.json()) as { val: unknown };
    expect(data.val).toBeNull();
  });
});
