import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  EdgestFactory,
  Controller,
  Get,
  Module,
  UseGuards,
  SetMetadata,
  Reflector,
  ForbiddenException,
  MetadataRegistry,
} from '../index.js';
import type { CanActivate, ExecutionContext } from '../index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

// Helper: create a decorator from SetMetadata
const Roles = (...roles: string[]) => SetMetadata('roles', roles);
const Public = () => SetMetadata('isPublic', true);

describe('SetMetadata + Reflector', () => {
  it('should read class-level metadata in a guard', async () => {
    const reflector = new Reflector();

    class RolesGuard implements CanActivate {
      canActivate(context: ExecutionContext): boolean {
        const roles = reflector.get<string[]>('roles', context);
        if (!roles) return true;
        const userRole = context.getRequest().headers.get('x-role');
        return roles.includes(userRole ?? '');
      }
    }

    @Controller('/admin')
    @Roles('admin')
    @UseGuards(new RolesGuard())
    class AdminController {
      @Get()
      dashboard() {
        return { page: 'admin' };
      }
    }

    @Module({ controllers: [AdminController] })
    class AppModule {}

    const app = await EdgestFactory.create(AppModule);
    const hono = app.getHonoApp();

    // No role — 403
    const res1 = await hono.request('/admin');
    expect(res1.status).toBe(403);

    // Wrong role — 403
    const res2 = await hono.request('/admin', {
      headers: { 'x-role': 'user' },
    });
    expect(res2.status).toBe(403);

    // Correct role — 200
    const res3 = await hono.request('/admin', {
      headers: { 'x-role': 'admin' },
    });
    expect(res3.status).toBe(200);
    expect(await res3.json()).toEqual({ page: 'admin' });
  });

  it('should read method-level metadata overriding class-level', async () => {
    const reflector = new Reflector();

    class RolesGuard implements CanActivate {
      canActivate(context: ExecutionContext): boolean {
        const isPublic = reflector.get<boolean>('isPublic', context);
        if (isPublic) return true;

        const roles = reflector.get<string[]>('roles', context);
        if (!roles) return true;

        const userRole = context.getRequest().headers.get('x-role');
        return roles.includes(userRole ?? '');
      }
    }

    @Controller('/api')
    @Roles('admin')
    @UseGuards(new RolesGuard())
    class ApiController {
      @Get('/private')
      privatePath() {
        return { access: 'private' };
      }

      @Get('/public')
      @Public()
      publicPath() {
        return { access: 'public' };
      }

      @Get('/editor')
      @Roles('editor', 'admin')
      editorPath() {
        return { access: 'editor' };
      }
    }

    @Module({ controllers: [ApiController] })
    class AppModule {}

    const app = await EdgestFactory.create(AppModule);
    const hono = app.getHonoApp();

    // /api/private — needs admin role (from class)
    const res1 = await hono.request('/api/private');
    expect(res1.status).toBe(403);

    const res2 = await hono.request('/api/private', {
      headers: { 'x-role': 'admin' },
    });
    expect(res2.status).toBe(200);

    // /api/public — public override, no role needed
    const res3 = await hono.request('/api/public');
    expect(res3.status).toBe(200);
    expect(await res3.json()).toEqual({ access: 'public' });

    // /api/editor — method-level roles override class-level
    const res4 = await hono.request('/api/editor', {
      headers: { 'x-role': 'editor' },
    });
    expect(res4.status).toBe(200);

    const res5 = await hono.request('/api/editor', {
      headers: { 'x-role': 'user' },
    });
    expect(res5.status).toBe(403);
  });

  it('should support getAll() to read both handler and class metadata', () => {
    const reflector = new Reflector();

    @Roles('admin')
    class TestController {
      @Roles('editor')
      handler() {}
    }

    const context = {
      getClass: () => TestController,
      getHandler: () => 'handler' as string | symbol,
    };

    const [handlerRoles, classRoles] = reflector.getAll<string[]>('roles', context);
    expect(handlerRoles).toEqual(['editor']);
    expect(classRoles).toEqual(['admin']);
  });

  it('should return undefined for missing metadata', () => {
    const reflector = new Reflector();

    class PlainController {
      handler() {}
    }

    const context = {
      getClass: () => PlainController,
      getHandler: () => 'handler' as string | symbol,
    };

    expect(reflector.get('roles', context)).toBeUndefined();
    expect(reflector.getHandler('roles', context)).toBeUndefined();
    expect(reflector.getClass('roles', context)).toBeUndefined();
  });
});
