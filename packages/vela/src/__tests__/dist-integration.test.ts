import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGE_ROOT = join(__dirname, '..', '..');

/**
 * Integration test: import from built dist/ to verify the package
 * works as a consumer would use it.
 */
describe('dist/ integration', () => {
  it('declares side effects only for modules the build emits', () => {
    // Bundlers drop every dist module this list does not name once none of its
    // exports are used; an entry naming a file the build never writes protects
    // nothing (the Reflect polyfill in metadata.js is the one that matters).
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      sideEffects: string[];
    };
    expect(manifest.sideEffects).toContain('./dist/metadata.js');
    expect(manifest.sideEffects.filter((path) => !existsSync(join(PACKAGE_ROOT, path)))).toEqual(
      [],
    );
  });

  it('emits one module per source file so unused features tree-shake', () => {
    // A chunk shared by VelaFactory and feature modules keeps every decorated
    // feature class in a Worker that only imports the factory: each
    // `X = __decorate([...], X)` assignment is a side effect bundlers must keep.
    const factory = readFileSync(join(PACKAGE_ROOT, 'dist', 'factory.js'), 'utf8');
    expect(factory).toContain('VelaFactory');
    expect(factory).not.toContain('__decorate(');
    expect(existsSync(join(PACKAGE_ROOT, 'dist', 'schedule', 'schedule.module.js'))).toBe(true);
  });

  it('keeps the Reflect polyfill import of each entry that installs it', () => {
    // package.json#sideEffects names dist files, so without a build rule the
    // bundler treats src/metadata.ts as side-effect free and drops an entry's
    // bare `import '../metadata'`: loading only that entry would never install
    // Reflect.metadata.
    const scheduleNode = readFileSync(
      join(PACKAGE_ROOT, 'dist', 'schedule-node', 'index.js'),
      'utf8',
    );
    expect(scheduleNode).toMatch(/^import "\.\.\/metadata\.js";$/mu);
  });

  it('should export all core symbols from the main entry point', async () => {
    const vela = await import('../../dist/index.js');

    // Factory & Application
    expect(vela.VelaFactory).toBeDefined();
    expect(vela.VelaApplication).toBeDefined();

    // DI
    expect(vela.Container).toBeDefined();
    expect(vela.Injectable).toBeDefined();
    expect(vela.Inject).toBeDefined();
    expect(vela.InjectionToken).toBeDefined();

    // Constants
    expect(vela.METADATA_KEYS).toBeDefined();
    expect(vela.HttpMethod).toBeDefined();
    expect(vela.ParamType).toBeDefined();
    expect(vela.Scope).toBeDefined();

    // HTTP decorators
    expect(vela.Controller).toBeDefined();
    expect(vela.Get).toBeDefined();
    expect(vela.Post).toBeDefined();
    expect(vela.Put).toBeDefined();
    expect(vela.Patch).toBeDefined();
    expect(vela.Delete).toBeDefined();
    expect(vela.Param).toBeDefined();
    expect(vela.Query).toBeDefined();
    expect(vela.Body).toBeDefined();
    expect(vela.Headers).toBeDefined();
    expect(vela.Req).toBeDefined();

    // Module
    expect(vela.Module).toBeDefined();

    // Pipeline decorators
    expect(vela.UseMiddleware).toBeDefined();
    expect(vela.UseGuards).toBeDefined();
    expect(vela.UsePipes).toBeDefined();
    expect(vela.UseInterceptors).toBeDefined();
    expect(vela.UseFilters).toBeDefined();
    expect(vela.Catch).toBeDefined();
    expect(vela.SetMetadata).toBeDefined();
    expect(vela.Reflector).toBeDefined();

    // Built-in pipes
    expect(vela.ParseIntPipe).toBeDefined();
    expect(vela.ParseFloatPipe).toBeDefined();
    expect(vela.ParseBoolPipe).toBeDefined();
    expect(vela.DefaultValuePipe).toBeDefined();
    expect(vela.RequiredPipe).toBeDefined();
    expect(vela.ValidationPipe).toBeDefined();
    // ValidationPipe is the one schema pipe; the raw-parse Zod pipe answered 500.
    expect('ZodValidationPipe' in vela).toBe(false);

    // Errors
    expect(vela.HttpException).toBeDefined();
    expect(vela.BadRequestException).toBeDefined();
    expect(vela.UnauthorizedException).toBeDefined();
    expect(vela.ForbiddenException).toBeDefined();
    expect(vela.NotFoundException).toBeDefined();
    expect(vela.InternalServerErrorException).toBeDefined();

    // Advanced — internal subpath
    const internal = await import('../../dist/internal.js');
    expect(internal.MetadataRegistry).toBeDefined();
    expect(internal.ComponentManager).toBeDefined();
    expect(internal.Container).toBeDefined();
    expect(internal.RouteManager).toBeDefined();
    expect(internal.ModuleLoader).toBeDefined();
    expect(internal.bindAppProviders).toBeDefined();
  });

  it('should create a working app from dist/', async () => {
    const { VelaFactory, Controller, Get, Injectable, Module } =
      await import('../../dist/index.js');
    const { MetadataRegistry } = await import('../../dist/internal.js');

    @Injectable()
    class HelloService {
      greet() {
        return 'Hello from dist!';
      }
    }

    @Controller('/hello')
    class HelloController {
      constructor(private helloService: HelloService) {}

      @Get()
      handle() {
        return { message: this.helloService.greet() };
      }
    }

    @Module({
      providers: [HelloService],
      controllers: [HelloController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/hello');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: 'Hello from dist!' });
  });
});
