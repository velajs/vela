import { describe, it, expect, beforeEach } from 'vitest';
import {
  VelaFactory,
  createApplication,
  Controller,
  Get,
  Module,
  MetadataRegistry,
} from '../index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

describe('createApplication alias', () => {
  it('is the same function as VelaFactory.create (bound)', () => {
    expect(typeof createApplication).toBe('function');
  });

  it('boots an app via createApplication', async () => {
    @Controller('/alias')
    class AliasController {
      @Get()
      handle() {
        return { via: 'createApplication' };
      }
    }

    @Module({ controllers: [AliasController] })
    class AppModule {}

    const app = await createApplication(AppModule);
    const hono = app.getHonoApp();
    const res = await hono.request('/alias');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ via: 'createApplication' });
  });

  it('boots an app via VelaFactory.create (regression)', async () => {
    @Controller('/factory')
    class FactoryController {
      @Get()
      handle() {
        return { via: 'VelaFactory.create' };
      }
    }

    @Module({ controllers: [FactoryController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();
    const res = await hono.request('/factory');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ via: 'VelaFactory.create' });
  });

  it('accepts options like VelaFactory.create', async () => {
    @Controller('/alias-opts')
    class AliasOptsController {
      @Get()
      handle() {
        return { ok: true };
      }
    }

    @Module({ controllers: [AliasOptsController] })
    class AppModule {}

    const app = await createApplication(AppModule, { globalPrefix: '/api' });
    const hono = app.getHonoApp();
    const res = await hono.request('/api/alias-opts');
    expect(res.status).toBe(200);
  });
});
