import { describe, expect, it } from 'vitest';
import {
  Catch,
  Controller,
  Get,
  Inject,
  Injectable,
  InjectionToken,
  Module,
  Param,
  REQUEST_CONTEXT,
  Reflector,
  Scope,
  SetMetadata,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UsePipes,
  VelaFactory,
  defineProvider,
  type ArgumentMetadata,
  type CallHandler,
  type CanActivate,
  type ExceptionFilter,
  type ExecutionContext,
  type NestInterceptor,
  type PipeTransform,
  type RequestContext,
} from '../index';
import { dispatchQueueJob, Process, Processor } from '../queue/index';

const Roles = (...roles: string[]) => SetMetadata('roles', roles);

@Injectable()
class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<string[]>('roles', context);
    return !roles || roles.includes(context.getRequest().headers.get('x-role') ?? '');
  }
}

describe('enhancer auto-registration', () => {
  it('constructs a @UseGuards class with dependencies that no module lists', async () => {
    @Controller('/admin')
    @UseGuards(RolesGuard)
    class AdminController {
      @Roles('admin')
      @Get()
      index() {
        return { ok: true };
      }
    }

    @Module({ controllers: [AdminController] })
    class AdminModule {}

    const app = await VelaFactory.create(AdminModule);
    const hono = app.getHonoApp();
    expect((await hono.request('/admin')).status).toBe(403);
    expect((await hono.request('/admin', { headers: { 'x-role': 'admin' } })).status).toBe(200);
    await app.close();
  });

  it('builds each parameterless enhancer once, not per request', async () => {
    const built: string[] = [];

    class OpenGuard implements CanActivate {
      constructor() {
        built.push('guard');
      }
      canActivate(): boolean {
        return true;
      }
    }

    @Injectable()
    class PassInterceptor implements NestInterceptor {
      constructor() {
        built.push('interceptor');
      }
      intercept(_context: ExecutionContext, next: CallHandler): Promise<unknown> {
        return next.handle();
      }
    }

    class TrimPipe implements PipeTransform {
      constructor() {
        built.push('pipe');
      }
      transform(value: unknown, _metadata: ArgumentMetadata): unknown {
        return typeof value === 'string' ? value.trim() : value;
      }
    }

    class UpperPipe implements PipeTransform {
      constructor() {
        built.push('param-pipe');
      }
      transform(value: unknown): unknown {
        return typeof value === 'string' ? value.toUpperCase() : value;
      }
    }

    @Catch()
    class JsonFilter implements ExceptionFilter {
      constructor() {
        built.push('filter');
      }
      catch(): unknown {
        return { failed: true };
      }
    }

    @Controller('/items')
    @UseGuards(OpenGuard)
    @UseFilters(JsonFilter)
    class ItemsController {
      @Get('/:name')
      @UseInterceptors(PassInterceptor)
      @UsePipes(TrimPipe)
      find(@Param('name', UpperPipe) name: string) {
        if (name === 'FAIL') throw new Error('broken');
        return { name };
      }
    }

    @Module({ controllers: [ItemsController] })
    class ItemsModule {}

    const app = await VelaFactory.create(ItemsModule);
    const hono = app.getHonoApp();
    expect(await (await hono.request('/items/a')).json()).toEqual({ name: 'A' });
    expect(await (await hono.request('/items/b')).json()).toEqual({ name: 'B' });
    expect(await (await hono.request('/items/fail')).json()).toEqual({ failed: true });
    expect(built.toSorted()).toEqual(['filter', 'guard', 'interceptor', 'param-pipe', 'pipe']);
    await app.close();
  });

  it('resolves each enhancer from the module that declares it', async () => {
    const TENANT = new InjectionToken<string>('enhancer tenant');
    const seen: string[] = [];

    @Injectable()
    class TenantGuard implements CanActivate {
      constructor(@Inject(TENANT) private readonly tenant: string) {}
      canActivate(): boolean {
        seen.push(this.tenant);
        return true;
      }
    }

    @Controller('/north')
    @UseGuards(TenantGuard)
    class NorthController {
      @Get()
      index() {
        return {};
      }
    }

    @Controller('/south')
    @UseGuards(TenantGuard)
    class SouthController {
      @Get()
      index() {
        return {};
      }
    }

    @Module({
      providers: [defineProvider(TENANT, { useValue: 'north' })],
      controllers: [NorthController],
    })
    class NorthModule {}

    @Module({
      providers: [defineProvider(TENANT, { useValue: 'south' })],
      controllers: [SouthController],
    })
    class SouthModule {}

    @Module({ imports: [NorthModule, SouthModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();
    await hono.request('/north');
    await hono.request('/south');
    expect(seen).toEqual(['north', 'south']);
    await app.close();
  });

  it('reuses a visible enhancer provider instead of registering another', async () => {
    let built = 0;

    @Injectable()
    class SharedGuard implements CanActivate {
      constructor() {
        built++;
      }
      canActivate(): boolean {
        return true;
      }
    }

    @Module({ providers: [SharedGuard], exports: [SharedGuard] })
    class GuardModule {}

    @Controller('/shared')
    @UseGuards(SharedGuard)
    class SharedController {
      @Get()
      index() {
        return {};
      }
    }

    @Module({ imports: [GuardModule], controllers: [SharedController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await app.getHonoApp().request('/shared');
    expect(built).toBe(1);
    expect(app.getContainer().getOwnerModuleIds(SharedGuard)).toEqual(['GuardModule#default']);
    await app.close();
  });

  it('keeps request-scoped enhancers per request, declared or bubbled', async () => {
    const ids: string[] = [];

    @Injectable({ scope: Scope.REQUEST })
    class DeclaredGuard implements CanActivate {
      readonly id = crypto.randomUUID();
      canActivate(): boolean {
        ids.push(`declared:${this.id}`);
        return true;
      }
    }

    @Injectable()
    class BubbledGuard implements CanActivate {
      constructor(@Inject(REQUEST_CONTEXT) private readonly request: RequestContext) {}
      canActivate(): boolean {
        ids.push(`bubbled:${this.request.id}`);
        return true;
      }
    }

    @Controller('/scoped')
    @UseGuards(DeclaredGuard, BubbledGuard)
    class ScopedController {
      @Get()
      index() {
        return {};
      }
    }

    @Module({ controllers: [ScopedController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();
    await hono.request('/scoped');
    await hono.request('/scoped');
    expect(new Set(ids).size).toBe(4);
    await app.close();
  });

  it('defers the enhancers of a lazy module with the rest of its group', async () => {
    let built = 0;

    class LazyGuard implements CanActivate {
      constructor() {
        built++;
      }
      canActivate(): boolean {
        return true;
      }
    }

    @Controller('/lazy')
    @UseGuards(LazyGuard)
    class LazyController {
      @Get()
      index() {
        return {};
      }
    }

    @Module({ lazy: true, controllers: [LazyController] })
    class LazyFeature {}

    @Module({ imports: [LazyFeature] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(built).toBe(0);
    expect(app.getContainer().isLazyPending(LazyGuard)).toBe(true);
    expect((await app.getHonoApp().request('/lazy')).status).toBe(200);
    expect(built).toBe(1);
    await app.close();
  });

  it('registers the enhancers of non-HTTP entrypoints such as queue processors', async () => {
    const handled: string[] = [];

    @Injectable()
    class QueueRoleGuard implements CanActivate {
      constructor(private readonly reflector: Reflector) {}
      canActivate(context: ExecutionContext): boolean {
        return this.reflector.get<string[]>('roles', context) === undefined;
      }
    }

    @Processor('reports')
    @UseGuards(QueueRoleGuard)
    class ReportJobs {
      @Process('build')
      build() {
        handled.push('build');
      }
    }

    @Module({ providers: [ReportJobs] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await dispatchQueueJob(app.getContainer(), app.entrypoints, {
      id: 'job-1',
      queue: 'reports',
      name: 'build',
      data: {},
      attempt: 1,
    });
    expect(handled).toEqual(['build']);
    await app.close();
  });
});
