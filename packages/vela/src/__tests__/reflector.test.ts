import { describe, it, expect, vi } from 'vitest';
import {
  VelaFactory,
  Controller,
  Get,
  Module,
  UseGuards,
  SetMetadata,
  Reflector,
  ForbiddenException,
} from '../index.js';
import type { CanActivate, ExecutionContext, ReflectableDecorator } from '../index.js';

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

    const app = await VelaFactory.create(AppModule);
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

    const app = await VelaFactory.create(AppModule);
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
      getHandlerName: () => 'handler' as string | symbol,
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
      getHandlerName: () => 'handler' as string | symbol,
    };

    expect(reflector.get('roles', context)).toBeUndefined();
    expect(reflector.getHandler('roles', context)).toBeUndefined();
    expect(reflector.getClass('roles', context)).toBeUndefined();
  });
});

describe('Reflector.createDecorator', () => {
  it('should create a typed decorator at class level and read back via reflector.get', () => {
    const reflector = new Reflector();
    const Roles = Reflector.createDecorator<string[]>();

    @Roles(['admin', 'editor'])
    class TestController {
      handler() {}
    }

    const context = {
      getClass: () => TestController,
      getHandlerName: () => 'handler' as string | symbol,
    };

    expect(reflector.get(Roles, context)).toEqual(['admin', 'editor']);
  });

  it('should create a typed decorator at method level and read back', () => {
    const reflector = new Reflector();
    const CacheKey = Reflector.createDecorator<string>();

    class TestController {
      @CacheKey('users-list')
      handler() {}
    }

    const context = {
      getClass: () => TestController,
      getHandlerName: () => 'handler' as string | symbol,
    };

    expect(reflector.getHandler(CacheKey, context)).toBe('users-list');
  });

  it('should support explicit key option and expose .KEY', () => {
    const Roles = Reflector.createDecorator<string[]>({ key: 'roles' });
    expect(Roles.KEY).toBe('roles');
  });

  it('should produce distinct keys for separate createDecorator calls', () => {
    const Dec1 = Reflector.createDecorator<string>();
    const Dec2 = Reflector.createDecorator<string>();
    expect(Dec1.KEY).not.toBe(Dec2.KEY);
  });

  it('should keep default keys distinct across re-evaluated module copies', async () => {
    const original = Array.from({ length: 3 }, () => Reflector.createDecorator<string>().KEY);
    // A second evaluation of the module graph (duplicated package copy, HMR)
    // shares the globalThis-anchored registry, so it must not reuse keys.
    vi.resetModules();
    const { Reflector: Reevaluated } = await import('../pipeline/reflector.js');
    const copy = Array.from({ length: 3 }, () => Reevaluated.createDecorator<string>().KEY);
    expect(Reevaluated).not.toBe(Reflector);
    expect(new Set([...original, ...copy]).size).toBe(6);
  });

  it('supports explicit string metadata keys', () => {
    const reflector = new Reflector();

    @Roles('admin')
    class TestController {
      handler() {}
    }

    const context = {
      getClass: () => TestController,
      getHandlerName: () => 'handler' as string | symbol,
    };

    expect(reflector.get<string[]>('roles', context)).toEqual(['admin']);
  });
});

describe('Reflector.getAllAndOverride', () => {
  it('should return handler value when both defined', () => {
    const reflector = new Reflector();

    @Roles('admin')
    class TestController {
      @Roles('editor')
      handler() {}
    }

    const context = {
      getClass: () => TestController,
      getHandlerName: () => 'handler' as string | symbol,
    };

    expect(reflector.getAllAndOverride<string[]>('roles', context)).toEqual(['editor']);
  });

  it('should return class value when handler undefined', () => {
    const reflector = new Reflector();

    @Roles('admin')
    class TestController {
      handler() {}
    }

    const context = {
      getClass: () => TestController,
      getHandlerName: () => 'handler' as string | symbol,
    };

    expect(reflector.getAllAndOverride<string[]>('roles', context)).toEqual(['admin']);
  });

  it('should return undefined when neither defined', () => {
    const reflector = new Reflector();

    class TestController {
      handler() {}
    }

    const context = {
      getClass: () => TestController,
      getHandlerName: () => 'handler' as string | symbol,
    };

    expect(reflector.getAllAndOverride('roles', context)).toBeUndefined();
  });

  it('should work with ReflectableDecorator', () => {
    const reflector = new Reflector();
    const Priority = Reflector.createDecorator<number>();

    @Priority(1)
    class TestController {
      @Priority(10)
      handler() {}
    }

    const context = {
      getClass: () => TestController,
      getHandlerName: () => 'handler' as string | symbol,
    };

    expect(reflector.getAllAndOverride(Priority, context)).toBe(10);
  });
});

describe('Reflector.getAllAndMerge', () => {
  it('should concatenate arrays', () => {
    const reflector = new Reflector();

    @Roles('admin')
    class TestController {
      @Roles('editor')
      handler() {}
    }

    const context = {
      getClass: () => TestController,
      getHandlerName: () => 'handler' as string | symbol,
    };

    expect(reflector.getAllAndMerge<string[]>('roles', context)).toEqual(['editor', 'admin']);
  });

  it('should shallow-merge objects', () => {
    const reflector = new Reflector();
    const Config = (...args: [Record<string, unknown>]) => SetMetadata('config', args[0]);

    @Config({ timeout: 5000 })
    class TestController {
      @Config({ retries: 3 })
      handler() {}
    }

    const context = {
      getClass: () => TestController,
      getHandlerName: () => 'handler' as string | symbol,
    };

    expect(reflector.getAllAndMerge('config', context)).toEqual({ retries: 3, timeout: 5000 });
  });

  it('should return single value when only one level defines', () => {
    const reflector = new Reflector();

    @Roles('admin')
    class TestController {
      handler() {}
    }

    const context = {
      getClass: () => TestController,
      getHandlerName: () => 'handler' as string | symbol,
    };

    expect(reflector.getAllAndMerge<string[]>('roles', context)).toEqual(['admin']);
  });

  it('should return empty array when neither defined', () => {
    const reflector = new Reflector();

    class TestController {
      handler() {}
    }

    const context = {
      getClass: () => TestController,
      getHandlerName: () => 'handler' as string | symbol,
    };

    expect(reflector.getAllAndMerge('roles', context)).toEqual([]);
  });
});
