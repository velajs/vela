import 'reflect-metadata';
import { describe, it, expect } from 'vitest';

/**
 * Integration test: import from built dist/ to verify the package
 * works as a consumer would use it.
 */
describe('dist/ integration', () => {
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
    expect(vela.ZodValidationPipe).toBeDefined();

    // Errors
    expect(vela.HttpException).toBeDefined();
    expect(vela.BadRequestException).toBeDefined();
    expect(vela.UnauthorizedException).toBeDefined();
    expect(vela.ForbiddenException).toBeDefined();
    expect(vela.NotFoundException).toBeDefined();
    expect(vela.InternalServerErrorException).toBeDefined();

    // Advanced
    expect(vela.MetadataRegistry).toBeDefined();
    expect(vela.ComponentManager).toBeDefined();
  });

  it('should create a working app from dist/', async () => {
    const {
      VelaFactory,
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

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/hello');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: 'Hello from dist!' });

    MetadataRegistry.clear();
  });
});
