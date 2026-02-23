import { describe, it, expect, beforeEach } from 'vitest';
import {
  VelaFactory,
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
  Headers,
  Req,
  Injectable,
  Inject,
  Module,
  InjectionToken,
  UseGuards,
  UsePipes,
  UseInterceptors,
  UseFilters,
  Catch,
  ParseIntPipe,
  DefaultValuePipe,
  HttpException,
  ForbiddenException,
  NotFoundException,
  MetadataRegistry,
  Scope,
} from '../index.js';
import type {
  CanActivate,
  ExecutionContext,
  NestInterceptor,
  CallHandler,
  PipeTransform,
  ArgumentMetadata,
  ExceptionFilter,
  OnModuleInit,
  OnApplicationBootstrap,
} from '../index.js';

// Clean state before each test
beforeEach(() => {
  MetadataRegistry.clear();
});

// =============================================================================
// Test 1: Basic controller + service + module
// =============================================================================

describe('Basic app', () => {
  it('should route GET requests to controller methods', async () => {
    @Injectable()
    class GreetingService {
      greet(name: string): string {
        return `Hello, ${name}!`;
      }

      list(): string[] {
        return ['Alice', 'Bob'];
      }
    }

    @Controller('/greetings')
    class GreetingController {
      constructor(private greetingService: GreetingService) {}

      @Get()
      findAll() {
        return this.greetingService.list();
      }

      @Get('/:name')
      findOne(@Param('name') name: string) {
        return { message: this.greetingService.greet(name) };
      }
    }

    @Module({
      providers: [GreetingService],
      controllers: [GreetingController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    // Test GET /greetings
    const res1 = await hono.request('/greetings');
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual(['Alice', 'Bob']);

    // Test GET /greetings/World
    const res2 = await hono.request('/greetings/World');
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ message: 'Hello, World!' });
  });

  it('should handle POST with @Body()', async () => {
    @Controller('/items')
    class ItemController {
      @Post()
      create(@Body() body: { name: string }) {
        return { id: 1, ...body };
      }
    }

    @Module({ controllers: [ItemController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Widget' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 1, name: 'Widget' });
  });

  it('should handle @Query() parameters', async () => {
    @Controller('/search')
    class SearchController {
      @Get()
      search(@Query('q') query: string, @Query('page') page: string) {
        return { query, page };
      }
    }

    @Module({ controllers: [SearchController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/search?q=hello&page=2');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ query: 'hello', page: '2' });
  });

  it('should handle @Headers() parameter', async () => {
    @Controller('/auth')
    class AuthController {
      @Get()
      check(@Headers('authorization') auth: string) {
        return { auth };
      }
    }

    @Module({ controllers: [AuthController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/auth', {
      headers: { authorization: 'Bearer token123' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ auth: 'Bearer token123' });
  });

  it('should pass Hono context with @Req()', async () => {
    @Controller('/raw')
    class RawController {
      @Get()
      handle(@Req() ctx: any) {
        return ctx.json({ url: ctx.req.url });
      }
    }

    @Module({ controllers: [RawController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/raw');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.url).toContain('/raw');
  });

  it('should return 204 for null/undefined results', async () => {
    @Controller('/empty')
    class EmptyController {
      @Delete('/:id')
      remove(@Param('id') _id: string) {
        return null;
      }
    }

    @Module({ controllers: [EmptyController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/empty/1', { method: 'DELETE' });
    expect(res.status).toBe(204);
  });

  it('should return text for string results', async () => {
    @Controller('/text')
    class TextController {
      @Get()
      hello() {
        return 'Hello!';
      }
    }

    @Module({ controllers: [TextController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/text');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('Hello!');
  });
});

// =============================================================================
// Test 2: DI
// =============================================================================

describe('DI Container', () => {
  it('should inject dependencies into controllers', async () => {
    @Injectable()
    class Logger {
      log(msg: string) {
        return `[LOG] ${msg}`;
      }
    }

    @Injectable()
    class UserService {
      constructor(private logger: Logger) {}

      getUser(id: string) {
        return { id, logged: this.logger.log(`getUser(${id})`) };
      }
    }

    @Controller('/users')
    class UserController {
      constructor(private userService: UserService) {}

      @Get('/:id')
      findOne(@Param('id') id: string) {
        return this.userService.getUser(id);
      }
    }

    @Module({
      providers: [Logger, UserService],
      controllers: [UserController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/users/42');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: '42',
      logged: '[LOG] getUser(42)',
    });
  });

  it('should support InjectionToken with @Inject()', async () => {
    const CONFIG = new InjectionToken<{ apiUrl: string }>('CONFIG');

    @Injectable()
    class ApiService {
      constructor(@Inject(CONFIG) private config: { apiUrl: string }) {}

      getUrl() {
        return this.config.apiUrl;
      }
    }

    @Controller('/api')
    class ApiController {
      constructor(private apiService: ApiService) {}

      @Get('/url')
      getUrl() {
        return { url: this.apiService.getUrl() };
      }
    }

    @Module({
      providers: [
        ApiService,
        { token: CONFIG, useValue: { apiUrl: 'https://api.example.com' } },
      ],
      controllers: [ApiController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/api/url');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://api.example.com' });
  });

  it('should resolve from container via app.get()', async () => {
    @Injectable()
    class CounterService {
      count = 0;
      increment() {
        return ++this.count;
      }
    }

    @Module({ providers: [CounterService] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const counter = app.get(CounterService);
    expect(counter.increment()).toBe(1);
    expect(counter.increment()).toBe(2);

    // Singleton: same instance
    const counter2 = app.get(CounterService);
    expect(counter2.count).toBe(2);
  });
});

// =============================================================================
// Test 3: Guards
// =============================================================================

describe('Guards', () => {
  it('should block unauthorized requests', async () => {
    class AuthGuard implements CanActivate {
      canActivate(context: ExecutionContext): boolean {
        const req = context.getRequest();
        return req.headers.get('authorization') === 'Bearer valid';
      }
    }

    @Controller('/protected')
    @UseGuards(new AuthGuard())
    class ProtectedController {
      @Get()
      secret() {
        return { secret: 'data' };
      }
    }

    @Module({ controllers: [ProtectedController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    // Without auth — 403
    const res1 = await hono.request('/protected');
    expect(res1.status).toBe(403);

    // With auth — 200
    const res2 = await hono.request('/protected', {
      headers: { authorization: 'Bearer valid' },
    });
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ secret: 'data' });
  });

  it('should support method-level guards', async () => {
    class AdminGuard implements CanActivate {
      canActivate(context: ExecutionContext): boolean {
        const req = context.getRequest();
        return req.headers.get('x-role') === 'admin';
      }
    }

    @Controller('/items')
    class ItemController {
      @Get()
      list() {
        return ['item1'];
      }

      @Delete('/:id')
      @UseGuards(new AdminGuard())
      remove(@Param('id') id: string) {
        return { deleted: id };
      }
    }

    @Module({ controllers: [ItemController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    // GET works without guard
    const res1 = await hono.request('/items');
    expect(res1.status).toBe(200);

    // DELETE without admin role — 403
    const res2 = await hono.request('/items/1', { method: 'DELETE' });
    expect(res2.status).toBe(403);

    // DELETE with admin role — 200
    const res3 = await hono.request('/items/1', {
      method: 'DELETE',
      headers: { 'x-role': 'admin' },
    });
    expect(res3.status).toBe(200);
    expect(await res3.json()).toEqual({ deleted: '1' });
  });
});

// =============================================================================
// Test 4: Pipes
// =============================================================================

describe('Pipes', () => {
  it('should transform params with ParseIntPipe', async () => {
    @Controller('/users')
    class UserController {
      @Get('/:id')
      findOne(@Param('id', ParseIntPipe) id: number) {
        return { id, type: typeof id };
      }
    }

    @Module({ controllers: [UserController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/users/42');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 42, type: 'number' });

    // Invalid int — 400
    const res2 = await hono.request('/users/abc');
    expect(res2.status).toBe(400);
  });

  it('should support DefaultValuePipe', async () => {
    @Controller('/list')
    class ListController {
      @Get()
      list(@Query('page', new DefaultValuePipe('1')) page: string) {
        return { page };
      }
    }

    @Module({ controllers: [ListController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/list');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ page: '1' });

    const res2 = await hono.request('/list?page=5');
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ page: '5' });
  });
});

// =============================================================================
// Test 5: Interceptors
// =============================================================================

describe('Interceptors', () => {
  it('should wrap handler with interceptor (onion pattern)', async () => {
    class WrapInterceptor implements NestInterceptor {
      async intercept(_context: ExecutionContext, next: CallHandler): Promise<unknown> {
        const result = await next.handle();
        return { data: result, wrapped: true };
      }
    }

    @Controller('/wrapped')
    @UseInterceptors(new WrapInterceptor())
    class WrappedController {
      @Get()
      hello() {
        return 'Hello';
      }
    }

    @Module({ controllers: [WrappedController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/wrapped');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: 'Hello', wrapped: true });
  });

  it('should chain multiple interceptors in correct order', async () => {
    const order: string[] = [];

    class FirstInterceptor implements NestInterceptor {
      async intercept(_ctx: ExecutionContext, next: CallHandler) {
        order.push('first-before');
        const result = await next.handle();
        order.push('first-after');
        return result;
      }
    }

    class SecondInterceptor implements NestInterceptor {
      async intercept(_ctx: ExecutionContext, next: CallHandler) {
        order.push('second-before');
        const result = await next.handle();
        order.push('second-after');
        return result;
      }
    }

    @Controller('/chain')
    @UseInterceptors(new FirstInterceptor(), new SecondInterceptor())
    class ChainController {
      @Get()
      handle() {
        order.push('handler');
        return 'ok';
      }
    }

    @Module({ controllers: [ChainController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    await hono.request('/chain');
    expect(order).toEqual([
      'first-before',
      'second-before',
      'handler',
      'second-after',
      'first-after',
    ]);
  });
});

// =============================================================================
// Test 6: Exception Filters
// =============================================================================

describe('Exception Filters', () => {
  it('should catch exceptions with @Catch filter', async () => {
    @Catch(NotFoundException)
    class NotFoundFilter implements ExceptionFilter<NotFoundException> {
      catch(exception: NotFoundException, _context: ExecutionContext) {
        return {
          statusCode: 404,
          error: 'Custom Not Found',
          detail: exception.message,
        };
      }
    }

    @Controller('/filtered')
    @UseFilters(new NotFoundFilter())
    class FilteredController {
      @Get('/:id')
      findOne(@Param('id') id: string) {
        throw new NotFoundException(`Item ${id} not found`);
      }
    }

    @Module({ controllers: [FilteredController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/filtered/99');
    expect(res.status).toBe(200); // filter returns a plain object, not a Response
    expect(await res.json()).toEqual({
      statusCode: 404,
      error: 'Custom Not Found',
      detail: 'Item 99 not found',
    });
  });

  it('should fall through to default handler when no filter matches', async () => {
    @Catch(NotFoundException)
    class NotFoundFilter implements ExceptionFilter<NotFoundException> {
      catch(_exception: NotFoundException, _context: ExecutionContext) {
        return { handled: true };
      }
    }

    @Controller('/errors')
    @UseFilters(new NotFoundFilter())
    class ErrorController {
      @Get()
      fail() {
        throw new ForbiddenException('Access denied');
      }
    }

    @Module({ controllers: [ErrorController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/errors');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ statusCode: 403, message: 'Access denied' });
  });
});

// =============================================================================
// Test 7: Module system
// =============================================================================

describe('Module system', () => {
  it('should load nested modules with imports', async () => {
    @Injectable()
    class SharedService {
      getValue() {
        return 'shared';
      }
    }

    @Module({
      providers: [SharedService],
      exports: [SharedService],
    })
    class SharedModule {}

    @Controller('/feature')
    class FeatureController {
      constructor(private shared: SharedService) {}

      @Get()
      handle() {
        return { value: this.shared.getValue() };
      }
    }

    @Module({
      imports: [SharedModule],
      controllers: [FeatureController],
    })
    class FeatureModule {}

    @Module({
      imports: [FeatureModule],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/feature');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: 'shared' });
  });
});

// =============================================================================
// Test 8: Lifecycle hooks
// =============================================================================

describe('Lifecycle hooks', () => {
  it('should call onModuleInit and onApplicationBootstrap', async () => {
    const calls: string[] = [];

    @Injectable()
    class StartupService implements OnModuleInit, OnApplicationBootstrap {
      onModuleInit() {
        calls.push('onModuleInit');
      }
      onApplicationBootstrap() {
        calls.push('onApplicationBootstrap');
      }
    }

    @Module({ providers: [StartupService] })
    class AppModule {}

    await VelaFactory.create(AppModule);

    expect(calls).toEqual(['onModuleInit', 'onApplicationBootstrap']);
  });
});

// =============================================================================
// Test 9: Global pipes/guards/interceptors
// =============================================================================

describe('Global components', () => {
  it('should apply global guards', async () => {
    class GlobalGuard implements CanActivate {
      canActivate(context: ExecutionContext): boolean {
        const req = context.getRequest();
        return req.headers.get('x-api-key') === 'secret';
      }
    }

    @Controller('/data')
    class DataController {
      @Get()
      getData() {
        return { data: 'ok' };
      }
    }

    @Module({ controllers: [DataController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    app.useGlobalGuards(new GlobalGuard());
    const hono = app.getHonoApp();

    const res1 = await hono.request('/data');
    expect(res1.status).toBe(403);

    const res2 = await hono.request('/data', {
      headers: { 'x-api-key': 'secret' },
    });
    expect(res2.status).toBe(200);
  });

  it('should apply global interceptors', async () => {
    class TimingInterceptor implements NestInterceptor {
      async intercept(_ctx: ExecutionContext, next: CallHandler) {
        const start = Date.now();
        const result = await next.handle();
        return { result, timing: true };
      }
    }

    @Controller('/timed')
    class TimedController {
      @Get()
      handle() {
        return 'fast';
      }
    }

    @Module({ controllers: [TimedController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    app.useGlobalInterceptors(new TimingInterceptor());
    const hono = app.getHonoApp();

    const res = await hono.request('/timed');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'fast', timing: true });
  });
});

// =============================================================================
// Test 10: HttpException
// =============================================================================

describe('HttpException', () => {
  it('should return proper status codes for different exceptions', async () => {
    @Controller('/exceptions')
    class ExceptionController {
      @Get('/not-found')
      notFound() {
        throw new NotFoundException('Resource not found');
      }

      @Get('/bad-request')
      badRequest() {
        throw new HttpException('Custom error', 422, {
          statusCode: 422,
          message: 'Custom error',
          errors: ['field1 is invalid'],
        });
      }
    }

    @Module({ controllers: [ExceptionController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res1 = await hono.request('/exceptions/not-found');
    expect(res1.status).toBe(404);
    expect(await res1.json()).toEqual({ statusCode: 404, message: 'Resource not found' });

    const res2 = await hono.request('/exceptions/bad-request');
    expect(res2.status).toBe(422);
    expect(await res2.json()).toEqual({
      statusCode: 422,
      message: 'Custom error',
      errors: ['field1 is invalid'],
    });
  });
});
