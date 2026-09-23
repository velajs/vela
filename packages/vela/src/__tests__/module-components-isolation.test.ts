import { describe, expect, it } from 'vitest';
import {
  Controller,
  Get,
  Injectable,
  Module,
  UseGuards,
  UseInterceptors,
  VelaFactory,
  type CallHandler,
  type CanActivate,
  type NestInterceptor,
} from '../index';
import {
  MetadataRegistry,
  resolveScopedComponents,
  resolveScopedComponentsAsync,
} from '../module-kit';

// Module-level @Use* decorators are per-application state. Bootstrapping the
// same module classes again in one isolate (per-env rebuilds, Durable Object
// instances, tests) must not stack another copy onto the controllers.
describe('module-level components across bootstraps', () => {
  it('runs module-level guards and interceptors once per request on every app', async () => {
    const calls: string[] = [];

    @Injectable()
    class ControllerGuard implements CanActivate {
      canActivate(): boolean {
        calls.push('controller-guard');
        return true;
      }
    }

    @Injectable()
    class ModuleGuard implements CanActivate {
      canActivate(): boolean {
        calls.push('module-guard');
        return true;
      }
    }

    @Injectable()
    class WrapInterceptor implements NestInterceptor {
      async intercept(_context: unknown, next: CallHandler): Promise<unknown> {
        calls.push('module-interceptor');
        return { wrapped: await next.handle() };
      }
    }

    @Controller('/reports')
    @UseGuards(ControllerGuard)
    class ReportsController {
      @Get()
      list() {
        return { ok: true };
      }
    }

    @UseGuards(ModuleGuard)
    @UseInterceptors(WrapInterceptor)
    @Module({
      providers: [ControllerGuard, ModuleGuard, WrapInterceptor],
      controllers: [ReportsController],
    })
    class ReportsModule {}

    @Module({ imports: [ReportsModule] })
    class AppModule {}

    const first = await VelaFactory.create(AppModule);
    const second = await VelaFactory.create(AppModule);

    for (const app of [first, second]) {
      calls.length = 0;
      const response = await app.getHonoApp().request('/reports');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ wrapped: { ok: true } });
      expect(calls).toEqual(['controller-guard', 'module-guard', 'module-interceptor']);
    }

    // The controller's own decoration is untouched by bootstrap.
    expect(MetadataRegistry.getController('guard', ReportsController)).toEqual([ControllerGuard]);
    expect(MetadataRegistry.getController('interceptor', ReportsController)).toEqual([]);
  });

  it('resolves module-level components for non-HTTP dispatch of the owning module', async () => {
    @Injectable()
    class ModuleGuard implements CanActivate {
      canActivate(): boolean {
        return true;
      }
    }

    @Injectable()
    class ReportJob {
      run(): void {}
    }

    @Controller('/exports')
    class ExportsController {
      @Get()
      read() {
        return { ok: true };
      }
    }

    @UseGuards(ModuleGuard)
    @Module({ providers: [ModuleGuard, ReportJob], controllers: [ExportsController] })
    class ExportsModule {}

    @Module({ imports: [ExportsModule] })
    class AppModule {}

    await VelaFactory.create(AppModule);
    const container = (await VelaFactory.create(AppModule)).getContainer();
    const [moduleId] = container.getOwnerModuleIds(ExportsController);
    expect(moduleId).toMatch(/^ExportsModule#/);

    const guards = await resolveScopedComponentsAsync(
      'guard',
      ExportsController,
      'read',
      container,
      moduleId,
    );
    expect(guards).toHaveLength(1);
    expect(guards[0]).toBeInstanceOf(ModuleGuard);
    // Callers that omit the owner still get the components of a unique owner.
    expect(resolveScopedComponents('guard', ExportsController, 'read', container)).toHaveLength(1);
    // Module-level components belong to the module's controllers, not to
    // every provider it declares.
    expect(resolveScopedComponents('guard', ReportJob, 'run', container, moduleId)).toEqual([]);
  });
});
