import 'reflect-metadata';
import { describe, it, expect } from 'bun:test';

/**
 * Integration test: import from built dist/ to verify the package
 * works as a consumer would use it.
 */
describe('dist/ integration', () => {
  it('should export all core symbols from the main entry point', async () => {
    const edgest = await import('../../dist/index.js');

    // Factory & Application
    expect(edgest.EdgestFactory).toBeDefined();
    expect(edgest.EdgestApplication).toBeDefined();

    // DI
    expect(edgest.Container).toBeDefined();
    expect(edgest.Injectable).toBeDefined();
    expect(edgest.Inject).toBeDefined();
    expect(edgest.InjectionToken).toBeDefined();

    // Constants
    expect(edgest.HttpMethod).toBeDefined();
    expect(edgest.ParamType).toBeDefined();
    expect(edgest.Scope).toBeDefined();

    // HTTP decorators
    expect(edgest.Controller).toBeDefined();
    expect(edgest.Get).toBeDefined();
    expect(edgest.Post).toBeDefined();
    expect(edgest.Put).toBeDefined();
    expect(edgest.Patch).toBeDefined();
    expect(edgest.Delete).toBeDefined();
    expect(edgest.Param).toBeDefined();
    expect(edgest.Query).toBeDefined();
    expect(edgest.Body).toBeDefined();
    expect(edgest.Headers).toBeDefined();
    expect(edgest.Req).toBeDefined();

    // Module
    expect(edgest.Module).toBeDefined();

    // Pipeline decorators
    expect(edgest.UseMiddleware).toBeDefined();
    expect(edgest.UseGuards).toBeDefined();
    expect(edgest.UsePipes).toBeDefined();
    expect(edgest.UseInterceptors).toBeDefined();
    expect(edgest.UseFilters).toBeDefined();
    expect(edgest.Catch).toBeDefined();
    expect(edgest.SetMetadata).toBeDefined();
    expect(edgest.Reflector).toBeDefined();

    // Built-in pipes
    expect(edgest.ParseIntPipe).toBeDefined();
    expect(edgest.ParseFloatPipe).toBeDefined();
    expect(edgest.ParseBoolPipe).toBeDefined();
    expect(edgest.DefaultValuePipe).toBeDefined();
    expect(edgest.RequiredPipe).toBeDefined();
    expect(edgest.ZodValidationPipe).toBeDefined();

    // Errors
    expect(edgest.HttpException).toBeDefined();
    expect(edgest.BadRequestException).toBeDefined();
    expect(edgest.UnauthorizedException).toBeDefined();
    expect(edgest.ForbiddenException).toBeDefined();
    expect(edgest.NotFoundException).toBeDefined();
    expect(edgest.InternalServerErrorException).toBeDefined();

    // Advanced
    expect(edgest.MetadataRegistry).toBeDefined();
    expect(edgest.ComponentManager).toBeDefined();
  });

  it('should export CRUD symbols from the crud entry point', async () => {
    const crud = await import('../../dist/crud/index.js');

    expect(crud.Crud).toBeDefined();
    expect(crud.getCrudConfig).toBeDefined();
    expect(crud.CrudModule).toBeDefined();
  });

  it('should create a working app from dist/', async () => {
    const {
      EdgestFactory,
      Controller,
      Get,
      Injectable,
      Module,
      MetadataRegistry,
    } = await import('../../dist/index.js');

    MetadataRegistry.clear();

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

    const app = await EdgestFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/hello');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: 'Hello from dist!' });

    MetadataRegistry.clear();
  });
});
