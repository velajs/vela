import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { z } from 'zod';
import {
  VelaFactory,
  Controller,
  Version,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  Headers,
  Req,
  Module,
  Global,
  Injectable,
  HttpCode,
  Header,
  Redirect,
  MetadataRegistry,
  APP_GUARD,
  APP_PIPE,
  APP_INTERCEPTOR,
  APP_FILTER,
  APP_MIDDLEWARE,
  UseGuards,
  UseInterceptors,
  UsePipes,
  UseFilters,
  Catch,
  SetMetadata,
  Reflector,
  applyDecorators,
  RequestMethod,
  ModuleRef,
  mixin,
  InjectionToken,
  Inject,
  ConfigModule,
  ConfigService,
  ParseIntPipe,
  ParseFloatPipe,
  ParseBoolPipe,
  ParseEnumPipe,
  ParseArrayPipe,
  ParseUUIDPipe,
  DefaultValuePipe,
  Res,
  createParamDecorator,
  Serialize,
  SerializerInterceptor,
  createZodDto,
  ValidationPipe,
  HttpException,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
  ConflictException,
  Cookie,
  Cookies,
  RawBody,
  Test,
  CacheModule,
  CacheInterceptor,
  CacheKey,
  CacheTTL,
  EventEmitterModule,
  EventEmitter,
  EventEmitterSubscriber,
  OnEvent,
  ScheduleModule,
  ScheduleRegistry,
  Cron,
  Interval,
  ThrottlerModule,
  ThrottlerGuard,
  Throttle,
  SkipThrottle,
  Put,
  Patch,
  Options,
  Head,
  Sse,
  HttpModule,
  HttpService,
  HttpRequestException,
  HealthModule,
  HealthCheckService,
  HealthIndicatorService,
  HttpHealthIndicator,
  ServiceUnavailableException,
} from '../index.js';
import type {
  OnModuleInit,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnApplicationShutdown,
  BeforeApplicationShutdown,
} from '../index.js';
import type {
  MiddlewareConsumer,
  NestModule,
  CanActivate,
  ExecutionContext,
  HttpArgumentsHost,
  NestInterceptor,
  CallHandler,
  PipeTransform,
  ArgumentMetadata,
  ExceptionFilter,
} from '../index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

// =============================================================================
// @HttpCode
// =============================================================================

describe('@HttpCode', () => {
  it('should override the default 200 status code', async () => {
    @Controller('/items')
    class ItemController {
      @Post()
      @HttpCode(201)
      create(@Body() data: { name: string }) {
        return { id: 1, ...data };
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
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 1, name: 'Widget' });
  });

  it('should return custom status for null responses', async () => {
    @Controller('/actions')
    class ActionController {
      @Post('/accept')
      @HttpCode(202)
      accept() {
        return null;
      }
    }

    @Module({ controllers: [ActionController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/actions/accept', { method: 'POST' });
    expect(res.status).toBe(202);
  });

  it('should work with @Delete returning 204 No Content', async () => {
    @Controller('/resources')
    class ResourceController {
      @Delete('/:id')
      @HttpCode(204)
      remove(@Param('id') _id: string) {
        return null;
      }
    }

    @Module({ controllers: [ResourceController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/resources/1', { method: 'DELETE' });
    expect(res.status).toBe(204);
  });
});

// =============================================================================
// @Header
// =============================================================================

describe('@Header', () => {
  it('should set a single response header', async () => {
    @Controller('/cached')
    class CachedController {
      @Get()
      @Header('Cache-Control', 'max-age=3600')
      getData() {
        return { data: 'cached' };
      }
    }

    @Module({ controllers: [CachedController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/cached');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('max-age=3600');
    expect(await res.json()).toEqual({ data: 'cached' });
  });

  it('should set multiple response headers', async () => {
    @Controller('/multi-header')
    class MultiHeaderController {
      @Get()
      @Header('X-Request-Id', 'abc-123')
      @Header('X-Powered-By', 'vela')
      @Header('Cache-Control', 'no-store')
      getData() {
        return { ok: true };
      }
    }

    @Module({ controllers: [MultiHeaderController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/multi-header');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Request-Id')).toBe('abc-123');
    expect(res.headers.get('X-Powered-By')).toBe('vela');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('should combine @Header with @HttpCode', async () => {
    @Controller('/combo')
    class ComboController {
      @Post()
      @HttpCode(201)
      @Header('Location', '/combo/1')
      create() {
        return { id: 1 };
      }
    }

    @Module({ controllers: [ComboController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/combo', { method: 'POST' });
    expect(res.status).toBe(201);
    expect(res.headers.get('Location')).toBe('/combo/1');
  });
});

// =============================================================================
// @Redirect
// =============================================================================

describe('@Redirect', () => {
  it('should redirect to a static URL', async () => {
    @Controller('/old')
    class OldController {
      @Get()
      @Redirect('/new', 301)
      handle() {}
    }

    @Module({ controllers: [OldController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/old', { redirect: 'manual' });
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/new');
  });

  it('should default to 302 when no status provided', async () => {
    @Controller('/temp')
    class TempController {
      @Get()
      @Redirect('/target')
      handle() {}
    }

    @Module({ controllers: [TempController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/temp', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/target');
  });

  it('should allow dynamic redirect via return value', async () => {
    @Controller('/dynamic')
    class DynamicController {
      @Get()
      @Redirect('/default')
      handle(@Query('to') to?: string) {
        if (to) return { url: to };
      }
    }

    @Module({ controllers: [DynamicController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    // Without override — default
    const res1 = await hono.request('/dynamic', { redirect: 'manual' });
    expect(res1.headers.get('Location')).toBe('/default');

    // With override
    const res2 = await hono.request('/dynamic?to=/custom', { redirect: 'manual' });
    expect(res2.headers.get('Location')).toBe('/custom');
  });

  it('should allow overriding status code via return value', async () => {
    @Controller('/status-override')
    class StatusOverrideController {
      @Get()
      @Redirect('/default', 302)
      handle(@Query('permanent') permanent?: string) {
        if (permanent) return { url: '/permanent-target', statusCode: 301 };
      }
    }

    @Module({ controllers: [StatusOverrideController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res1 = await hono.request('/status-override', { redirect: 'manual' });
    expect(res1.status).toBe(302);

    const res2 = await hono.request('/status-override?permanent=true', { redirect: 'manual' });
    expect(res2.status).toBe(301);
    expect(res2.headers.get('Location')).toBe('/permanent-target');
  });
});

// =============================================================================
// APP_* tokens
// =============================================================================

describe('APP_* tokens', () => {
  it('should register global guard via APP_GUARD provider', async () => {
    @Injectable()
    class ApiKeyGuard implements CanActivate {
      canActivate(context: ExecutionContext): boolean {
        const req = context.getRequest();
        return req.headers.get('x-api-key') === 'secret';
      }
    }

    @Controller('/guarded')
    class GuardedController {
      @Get()
      handle() {
        return { ok: true };
      }
    }

    @Module({
      providers: [
        ApiKeyGuard,
        { provide: APP_GUARD, useExisting: ApiKeyGuard },
      ],
      controllers: [GuardedController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res1 = await hono.request('/guarded');
    expect(res1.status).toBe(403);

    const res2 = await hono.request('/guarded', {
      headers: { 'x-api-key': 'secret' },
    });
    expect(res2.status).toBe(200);
  });

  it('should register global interceptor via APP_INTERCEPTOR provider', async () => {
    @Injectable()
    class WrapInterceptor implements NestInterceptor {
      async intercept(_ctx: ExecutionContext, next: CallHandler) {
        const result = await next.handle();
        return { data: result, wrapped: true };
      }
    }

    @Controller('/intercepted')
    class InterceptedController {
      @Get()
      handle() {
        return 'hello';
      }
    }

    @Module({
      providers: [
        WrapInterceptor,
        { provide: APP_INTERCEPTOR, useExisting: WrapInterceptor },
      ],
      controllers: [InterceptedController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/intercepted');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: 'hello', wrapped: true });
  });

  it('should register global pipe via APP_PIPE provider', async () => {
    @Injectable()
    class TrimPipe implements PipeTransform<unknown> {
      transform(value: unknown, _metadata: ArgumentMetadata) {
        if (typeof value === 'string') return value.trim();
        return value;
      }
    }

    @Controller('/trimmed')
    class TrimmedController {
      @Get('/:name')
      handle(@Param('name') name: string) {
        return { name };
      }
    }

    @Module({
      providers: [
        TrimPipe,
        { provide: APP_PIPE, useExisting: TrimPipe },
      ],
      controllers: [TrimmedController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    // Route params don't have leading/trailing spaces, but the pipe still runs
    const res = await hono.request('/trimmed/hello');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'hello' });
  });

  it('should support multiple APP_GUARD providers in order', async () => {
    const order: string[] = [];

    @Injectable()
    class FirstGuard implements CanActivate {
      canActivate(_context: ExecutionContext): boolean {
        order.push('first');
        return true;
      }
    }

    @Injectable()
    class SecondGuard implements CanActivate {
      canActivate(context: ExecutionContext): boolean {
        order.push('second');
        return context.getRequest().headers.get('x-pass') === '1';
      }
    }

    @Controller('/stacked-guards')
    class GuardedController {
      @Get()
      handle() {
        return { ok: true };
      }
    }

    @Module({
      providers: [
        FirstGuard,
        SecondGuard,
        { provide: APP_GUARD, useExisting: FirstGuard },
        { provide: APP_GUARD, useExisting: SecondGuard },
      ],
      controllers: [GuardedController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const blocked = await hono.request('/stacked-guards');
    expect(blocked.status).toBe(403);
    expect(order).toEqual(['first', 'second']);

    order.length = 0;
    const allowed = await hono.request('/stacked-guards', {
      headers: { 'x-pass': '1' },
    });
    expect(allowed.status).toBe(200);
    expect(order).toEqual(['first', 'second']);
  });
});

// =============================================================================
// applyDecorators
// =============================================================================

describe('applyDecorators', () => {
  it('should compose guard + metadata into a custom decorator', async () => {
    const ROLES_KEY = 'roles';

    // Custom composite decorator
    const Roles = (...roles: string[]) =>
      applyDecorators(SetMetadata(ROLES_KEY, roles), UseGuards(RolesGuard));

    @Injectable()
    class RolesGuard implements CanActivate {
      constructor(private reflector: Reflector) {}
      canActivate(ctx: ExecutionContext): boolean {
        const required = this.reflector.get<string[]>(ROLES_KEY, ctx);
        if (!required) return true;
        return ctx.getRequest().headers.get('x-role') === required[0];
      }
    }

    @Controller('/role-test')
    class RoleController {
      @Roles('admin')
      @Get()
      handle() {
        return { ok: true };
      }
    }

    @Module({
      providers: [RolesGuard, Reflector],
      controllers: [RoleController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const denied = await hono.request('/role-test');
    expect(denied.status).toBe(403);

    const allowed = await hono.request('/role-test', { headers: { 'x-role': 'admin' } });
    expect(allowed.status).toBe(200);
  });

  it('should apply multiple method decorators', async () => {
    const AuthorizedGet = (path = '') =>
      applyDecorators(Get(path), HttpCode(200), Header('x-auth', 'ok'));

    @Controller('/apply-test')
    class ApplyController {
      @AuthorizedGet('/data')
      handle() {
        return { data: true };
      }
    }

    @Module({ controllers: [ApplyController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/apply-test/data');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-auth')).toBe('ok');
  });
});

// =============================================================================
// @Global
// =============================================================================

describe('@Global', () => {
  it('should make module providers available without explicit import', async () => {
    @Injectable()
    class SharedService {
      getValue() {
        return 'from-global';
      }
    }

    @Global()
    @Module({ providers: [SharedService], exports: [SharedService] })
    class SharedModule {}

    @Injectable()
    class FeatureService {
      constructor(private shared: SharedService) {}
      getData() {
        return this.shared.getValue();
      }
    }

    @Controller('/feature')
    class FeatureController {
      constructor(private svc: FeatureService) {}
      @Get()
      handle() {
        return { value: this.svc.getData() };
      }
    }

    @Module({ providers: [FeatureService], controllers: [FeatureController] })
    class FeatureModule {}

    @Module({ imports: [SharedModule, FeatureModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/feature');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: 'from-global' });
  });

  it('should support isGlobal option in @Module decorator', async () => {
    @Injectable()
    class ConfigService {
      get(key: string) {
        return `value-${key}`;
      }
    }

    @Module({ providers: [ConfigService], exports: [ConfigService], isGlobal: true })
    class ConfigModule {}

    @Controller('/config-test')
    class ConfigController {
      constructor(private config: ConfigService) {}
      @Get()
      handle() {
        return { val: this.config.get('db') };
      }
    }

    @Module({ imports: [ConfigModule], controllers: [ConfigController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/config-test');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ val: 'value-db' });
  });

  it('should allow multiple global modules', async () => {
    @Injectable()
    class AuthService {
      getUser() {
        return 'alice';
      }
    }

    @Injectable()
    class LogService {
      log(msg: string) {
        return `[log] ${msg}`;
      }
    }

    @Global()
    @Module({ providers: [AuthService], exports: [AuthService] })
    class AuthModule {}

    @Global()
    @Module({ providers: [LogService], exports: [LogService] })
    class LogModule {}

    @Controller('/multi-global')
    class MultiController {
      constructor(
        private auth: AuthService,
        private log: LogService,
      ) {}
      @Get()
      handle() {
        return { user: this.auth.getUser(), logged: this.log.log('ok') };
      }
    }

    @Module({ controllers: [MultiController] })
    class FeatureModule {}

    @Module({ imports: [AuthModule, LogModule, FeatureModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/multi-global');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: 'alice', logged: '[log] ok' });
  });
});

// =============================================================================
// MiddlewareConsumer (NestModule.configure)
// =============================================================================

describe('MiddlewareConsumer', () => {
  it('should apply middleware to all routes via forRoutes("*")', async () => {
    const log: string[] = [];

    @Injectable()
    class TraceMiddleware {
      use(c: import('hono').Context, next: import('hono').Next) {
        log.push(`${c.req.method} ${c.req.path}`);
        return next();
      }
    }

    @Controller('/traced')
    class TracedController {
      @Get()
      handle() {
        return { ok: true };
      }
    }

    @Module({ providers: [TraceMiddleware], controllers: [TracedController] })
    class AppModule implements NestModule {
      configure(consumer: MiddlewareConsumer) {
        consumer.apply(TraceMiddleware).forRoutes('*');
      }
    }

    const app = await VelaFactory.create(AppModule);
    await app.getHonoApp().request('/traced');
    expect(log).toEqual(['GET /traced']);
  });

  it('should apply middleware only to matching prefix via forRoutes(string)', async () => {
    const log: string[] = [];

    @Injectable()
    class PrefixMiddleware {
      use(c: import('hono').Context, next: import('hono').Next) {
        log.push(c.req.path);
        return next();
      }
    }

    @Controller('/admin')
    class AdminController {
      @Get()
      handle() { return { admin: true }; }
    }

    @Controller('/public')
    class PublicController {
      @Get()
      handle() { return { public: true }; }
    }

    @Module({ providers: [PrefixMiddleware], controllers: [AdminController, PublicController] })
    class AppModule implements NestModule {
      configure(consumer: MiddlewareConsumer) {
        consumer.apply(PrefixMiddleware).forRoutes('/admin');
      }
    }

    const app = await VelaFactory.create(AppModule);
    await app.getHonoApp().request('/admin');
    await app.getHonoApp().request('/public');
    expect(log).toEqual(['/admin']);
  });

  it('should apply middleware to controller routes via forRoutes(Controller)', async () => {
    const log: string[] = [];

    @Injectable()
    class CtrlMiddleware {
      use(c: import('hono').Context, next: import('hono').Next) {
        log.push(c.req.path);
        return next();
      }
    }

    @Controller('/ctrl-mw')
    class TargetController {
      @Get()
      handle() { return { ok: true }; }
    }

    @Controller('/other')
    class OtherController {
      @Get()
      handle() { return { ok: true }; }
    }

    @Module({ providers: [CtrlMiddleware], controllers: [TargetController, OtherController] })
    class AppModule implements NestModule {
      configure(consumer: MiddlewareConsumer) {
        consumer.apply(CtrlMiddleware).forRoutes(TargetController);
      }
    }

    const app = await VelaFactory.create(AppModule);
    await app.getHonoApp().request('/ctrl-mw');
    await app.getHonoApp().request('/other');
    expect(log).toEqual(['/ctrl-mw']);
  });

  it('should exclude specific paths from middleware', async () => {
    const log: string[] = [];

    @Injectable()
    class LogMiddleware {
      use(c: import('hono').Context, next: import('hono').Next) {
        log.push(c.req.path);
        return next();
      }
    }

    @Controller('/api')
    class ApiController {
      @Get('/data')
      data() { return { data: true }; }

      @Get('/health')
      health() { return { ok: true }; }
    }

    @Module({ providers: [LogMiddleware], controllers: [ApiController] })
    class AppModule implements NestModule {
      configure(consumer: MiddlewareConsumer) {
        consumer.apply(LogMiddleware).exclude('/api/health').forRoutes('/api');
      }
    }

    const app = await VelaFactory.create(AppModule);
    await app.getHonoApp().request('/api/data');
    await app.getHonoApp().request('/api/health');
    expect(log).toEqual(['/api/data']);
  });

  it('should apply middleware only for a specific HTTP method', async () => {
    const log: string[] = [];

    @Injectable()
    class PostOnlyMiddleware {
      use(c: import('hono').Context, next: import('hono').Next) {
        log.push(`${c.req.method}`);
        return next();
      }
    }

    @Controller('/methods')
    class MethodsController {
      @Get()
      get() { return { method: 'GET' }; }

      @Post()
      post() { return { method: 'POST' }; }
    }

    @Module({ providers: [PostOnlyMiddleware], controllers: [MethodsController] })
    class AppModule implements NestModule {
      configure(consumer: MiddlewareConsumer) {
        consumer
          .apply(PostOnlyMiddleware)
          .forRoutes({ path: '/methods', method: RequestMethod.POST });
      }
    }

    const app = await VelaFactory.create(AppModule);
    await app.getHonoApp().request('/methods');
    await app.getHonoApp().request('/methods', { method: 'POST' });
    expect(log).toEqual(['POST']);
  });

  it('should chain multiple middleware in apply()', async () => {
    const order: string[] = [];

    @Injectable()
    class FirstMiddleware {
      use(c: import('hono').Context, next: import('hono').Next) {
        order.push('first');
        return next();
      }
    }

    @Injectable()
    class SecondMiddleware {
      use(c: import('hono').Context, next: import('hono').Next) {
        order.push('second');
        return next();
      }
    }

    @Controller('/chained')
    class ChainedController {
      @Get()
      handle() { return { ok: true }; }
    }

    @Module({ providers: [FirstMiddleware, SecondMiddleware], controllers: [ChainedController] })
    class AppModule implements NestModule {
      configure(consumer: MiddlewareConsumer) {
        consumer.apply(FirstMiddleware, SecondMiddleware).forRoutes('*');
      }
    }

    const app = await VelaFactory.create(AppModule);
    await app.getHonoApp().request('/chained');
    expect(order).toEqual(['first', 'second']);
  });
});

// =============================================================================
// ModuleRef
// =============================================================================

describe('ModuleRef', () => {
  it('should resolve a registered singleton via get()', async () => {
    @Injectable()
    class GreetService {
      greet() { return 'hello'; }
    }

    @Controller('/greet')
    class GreetController {
      constructor(private ref: ModuleRef) {}
      @Get()
      handle() {
        const svc = this.ref.get(GreetService);
        return { msg: svc.greet() };
      }
    }

    @Module({ providers: [GreetService], controllers: [GreetController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/greet');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ msg: 'hello' });
  });

  it('should resolve using InjectionToken via get()', async () => {
    const MY_TOKEN = new InjectionToken<string>('MY_TOKEN');

    @Controller('/token')
    class TokenController {
      constructor(private ref: ModuleRef) {}
      @Get()
      handle() {
        return { val: this.ref.get(MY_TOKEN) };
      }
    }

    @Module({
      providers: [{ provide: MY_TOKEN, useValue: 'token-value' }],
      controllers: [TokenController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/token');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ val: 'token-value' });
  });

  it('should create a fresh instance outside DI cache via create()', async () => {
    @Injectable()
    class CounterService {
      private count = 0;
      increment() { return ++this.count; }
    }

    @Controller('/counter')
    class CounterController {
      constructor(private ref: ModuleRef) {}
      @Get()
      handle() {
        const a = this.ref.create(CounterService);
        const b = this.ref.create(CounterService);
        return { a: a.increment(), b: b.increment(), same: a === b };
      }
    }

    @Module({ providers: [CounterService], controllers: [CounterController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/counter');
    expect(res.status).toBe(200);
    const body = await res.json() as { a: number; b: number; same: boolean };
    expect(body.a).toBe(1);
    expect(body.b).toBe(1); // fresh instance, starts at 0
    expect(body.same).toBe(false);
  });
});

// =============================================================================
// mixin()
// =============================================================================

describe('mixin()', () => {
  it('should create a reusable guard mixin parameterized by role', async () => {
    function RoleGuardMixin(role: string) {
      class MixedGuard implements CanActivate {
        canActivate(ctx: ExecutionContext): boolean {
          return ctx.getRequest().headers.get('x-role') === role;
        }
      }
      return mixin(MixedGuard);
    }

    const AdminGuard = RoleGuardMixin('admin');
    const UserGuard = RoleGuardMixin('user');

    @Controller('/mixin-test')
    class MixinController {
      @Get('/admin')
      @UseGuards(AdminGuard)
      adminOnly() { return { role: 'admin' }; }

      @Get('/user')
      @UseGuards(UserGuard)
      userOnly() { return { role: 'user' }; }
    }

    @Module({ controllers: [MixinController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const denied = await hono.request('/mixin-test/admin');
    expect(denied.status).toBe(403);

    const allowed = await hono.request('/mixin-test/admin', { headers: { 'x-role': 'admin' } });
    expect(allowed.status).toBe(200);

    const userAllowed = await hono.request('/mixin-test/user', { headers: { 'x-role': 'user' } });
    expect(userAllowed.status).toBe(200);

    const userDenied = await hono.request('/mixin-test/user', { headers: { 'x-role': 'admin' } });
    expect(userDenied.status).toBe(403);
  });
});

// =============================================================================
// ConfigModule.forRoot({ isGlobal: true })
// =============================================================================

describe('ConfigModule isGlobal', () => {
  it('should make ConfigService available without explicit import', async () => {
    @Injectable()
    class AppService {
      constructor(private config: ConfigService) {}
      getVal() { return this.config.get('APP_NAME'); }
    }

    @Controller('/cfg-global')
    class CfgController {
      constructor(private svc: AppService) {}
      @Get()
      handle() { return { val: this.svc.getVal() }; }
    }

    @Module({ providers: [AppService], controllers: [CfgController] })
    class FeatureModule {}

    @Module({ imports: [ConfigModule.forRoot({ config: { APP_NAME: 'vela' }, isGlobal: true }), FeatureModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/cfg-global');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ val: 'vela' });
  });
});

// =============================================================================
// Module-level Use* decorators
// =============================================================================

describe('Module-level Use* decorators', () => {
  it('@UseGuards() on module applies guard to all controllers in module', async () => {
    @Injectable()
    class AuthGuard implements CanActivate {
      canActivate(ctx: ExecutionContext): boolean {
        return ctx.getRequest().headers.get('x-auth') === 'secret';
      }
    }

    @Controller('/mod-guard-a')
    class ControllerA {
      @Get()
      handle() { return { from: 'a' }; }
    }

    @Controller('/mod-guard-b')
    class ControllerB {
      @Get()
      handle() { return { from: 'b' }; }
    }

    @UseGuards(AuthGuard)
    @Module({ providers: [AuthGuard], controllers: [ControllerA, ControllerB] })
    class FeatureModule {}

    @Module({ imports: [FeatureModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    expect((await hono.request('/mod-guard-a')).status).toBe(403);
    expect((await hono.request('/mod-guard-b')).status).toBe(403);

    const ok1 = await hono.request('/mod-guard-a', { headers: { 'x-auth': 'secret' } });
    expect(ok1.status).toBe(200);
    expect(await ok1.json()).toEqual({ from: 'a' });

    const ok2 = await hono.request('/mod-guard-b', { headers: { 'x-auth': 'secret' } });
    expect(ok2.status).toBe(200);
  });

  it('@UseInterceptors() on module wraps all controllers', async () => {
    @Injectable()
    class WrapInterceptor implements NestInterceptor {
      async intercept(_ctx: ExecutionContext, next: CallHandler) {
        const result = await next.handle();
        return { wrapped: true, data: result };
      }
    }

    @Controller('/mod-intercept')
    class InterceptedController {
      @Get()
      handle() { return { raw: true }; }
    }

    @UseInterceptors(WrapInterceptor)
    @Module({ providers: [WrapInterceptor], controllers: [InterceptedController] })
    class FeatureModule {}

    @Module({ imports: [FeatureModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/mod-intercept');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ wrapped: true, data: { raw: true } });
  });

  it('@UsePipes() on module transforms params for all controllers', async () => {
    @Injectable()
    class UpperCasePipe implements PipeTransform {
      transform(value: unknown, _meta: ArgumentMetadata): unknown {
        return typeof value === 'string' ? value.toUpperCase() : value;
      }
    }

    @Controller('/mod-pipe')
    class PipedController {
      @Get('/:name')
      handle(@Param('name') name: string) { return { name }; }
    }

    @UsePipes(UpperCasePipe)
    @Module({ providers: [UpperCasePipe], controllers: [PipedController] })
    class FeatureModule {}

    @Module({ imports: [FeatureModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/mod-pipe/hello');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'HELLO' });
  });
});

describe('switchToHttp() and @Res() decorator', () => {
  beforeEach(() => MetadataRegistry.clear());

  it('switchToHttp().getRequest() returns the raw Request in a guard', async () => {
    let capturedUrl: string | undefined;

    @Injectable()
    class InspectGuard implements CanActivate {
      canActivate(ctx: ExecutionContext): boolean {
        const http: HttpArgumentsHost = ctx.switchToHttp();
        capturedUrl = http.getRequest<Request>().url;
        return true;
      }
    }

    @Controller('/switch-http')
    class SwitchController {
      @UseGuards(InspectGuard)
      @Get()
      handle() { return { ok: true }; }
    }

    @Module({ providers: [InspectGuard], controllers: [SwitchController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/switch-http');
    expect(res.status).toBe(200);
    expect(capturedUrl).toContain('/switch-http');
  });

  it('switchToHttp().getResponse() returns the Hono Context', async () => {
    let capturedResponse: unknown;

    @Injectable()
    class InspectInterceptor implements NestInterceptor {
      async intercept(ctx: ExecutionContext, next: CallHandler) {
        const http: HttpArgumentsHost = ctx.switchToHttp();
        capturedResponse = http.getResponse();
        return next.handle();
      }
    }

    @Controller('/switch-res')
    class SwitchResController {
      @UseInterceptors(InspectInterceptor)
      @Get()
      handle() { return { ok: true }; }
    }

    @Module({ providers: [InspectInterceptor], controllers: [SwitchResController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/switch-res');
    expect(res.status).toBe(200);
    expect(capturedResponse).toBeDefined();
    // Hono Context has req and res properties
    expect((capturedResponse as any).req).toBeDefined();
  });

  it('@Res() injects the Hono Context and allows manual response', async () => {
    @Controller('/res-manual')
    class ManualResController {
      @Get()
      handle(@Res() ctx: any) {
        return ctx.json({ manual: true }, 201);
      }
    }

    @Module({ controllers: [ManualResController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/res-manual');
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ manual: true });
  });
});

describe('Inline param-level pipes', () => {
  beforeEach(() => MetadataRegistry.clear());

  it('@Param("id", ParseIntPipe) parses route param to number', async () => {
    @Controller('/users')
    class UsersController {
      @Get('/:id')
      findOne(@Param('id', ParseIntPipe) id: number) {
        return { id, type: typeof id };
      }
    }

    @Module({ controllers: [UsersController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/users/42');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 42, type: 'number' });
  });

  it('inline ParseIntPipe returns 400 for non-numeric input', async () => {
    @Controller('/items')
    class ItemsController {
      @Get('/:id')
      findOne(@Param('id', ParseIntPipe) id: number) {
        return { id };
      }
    }

    @Module({ controllers: [ItemsController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/items/not-a-number');
    expect(res.status).toBe(400);
  });

  it('@Query("page", new DefaultValuePipe(1), ParseIntPipe) parses query with fallback', async () => {
    @Controller('/posts')
    class PostsController {
      @Get()
      list(@Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number) {
        return { page };
      }
    }

    @Module({ controllers: [PostsController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);

    const withParam = await app.getHonoApp().request('/posts?page=3');
    expect(await withParam.json()).toEqual({ page: 3 });

    // DefaultValuePipe kicks in when query param is absent
    const withoutParam = await app.getHonoApp().request('/posts');
    expect(await withoutParam.json()).toEqual({ page: 1 });
  });

  it('multiple inline pipes chain in order: first to last', async () => {
    class DoubleIt implements PipeTransform<number, number> {
      transform(value: number): number { return value * 2; }
    }
    class AddTen implements PipeTransform<number, number> {
      transform(value: number): number { return value + 10; }
    }

    @Controller('/calc')
    class CalcController {
      @Get('/:n')
      handle(@Param('n', ParseIntPipe, new DoubleIt(), new AddTen()) n: number) {
        return { n };
      }
    }

    @Module({ controllers: [CalcController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    // 5 → ParseInt(5) → 5*2=10 → 10+10=20
    const res = await app.getHonoApp().request('/calc/5');
    expect(await res.json()).toEqual({ n: 20 });
  });
});

describe('Lifecycle hooks', () => {
  beforeEach(() => MetadataRegistry.clear());

  it('onModuleInit() is called before the app is ready', async () => {
    const calls: string[] = [];

    @Injectable()
    class DbService implements OnModuleInit {
      async onModuleInit() {
        calls.push('db:init');
      }
    }

    @Module({ providers: [DbService] })
    class AppModule {}

    await VelaFactory.create(AppModule);
    expect(calls).toEqual(['db:init']);
  });

  it('onApplicationBootstrap() is called after onModuleInit()', async () => {
    const calls: string[] = [];

    @Injectable()
    class StartupService implements OnModuleInit, OnApplicationBootstrap {
      async onModuleInit() { calls.push('init'); }
      async onApplicationBootstrap() { calls.push('bootstrap'); }
    }

    @Module({ providers: [StartupService] })
    class AppModule {}

    await VelaFactory.create(AppModule);
    expect(calls).toEqual(['init', 'bootstrap']);
  });

  it('all providers with hooks are called, in registration order', async () => {
    const calls: string[] = [];

    @Injectable()
    class ServiceA implements OnModuleInit {
      onModuleInit() { calls.push('A'); }
    }
    @Injectable()
    class ServiceB implements OnModuleInit {
      onModuleInit() { calls.push('B'); }
    }

    @Module({ providers: [ServiceA, ServiceB] })
    class AppModule {}

    await VelaFactory.create(AppModule);
    expect(calls).toEqual(['A', 'B']);
  });

  it('app.close() calls onModuleDestroy() on each provider', async () => {
    const calls: string[] = [];

    @Injectable()
    class CleanupService implements OnModuleDestroy {
      onModuleDestroy() { calls.push('destroyed'); }
    }

    @Module({ providers: [CleanupService] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await app.close();
    expect(calls).toEqual(['destroyed']);
  });
});

describe('APP_FILTER global exception filter', () => {
  beforeEach(() => MetadataRegistry.clear());

  it('{ provide: APP_FILTER, useClass: Filter } catches exceptions globally', async () => {
    @Injectable()
    @Catch()
    class GlobalFilter implements ExceptionFilter {
      catch(_err: unknown, _host: ExecutionContext) {
        return { caught: true, global: true };
      }
    }

    @Controller('/filter-test')
    class FilterController {
      @Get()
      handle() { throw new Error('boom'); }
    }

    @Module({
      providers: [
        GlobalFilter,
        { provide: APP_FILTER, useExisting: GlobalFilter },
      ],
      controllers: [FilterController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/filter-test');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ caught: true, global: true });
  });

  it('APP_FILTER with @Catch(SpecificError) only catches matching exceptions', async () => {
    class DomainError extends Error {}

    @Injectable()
    @Catch(DomainError)
    class DomainFilter implements ExceptionFilter {
      catch(_err: unknown, _host: ExecutionContext) {
        return { domain: true };
      }
    }

    @Controller('/domain-filter')
    class DomainController {
      @Get('/caught')
      throwDomain() { throw new DomainError('domain'); }

      @Get('/uncaught')
      throwOther() { throw new Error('generic'); }
    }

    @Module({
      providers: [
        DomainFilter,
        { provide: APP_FILTER, useExisting: DomainFilter },
      ],
      controllers: [DomainController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const caught = await app.getHonoApp().request('/domain-filter/caught');
    expect(await caught.json()).toEqual({ domain: true });

    // Generic Error not caught by DomainFilter → falls through to default 500
    const uncaught = await app.getHonoApp().request('/domain-filter/uncaught');
    expect(uncaught.status).toBe(500);
  });
});

// =============================================================================
// Shutdown lifecycle hooks
// =============================================================================

describe('Shutdown lifecycle hooks', () => {
  it('beforeApplicationShutdown and onApplicationShutdown are called on close()', async () => {
    const log: string[] = [];

    @Injectable()
    class ServiceA implements BeforeApplicationShutdown, OnApplicationShutdown {
      beforeApplicationShutdown(signal?: string) { log.push(`A:before:${signal ?? 'none'}`); }
      onApplicationShutdown(signal?: string) { log.push(`A:shutdown:${signal ?? 'none'}`); }
    }

    @Injectable()
    class ServiceB implements BeforeApplicationShutdown, OnApplicationShutdown {
      beforeApplicationShutdown(signal?: string) { log.push(`B:before:${signal ?? 'none'}`); }
      onApplicationShutdown(signal?: string) { log.push(`B:shutdown:${signal ?? 'none'}`); }
    }

    @Controller('/shutdown-test')
    class ShutdownController {
      constructor(private a: ServiceA, private b: ServiceB) {}
      @Get() handle() { return { ok: true }; }
    }

    @Module({ providers: [ServiceA, ServiceB], controllers: [ShutdownController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await app.close('SIGTERM');

    expect(log).toContain('A:before:SIGTERM');
    expect(log).toContain('B:before:SIGTERM');
    expect(log).toContain('A:shutdown:SIGTERM');
    expect(log).toContain('B:shutdown:SIGTERM');

    // beforeApplicationShutdown phase precedes onApplicationShutdown phase
    const firstBefore = Math.min(log.indexOf('A:before:SIGTERM'), log.indexOf('B:before:SIGTERM'));
    const firstShutdown = Math.min(log.indexOf('A:shutdown:SIGTERM'), log.indexOf('B:shutdown:SIGTERM'));
    expect(firstBefore).toBeLessThan(firstShutdown);
  });

  it('close() with no signal passes undefined to hooks', async () => {
    let capturedSignal: string | undefined = 'NOT_SET';

    @Injectable()
    class WatchService implements OnApplicationShutdown {
      onApplicationShutdown(signal?: string) { capturedSignal = signal; }
    }

    @Controller('/noop-shutdown')
    class NoopController {
      constructor(private w: WatchService) {}
      @Get() handle() { return {}; }
    }

    @Module({ providers: [WatchService], controllers: [NoopController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await app.close();
    expect(capturedSignal).toBeUndefined();
  });

  it('hooks run in reverse instantiation order (LIFO)', async () => {
    const log: string[] = [];

    @Injectable()
    class FirstService implements OnApplicationShutdown {
      onApplicationShutdown() { log.push('first'); }
    }

    @Injectable()
    class LastService implements OnApplicationShutdown {
      onApplicationShutdown() { log.push('last'); }
    }

    @Controller('/lifo')
    class LifoController {
      constructor(private f: FirstService, private l: LastService) {}
      @Get() handle() { return {}; }
    }

    @Module({ providers: [FirstService, LastService], controllers: [LifoController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await app.close();

    // LIFO — last instantiated shuts down first
    expect(log.indexOf('last')).toBeLessThan(log.indexOf('first'));
  });
});

// =============================================================================
// APP_MIDDLEWARE global middleware token
// =============================================================================

describe('APP_MIDDLEWARE global middleware token', () => {
  it('applies middleware to all routes via token', async () => {
    @Injectable()
    class RequestIdMiddleware {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      use(c: any, next: () => Promise<void>) {
        c.header('x-request-id', 'mw-injected');
        return next();
      }
    }

    @Controller('/mw-global')
    class MwController {
      @Get() handle() { return { ok: true }; }
    }

    @Controller('/mw-global-2')
    class MwController2 {
      @Get() handle() { return { ok: 2 }; }
    }

    @Module({
      providers: [
        RequestIdMiddleware,
        { provide: APP_MIDDLEWARE, useExisting: RequestIdMiddleware },
      ],
      controllers: [MwController, MwController2],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res1 = await hono.request('/mw-global');
    expect(res1.status).toBe(200);
    expect(res1.headers.get('x-request-id')).toBe('mw-injected');

    const res2 = await hono.request('/mw-global-2');
    expect(res2.status).toBe(200);
    expect(res2.headers.get('x-request-id')).toBe('mw-injected');
  });

  it('multiple APP_MIDDLEWARE providers run in order', async () => {
    const log: string[] = [];

    @Injectable()
    class MiddlewareA {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      use(_c: any, next: () => Promise<void>) { log.push('A'); return next(); }
    }

    @Injectable()
    class MiddlewareB {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      use(_c: any, next: () => Promise<void>) { log.push('B'); return next(); }
    }

    @Controller('/mw-order')
    class OrderController {
      @Get() handle() { return { ok: true }; }
    }

    @Module({
      providers: [
        MiddlewareA,
        MiddlewareB,
        { provide: APP_MIDDLEWARE, useExisting: MiddlewareA },
        { provide: APP_MIDDLEWARE, useExisting: MiddlewareB },
      ],
      controllers: [OrderController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await app.getHonoApp().request('/mw-order');

    expect(log).toEqual(['A', 'B']);
  });
});

// =============================================================================
// More built-in pipes
// =============================================================================

describe('More built-in pipes', () => {
  it('ParseFloatPipe converts string to float', async () => {
    @Controller('/float')
    class FloatController {
      @Get()
      handle(@Query('v', ParseFloatPipe) v: number) { return { v }; }
    }

    @Module({ controllers: [FloatController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/float?v=3.14');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ v: 3.14 });
  });

  it('ParseFloatPipe throws 400 for non-numeric string', async () => {
    @Controller('/float-err')
    class FloatErrController {
      @Get()
      handle(@Query('v', ParseFloatPipe) v: number) { return { v }; }
    }

    @Module({ controllers: [FloatErrController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect((await app.getHonoApp().request('/float-err?v=abc')).status).toBe(400);
  });

  it('ParseBoolPipe converts "true" and "false" strings', async () => {
    @Controller('/bool')
    class BoolController {
      @Get()
      handle(@Query('v', ParseBoolPipe) v: boolean) { return { v }; }
    }

    @Module({ controllers: [BoolController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(await (await app.getHonoApp().request('/bool?v=true')).json()).toEqual({ v: true });
    expect(await (await app.getHonoApp().request('/bool?v=false')).json()).toEqual({ v: false });
  });

  it('ParseBoolPipe throws 400 for non-boolean string', async () => {
    @Controller('/bool-err')
    class BoolErrController {
      @Get()
      handle(@Query('v', ParseBoolPipe) v: boolean) { return { v }; }
    }

    @Module({ controllers: [BoolErrController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect((await app.getHonoApp().request('/bool-err?v=yes')).status).toBe(400);
  });

  it('ParseEnumPipe validates against an enum', async () => {
    enum Direction { Up = 'up', Down = 'down' }

    @Controller('/enum')
    class EnumController {
      @Get()
      handle(@Query('dir', new ParseEnumPipe(Direction)) dir: Direction) { return { dir }; }
    }

    @Module({ controllers: [EnumController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(await (await app.getHonoApp().request('/enum?dir=up')).json()).toEqual({ dir: 'up' });
    expect((await app.getHonoApp().request('/enum?dir=left')).status).toBe(400);
  });

  it('ParseArrayPipe splits comma-delimited query string', async () => {
    @Controller('/arr')
    class ArrController {
      @Get()
      handle(@Query('ids', new ParseArrayPipe()) ids: string[]) { return { ids }; }
    }

    @Module({ controllers: [ArrController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(await (await app.getHonoApp().request('/arr?ids=a,b,c')).json()).toEqual({ ids: ['a', 'b', 'c'] });
  });

  it('ParseArrayPipe with custom separator', async () => {
    @Controller('/arr-sep')
    class ArrSepController {
      @Get()
      handle(@Query('ids', new ParseArrayPipe({ separator: '|' })) ids: string[]) { return { ids }; }
    }

    @Module({ controllers: [ArrSepController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(await (await app.getHonoApp().request('/arr-sep?ids=a|b|c')).json()).toEqual({ ids: ['a', 'b', 'c'] });
  });

  it('ParseArrayPipe optional returns empty array when absent', async () => {
    @Controller('/arr-opt')
    class ArrOptController {
      @Get()
      handle(@Query('ids', new ParseArrayPipe({ optional: true })) ids: string[]) { return { ids }; }
    }

    @Module({ controllers: [ArrOptController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(await (await app.getHonoApp().request('/arr-opt')).json()).toEqual({ ids: [] });
  });
});

// =============================================================================
// createParamDecorator
// =============================================================================

describe('createParamDecorator', () => {
  it('extracts custom value from request context', async () => {
    const UserAgent = createParamDecorator(
      (_data: unknown, ctx: ExecutionContext) => ctx.getRequest().headers.get('user-agent') ?? 'unknown',
    );

    @Controller('/custom-param')
    class CustomController {
      @Get()
      handle(@UserAgent() ua: string) { return { ua }; }
    }

    @Module({ controllers: [CustomController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/custom-param', {
      headers: { 'user-agent': 'test-bot/1.0' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ua: 'test-bot/1.0' });
  });

  it('passes data argument to the factory', async () => {
    const CustomHeader = createParamDecorator(
      (data: string, ctx: ExecutionContext) => ctx.getRequest().headers.get(data),
    );

    @Controller('/custom-header')
    class HeaderController {
      @Get()
      handle(@CustomHeader('x-tenant') tenant: string) { return { tenant }; }
    }

    @Module({ controllers: [HeaderController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/custom-header', {
      headers: { 'x-tenant': 'acme' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenant: 'acme' });
  });

  it('works with inline pipe applied after the factory', async () => {
    const RawAge = createParamDecorator(
      (_data: unknown, ctx: ExecutionContext) => ctx.getRequest().headers.get('x-age'),
    );

    @Controller('/age-pipe')
    class AgePipeController {
      @Get()
      handle(@RawAge(undefined, ParseIntPipe) age: number) { return { age }; }
    }

    @Module({ controllers: [AgePipeController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/age-pipe', { headers: { 'x-age': '25' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ age: 25 });
  });
});

// =============================================================================
// Route versioning (@Version)
// =============================================================================

describe('Route versioning (@Version)', () => {
  it('@Controller({ version }) adds /v{n} prefix to all routes', async () => {
    @Controller({ prefix: '/things', version: 1 })
    class ThingsV1Controller {
      @Get() list() { return { version: 1 }; }
    }

    @Module({ controllers: [ThingsV1Controller] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect((await app.getHonoApp().request('/v1/things')).status).toBe(200);
    expect(await (await app.getHonoApp().request('/v1/things')).json()).toEqual({ version: 1 });
    expect((await app.getHonoApp().request('/things')).status).toBe(404);
  });

  it('@Controller({ version: [1,2] }) registers route at multiple versions', async () => {
    @Controller({ prefix: '/multi', version: [1, 2] })
    class MultiController {
      @Get() handle() { return { ok: true }; }
    }

    @Module({ controllers: [MultiController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect((await app.getHonoApp().request('/v1/multi')).status).toBe(200);
    expect((await app.getHonoApp().request('/v2/multi')).status).toBe(200);
    expect((await app.getHonoApp().request('/multi')).status).toBe(404);
  });

  it('@Version() on method overrides controller version', async () => {
    @Controller({ prefix: '/docs', version: 1 })
    class DocController {
      @Get() v1() { return { v: 1 }; }

      @Version(2)
      @Get('/new')
      v2() { return { v: 2 }; }
    }

    @Module({ controllers: [DocController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    expect(await (await hono.request('/v1/docs')).json()).toEqual({ v: 1 });
    expect(await (await hono.request('/v2/docs/new')).json()).toEqual({ v: 2 });
    expect((await hono.request('/v1/docs/new')).status).toBe(404);
  });
});

// =============================================================================
// HttpException hierarchy
// =============================================================================

describe('HttpException hierarchy', () => {
  it('each subclass maps to its HTTP status code', async () => {
    @Controller('/http-exc')
    class ExcController {
      @Get('/404') notFound()      { throw new NotFoundException('not found'); }
      @Get('/400') badReq()        { throw new BadRequestException('bad input'); }
      @Get('/401') unauth()        { throw new UnauthorizedException(); }
      @Get('/403') forbidden()     { throw new ForbiddenException(); }
      @Get('/409') conflict()      { throw new ConflictException('duplicate'); }
    }

    @Module({ controllers: [ExcController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    expect((await hono.request('/http-exc/404')).status).toBe(404);
    expect((await hono.request('/http-exc/400')).status).toBe(400);
    expect((await hono.request('/http-exc/401')).status).toBe(401);
    expect((await hono.request('/http-exc/403')).status).toBe(403);
    expect((await hono.request('/http-exc/409')).status).toBe(409);
  });

  it('getResponse() body is serialized as JSON', async () => {
    @Controller('/exc-body')
    class BodyController {
      @Get() handle() { throw new NotFoundException('item missing'); }
    }

    @Module({ controllers: [BodyController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/exc-body');
    expect(res.status).toBe(404);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.statusCode).toBe(404);
    expect(body.message).toBe('item missing');
  });

  it('@Catch(HttpException) filter intercepts all HTTP exceptions', async () => {
    @Injectable()
    @Catch(HttpException)
    class HttpExcFilter implements ExceptionFilter {
      catch(err: HttpException, _host: ExecutionContext) {
        return { caught: true, status: err.getStatus() };
      }
    }

    @Controller('/exc-filter')
    class FilteredController {
      @Get('/404') notFound() { throw new NotFoundException(); }
      @Get('/403') forbidden() { throw new ForbiddenException(); }
    }

    @Module({
      providers: [HttpExcFilter, { provide: APP_FILTER, useExisting: HttpExcFilter }],
      controllers: [FilteredController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const r404 = await hono.request('/exc-filter/404');
    expect(await r404.json()).toEqual({ caught: true, status: 404 });

    const r403 = await hono.request('/exc-filter/403');
    expect(await r403.json()).toEqual({ caught: true, status: 403 });
  });

  it('custom HttpException with structured response object', async () => {
    @Controller('/exc-custom')
    class CustomController {
      @Get()
      handle() {
        throw new HttpException('Validation Failed', 422, {
          statusCode: 422,
          message: 'Validation Failed',
          errors: ['field required'],
        });
      }
    }

    @Module({ controllers: [CustomController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/exc-custom');
    expect(res.status).toBe(422);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.errors).toEqual(['field required']);
  });
});

// =============================================================================
// ParseUUIDPipe
// =============================================================================

describe('ParseUUIDPipe', () => {
  it('accepts a valid UUID and passes it through', async () => {
    @Controller('/uuid')
    class UuidController {
      @Get(':id')
      handle(@Param('id', ParseUUIDPipe) id: string) { return { id }; }
    }

    @Module({ controllers: [UuidController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const validUuid = '550e8400-e29b-41d4-a716-446655440000';
    const res = await app.getHonoApp().request(`/uuid/${validUuid}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: validUuid });
  });

  it('throws 400 for non-UUID string', async () => {
    @Controller('/uuid-err')
    class UuidErrController {
      @Get(':id')
      handle(@Param('id', ParseUUIDPipe) id: string) { return { id }; }
    }

    @Module({ controllers: [UuidErrController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect((await app.getHonoApp().request('/uuid-err/not-a-uuid')).status).toBe(400);
  });

  it('validates specific UUID v4', async () => {
    @Controller('/uuid-v4')
    class UuidV4Controller {
      @Get(':id')
      handle(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return { id }; }
    }

    @Module({ controllers: [UuidV4Controller] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const v4 = '550e8400-e29b-41d4-a716-446655440000';
    expect((await app.getHonoApp().request(`/uuid-v4/${v4}`)).status).toBe(200);

    const v3 = '550e8400-e29b-31d4-a716-446655440000';
    expect((await app.getHonoApp().request(`/uuid-v4/${v3}`)).status).toBe(400);
  });
});

// =============================================================================
// @Headers() param decorator
// =============================================================================

describe('@Headers() param decorator', () => {
  it('extracts a single header by name', async () => {
    @Controller('/hdrs')
    class HdrsController {
      @Get()
      handle(@Headers('x-tenant') tenant: string) { return { tenant }; }
    }

    @Module({ controllers: [HdrsController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/hdrs', { headers: { 'x-tenant': 'acme' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenant: 'acme' });
  });

  it('returns undefined for a missing header', async () => {
    @Controller('/hdrs-missing')
    class HdrsMissingController {
      @Get()
      handle(@Headers('x-missing') val: string | undefined) { return { val: val ?? null }; }
    }

    @Module({ controllers: [HdrsMissingController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/hdrs-missing');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ val: null });
  });
});

// =============================================================================
// @Req() raw request decorator
// =============================================================================

describe('@Req() raw request decorator', () => {
  it('injects the Hono Context and allows reading request headers', async () => {
    @Controller('/req-dec')
    class ReqController {
      @Get()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handle(@Req() ctx: any) {
        // @Req() returns the Hono Context (c); headers are at c.req.header()
        return { ua: ctx.req.header('user-agent') ?? 'unknown' };
      }
    }

    @Module({ controllers: [ReqController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/req-dec', { headers: { 'user-agent': 'vela-test/1.0' } });
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.ua).toBe('vela-test/1.0');
  });

  it('injects the Hono Context and allows reading request method', async () => {
    @Controller('/req-meta')
    class ReqMetaController {
      @Get()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handle(@Req() ctx: any) {
        // @Req() returns the Hono Context (c); method is at c.req.method
        return { method: ctx.req.method };
      }
    }

    @Module({ controllers: [ReqMetaController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/req-meta');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ method: 'GET' });
  });
});

// =============================================================================
// Serialize / SerializerInterceptor
// =============================================================================

describe('Serialize / SerializerInterceptor', () => {
  it('strips fields not in the DTO schema', async () => {
    const Schema = z.object({ id: z.number(), name: z.string() });
    class ResponseDto extends createZodDto(Schema) {}

    @Controller('/serialize')
    @UseInterceptors(SerializerInterceptor)
    class SerializeController {
      @Get()
      @Serialize(ResponseDto)
      handle() { return { id: 1, name: 'Alice', password: 'secret' }; }
    }

    @Module({ controllers: [SerializeController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/serialize');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: 1, name: 'Alice' });
    expect(body).not.toHaveProperty('password');
  });

  it('works with array responses', async () => {
    const Schema = z.object({ id: z.number(), name: z.string() });
    class ResponseDto extends createZodDto(Schema) {}

    @Controller('/serialize-arr')
    @UseInterceptors(SerializerInterceptor)
    class SerializeArrController {
      @Get()
      @Serialize(ResponseDto)
      handle() {
        return [
          { id: 1, name: 'Alice', secret: 'x' },
          { id: 2, name: 'Bob', secret: 'y' },
        ];
      }
    }

    @Module({ controllers: [SerializeArrController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/serialize-arr');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any[];
    expect(body).toEqual([{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }]);
  });

  it('passes through response when no @Serialize is applied', async () => {
    @Controller('/serialize-pass')
    @UseInterceptors(SerializerInterceptor)
    class PassController {
      @Get()
      handle() { return { id: 1, secret: 'kept' }; }
    }

    @Module({ controllers: [PassController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(await (await app.getHonoApp().request('/serialize-pass')).json()).toEqual({ id: 1, secret: 'kept' });
  });
});

// =============================================================================
// APP_PIPE with ValidationPipe (global)
// =============================================================================

describe('APP_PIPE with ValidationPipe', () => {
  it('validates request body via APP_PIPE globally', async () => {
    const CreateSchema = z.object({
      name: z.string(),
      email: z.string().email(),
    });
    class CreateDto extends createZodDto(CreateSchema) {}

    @Controller('/app-pipe-val')
    class ValController {
      @Post()
      create(@Body() dto: CreateDto) { return { ok: true, name: (dto as { name: string }).name }; }
    }

    @Module({
      providers: [{ provide: APP_PIPE, useClass: ValidationPipe }],
      controllers: [ValController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const valid = await hono.request('/app-pipe-val', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice', email: 'alice@example.com' }),
    });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ ok: true, name: 'Alice' });

    const invalid = await hono.request('/app-pipe-val', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice', email: 'not-an-email' }),
    });
    expect(invalid.status).toBe(400);
  });

  it('skips validation when body does not have a Zod schema', async () => {
    @Controller('/app-pipe-plain')
    class PlainController {
      @Post()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create(@Body() body: any) { return { received: body.x }; }
    }

    @Module({
      providers: [{ provide: APP_PIPE, useClass: ValidationPipe }],
      controllers: [PlainController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/app-pipe-plain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: 42 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 42 });
  });
});

// =============================================================================
// MiddlewareConsumer.exclude()
// =============================================================================

describe('MiddlewareConsumer.exclude()', () => {
  it('middleware runs on all routes except excluded path', async () => {
    const log: string[] = [];

    @Injectable()
    class LogMiddleware {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      use(c: any, next: () => Promise<void>) {
        log.push(c.req.path);
        return next();
      }
    }

    @Controller('/excl')
    class ExclController {
      @Get('/a') a() { return { route: 'a' }; }
      @Get('/b') b() { return { route: 'b' }; }
      @Get('/skip') skip() { return { route: 'skip' }; }
    }

    @Module({ providers: [LogMiddleware], controllers: [ExclController] })
    class AppModule implements NestModule {
      configure(consumer: MiddlewareConsumer) {
        consumer.apply(LogMiddleware).exclude('/excl/skip').forRoutes(ExclController);
      }
    }

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    await hono.request('/excl/a');
    await hono.request('/excl/b');
    await hono.request('/excl/skip');

    expect(log).toContain('/excl/a');
    expect(log).toContain('/excl/b');
    expect(log).not.toContain('/excl/skip');
  });

  it('middleware runs on non-excluded methods and skips excluded method+path combo', async () => {
    const log: string[] = [];

    @Injectable()
    class MethodMiddleware {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      use(c: any, next: () => Promise<void>) {
        log.push(`${c.req.method}:${c.req.path}`);
        return next();
      }
    }

    @Controller('/meth-excl')
    class MethController {
      @Get('/open') open() { return {}; }
      @Post('/login') login() { return {}; }
    }

    @Module({ providers: [MethodMiddleware], controllers: [MethController] })
    class AppModule implements NestModule {
      configure(consumer: MiddlewareConsumer) {
        consumer
          .apply(MethodMiddleware)
          .exclude({ path: '/meth-excl/login', method: RequestMethod.POST })
          .forRoutes(MethController);
      }
    }

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    await hono.request('/meth-excl/open');
    await hono.request('/meth-excl/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

    expect(log).toContain('GET:/meth-excl/open');
    expect(log).not.toContain('POST:/meth-excl/login');
  });
});

// =============================================================================
// @Cookie() / @Cookies() param decorators
// =============================================================================

describe('@Cookie() / @Cookies() param decorators', () => {
  it('extracts a single cookie by name', async () => {
    @Controller('/ck')
    class CkController {
      @Get()
      handle(@Cookie('session') session: string) { return { session }; }
    }

    @Module({ controllers: [CkController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/ck', {
      headers: { Cookie: 'session=abc123' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ session: 'abc123' });
  });

  it('returns undefined for a missing cookie', async () => {
    @Controller('/ck-miss')
    class CkMissController {
      @Get()
      handle(@Cookie('token') token: string | undefined) { return { token: token ?? null }; }
    }

    @Module({ controllers: [CkMissController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/ck-miss');
    expect(await res.json()).toEqual({ token: null });
  });

  it('@Cookies() with no name returns all cookies as an object', async () => {
    @Controller('/cks-all')
    class CksAllController {
      @Get()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handle(@Cookies() cookies: any) { return cookies; }
    }

    @Module({ controllers: [CksAllController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/cks-all', {
      headers: { Cookie: 'a=1; b=2' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ a: '1', b: '2' });
  });
});

// =============================================================================
// @RawBody() param decorator
// =============================================================================

describe('@RawBody() param decorator', () => {
  it('injects the request body as Uint8Array', async () => {
    @Controller('/raw')
    class RawController {
      @Post()
      handle(@RawBody() body: Uint8Array) {
        const text = new TextDecoder().decode(body);
        return { text };
      }
    }

    @Module({ controllers: [RawController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/raw', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello-raw',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'hello-raw' });
  });

  it('allows HMAC-style verification from raw bytes', async () => {
    @Controller('/raw-verify')
    class RawVerifyController {
      @Post()
      handle(@RawBody() body: Uint8Array) {
        return { byteLength: body.byteLength, isUint8Array: body instanceof Uint8Array };
      }
    }

    @Module({ controllers: [RawVerifyController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const payload = JSON.stringify({ event: 'push' });
    const res = await app.getHonoApp().request('/raw-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.byteLength).toBe(new TextEncoder().encode(payload).byteLength);
    expect(body.isUint8Array).toBe(true);
  });
});

// =============================================================================
// CacheInterceptor / @CacheKey / @CacheTTL
// =============================================================================

describe('CacheInterceptor / @CacheKey / @CacheTTL', () => {
  it('caches response — handler called only once for the same URL', async () => {
    let callCount = 0;

    @Controller('/cache-test')
    class CacheController {
      @Get()
      @UseInterceptors(CacheInterceptor)
      getData() { callCount++; return { n: callCount }; }
    }

    @Module({ imports: [CacheModule.forRoot()], controllers: [CacheController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const r1 = await hono.request('/cache-test');
    const r2 = await hono.request('/cache-test');

    expect(await r1.json()).toEqual({ n: 1 });
    expect(await r2.json()).toEqual({ n: 1 }); // served from cache
    expect(callCount).toBe(1);
  });

  it('@CacheKey overrides the cache key', async () => {
    let callCount = 0;

    @Controller('/cache-key')
    class CacheKeyController {
      @Get()
      @UseInterceptors(CacheInterceptor)
      @CacheKey('my-custom-key')
      getData() { callCount++; return { n: callCount }; }
    }

    @Module({ imports: [CacheModule.forRoot()], controllers: [CacheKeyController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    await hono.request('/cache-key');
    await hono.request('/cache-key');
    expect(callCount).toBe(1);
  });

  it('@CacheTTL sets per-route TTL', async () => {
    let callCount = 0;

    @Controller('/cache-ttl')
    class CacheTTLController {
      @Get()
      @UseInterceptors(CacheInterceptor)
      @CacheTTL(0.05) // 50ms TTL (TTL is in seconds)
      getData() { callCount++; return { n: callCount }; }
    }

    @Module({ imports: [CacheModule.forRoot()], controllers: [CacheTTLController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    await hono.request('/cache-ttl');
    expect(callCount).toBe(1);

    // Wait well past TTL to ensure expiry (TTL = 50ms)
    await new Promise((r) => setTimeout(r, 120));

    await hono.request('/cache-ttl');
    expect(callCount).toBe(2); // cache expired, handler called again
  });
});

// =============================================================================
// EventEmitter / @OnEvent
// =============================================================================

describe('EventEmitter / @OnEvent', () => {
  beforeEach(() => {
    // MetadataRegistry.clear() wipes EventEmitterModule metadata since it's a
    // plain @Module() class whose decorator runs once at import time.
    MetadataRegistry.setModuleOptions(EventEmitterModule, {
      providers: [EventEmitter, EventEmitterSubscriber],
      exports: [EventEmitter],
    });
  });

  it('@OnEvent handler is auto-subscribed and fires on emit', async () => {
    const received: string[] = [];

    @Injectable()
    class UserListener {
      @OnEvent('user.created')
      onCreated(name: string) { received.push(name); }
    }

    @Module({ imports: [EventEmitterModule], providers: [UserListener] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await app.get(EventEmitter).emit('user.created', 'Alice');
    expect(received).toEqual(['Alice']);
  });

  it('EventEmitter is injectable into controllers', async () => {
    @Controller('/emit')
    class EmitController {
      constructor(private emitter: EventEmitter) {}

      @Get()
      async fire() {
        await this.emitter.emit('ping', 'pong');
        return { fired: true };
      }
    }

    @Module({ imports: [EventEmitterModule], controllers: [EmitController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/emit');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fired: true });
  });

  it('wildcard patterns (* and **) match event names', async () => {
    const received: string[] = [];

    @Injectable()
    class WildListener {
      @OnEvent('order.*')
      onShallow(payload: string) { received.push(`shallow:${payload}`); }

      @OnEvent('order.**')
      onDeep(payload: string) { received.push(`deep:${payload}`); }
    }

    @Module({ imports: [EventEmitterModule], providers: [WildListener] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const emitter = app.get(EventEmitter);

    await emitter.emit('order.created', 'A');
    await emitter.emit('order.item.added', 'B');

    expect(received).toContain('shallow:A');
    expect(received).not.toContain('shallow:B'); // * doesn't match nested
    expect(received).toContain('deep:A');
    expect(received).toContain('deep:B');
  });
});

// =============================================================================
// ScheduleModule / @Cron / @Interval
// =============================================================================

describe('ScheduleModule / @Cron / @Interval', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('ScheduleRegistry discovers @Cron jobs after bootstrap', async () => {
    @Injectable()
    class TaskService {
      @Cron('0 * * * *')
      runHourly() {}

      @Cron('0 0 * * *')
      runDaily() {}
    }

    @Module({ imports: [ScheduleModule.forRoot()], providers: [TaskService] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const registry = app.get(ScheduleRegistry);

    const jobs = registry.getCronJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.expression)).toContain('0 * * * *');
    expect(jobs.map((j) => j.expression)).toContain('0 0 * * *');
  });

  it('ScheduleRegistry discovers @Interval jobs after bootstrap', async () => {
    @Injectable()
    class TimerService {
      @Interval(1000)
      tick() {}
    }

    @Module({ imports: [ScheduleModule.forRoot()], providers: [TimerService] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const jobs = app.get(ScheduleRegistry).getIntervalJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].ms).toBe(1000);
  });

  it('@Interval fires repeatedly when enableTimers is true', async () => {
    vi.useFakeTimers();
    let count = 0;

    @Injectable()
    class PulseService {
      @Interval(100)
      pulse() { count++; }
    }

    @Module({ imports: [ScheduleModule.forRoot({ enableTimers: true })], providers: [PulseService] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await vi.advanceTimersByTimeAsync(350);
    expect(count).toBe(3);
    await app.close();
  });

  it('timers stop after app.close()', async () => {
    vi.useFakeTimers();
    let count = 0;

    @Injectable()
    class StopService {
      @Interval(100)
      tick() { count++; }
    }

    @Module({ imports: [ScheduleModule.forRoot({ enableTimers: true })], providers: [StopService] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await vi.advanceTimersByTimeAsync(150);
    const before = count;
    await app.close();
    await vi.advanceTimersByTimeAsync(500);
    expect(count).toBe(before); // no more ticks
  });
});

// =============================================================================
// TestingModule / Test.createTestingModule
// =============================================================================

describe('TestingModule / Test.createTestingModule', () => {
  it('compiles a module and resolves providers via get()', async () => {
    @Injectable()
    class AppService {
      greet() { return 'hello'; }
    }

    const moduleRef = await Test.createTestingModule({
      providers: [AppService],
    }).compile();

    const svc = moduleRef.get(AppService);
    expect(svc.greet()).toBe('hello');
  });

  it('overrideProvider().useValue() replaces the real implementation', async () => {
    @Injectable()
    class DataService {
      fetch() { return 'real'; }
    }

    @Controller('/test-override')
    class TestController {
      constructor(private svc: DataService) {}
      @Get() handle() { return { val: this.svc.fetch() }; }
    }

    const moduleRef = await Test.createTestingModule({
      providers: [DataService],
      controllers: [TestController],
    })
      .overrideProvider(DataService)
      .useValue({ fetch: () => 'mocked' })
      .compile();

    const app = moduleRef.createNestApplication();
    const res = await app.getHonoApp().request('/test-override');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ val: 'mocked' });
  });

  it('overrideGuard().useValue() bypasses a blocking guard', async () => {
    @Injectable()
    class BlockGuard implements CanActivate {
      canActivate() { return false; }
    }

    @Controller('/guard-test')
    @UseGuards(BlockGuard)
    class GuardedController {
      @Get() secret() { return { ok: true }; }
    }

    const moduleRef = await Test.createTestingModule({
      providers: [BlockGuard],
      controllers: [GuardedController],
    })
      .overrideGuard(BlockGuard)
      .useValue({ canActivate: () => true })
      .compile();

    const app = moduleRef.createNestApplication();
    const res = await app.getHonoApp().request('/guard-test');
    expect(res.status).toBe(200);
  });

  it('close() triggers onModuleDestroy lifecycle hook', async () => {
    const log: string[] = [];

    @Injectable()
    class CleanupService {
      onModuleDestroy() { log.push('destroyed'); }
    }

    const moduleRef = await Test.createTestingModule({
      providers: [CleanupService],
    }).compile();

    await moduleRef.close();
    expect(log).toContain('destroyed');
  });
});

// =============================================================================
// ThrottlerModule / @Throttle / @SkipThrottle
// =============================================================================

describe('ThrottlerModule / @Throttle / @SkipThrottle', () => {
  it('blocks requests exceeding the rate limit with 429', async () => {
    @Controller('/throttle-test')
    class ThrottleController {
      @Get() handle() { return { ok: true }; }
    }

    @Module({
      imports: [ThrottlerModule.forRoot({ limit: 2, ttl: 60000 })],
      controllers: [ThrottleController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    expect((await hono.request('/throttle-test')).status).toBe(200);
    expect((await hono.request('/throttle-test')).status).toBe(200);
    expect((await hono.request('/throttle-test')).status).toBe(429);
  });

  it('sets X-RateLimit-* headers on responses', async () => {
    @Controller('/throttle-hdrs')
    class ThrottleHdrsController {
      @Get() handle() { return {}; }
    }

    @Module({
      imports: [ThrottlerModule.forRoot({ limit: 5, ttl: 60000 })],
      controllers: [ThrottleHdrsController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/throttle-hdrs');
    expect(res.headers.get('X-RateLimit-Limit')).toBe('5');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('4');
  });

  it('@SkipThrottle() bypasses rate limiting on that route', async () => {
    @Controller('/throttle-skip')
    class SkipController {
      @Get('/limited') limited() { return { limited: true }; }

      @Get('/unlimited')
      @SkipThrottle()
      unlimited() { return { unlimited: true }; }
    }

    @Module({
      imports: [ThrottlerModule.forRoot({ limit: 1, ttl: 60000 })],
      controllers: [SkipController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    await hono.request('/throttle-skip/limited');
    expect((await hono.request('/throttle-skip/limited')).status).toBe(429);

    // Unlimited route should still respond regardless of global limit state
    expect((await hono.request('/throttle-skip/unlimited')).status).toBe(200);
    expect((await hono.request('/throttle-skip/unlimited')).status).toBe(200);
  });

  it('@Throttle() overrides global config per route', async () => {
    @Controller('/throttle-override')
    class OverrideController {
      @Get('/default') defRoute() { return {}; }

      @Get('/tight')
      @Throttle({ limit: 1, ttl: 60000 })
      tightRoute() { return {}; }
    }

    @Module({
      imports: [ThrottlerModule.forRoot({ limit: 10, ttl: 60000 })],
      controllers: [OverrideController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    // Tight route blocks on 2nd request
    expect((await hono.request('/throttle-override/tight')).status).toBe(200);
    expect((await hono.request('/throttle-override/tight')).status).toBe(429);

    // Default route still has limit 10
    for (let i = 0; i < 10; i++) {
      expect((await hono.request('/throttle-override/default')).status).toBe(200);
    }
  });
});

// =============================================================================
// HTTP method decorators (Put, Patch, Options, Head)
// =============================================================================

describe('HTTP method decorators (Put, Patch, Options, Head)', () => {
  it('@Put() handles PUT requests', async () => {
    @Controller('/items')
    class ItemController {
      @Put(':id')
      update(@Param('id') id: string, @Body() body: { name: string }) {
        return { id, name: body.name, updated: true };
      }
    }

    @Module({ controllers: [ItemController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/items/42', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'updated' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: '42', name: 'updated', updated: true });
  });

  it('@Patch() handles PATCH requests', async () => {
    @Controller('/users')
    class UserController {
      @Patch(':id')
      patch(@Param('id') id: string, @Body() body: { email: string }) {
        return { id, email: body.email, patched: true };
      }
    }

    @Module({ controllers: [UserController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/users/7', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: '7', email: 'new@example.com', patched: true });
  });

  it('@Options() handles OPTIONS requests', async () => {
    @Controller('/resource')
    class ResourceController {
      @Options()
      options() { return { allow: 'GET,POST,OPTIONS' }; }
    }

    @Module({ controllers: [ResourceController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/resource', { method: 'OPTIONS' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allow: 'GET,POST,OPTIONS' });
  });

  it('@Head() handles HEAD requests (no body)', async () => {
    @Controller('/ping')
    class PingController {
      @Head()
      @Header('x-alive', 'true')
      ping() { return ''; }
    }

    @Module({ controllers: [PingController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/ping', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-alive')).toBe('true');
  });

  it('all HTTP verbs coexist on the same controller', async () => {
    @Controller('/things')
    class ThingsController {
      @Get()     list()              { return { method: 'GET' }; }
      @Post()    create()            { return { method: 'POST' }; }
      @Put(':id') replace()          { return { method: 'PUT' }; }
      @Patch(':id') update()         { return { method: 'PATCH' }; }
      @Delete(':id') remove()        { return { method: 'DELETE' }; }
    }

    @Module({ controllers: [ThingsController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    expect(await (await hono.request('/things')).json()).toEqual({ method: 'GET' });
    expect(await (await hono.request('/things', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()).toEqual({ method: 'POST' });
    expect(await (await hono.request('/things/1', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()).toEqual({ method: 'PUT' });
    expect(await (await hono.request('/things/1', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()).toEqual({ method: 'PATCH' });
    expect(await (await hono.request('/things/1', { method: 'DELETE' })).json()).toEqual({ method: 'DELETE' });
  });
});

// =============================================================================
// HttpModule / HttpService
// =============================================================================

describe('HttpModule / HttpService', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('HttpService.get() makes a GET request and returns data', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 1, name: 'Alice' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    @Injectable()
    class UserService {
      constructor(private http: HttpService) {}
      async getUser() { return (await this.http.get<{ id: number; name: string }>('https://api.test/user/1')).data; }
    }

    @Controller('/users')
    class UserController {
      constructor(private svc: UserService) {}
      @Get() async handle() { return this.svc.getUser(); }
    }

    @Module({ imports: [HttpModule], providers: [UserService], controllers: [UserController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/users');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 1, name: 'Alice' });
  });

  it('HttpModule.register() sets baseURL for all requests', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    @Injectable()
    class ApiService {
      constructor(private http: HttpService) {}
      ping() { return this.http.get('/status'); }
    }

    @Controller('/ping')
    class PingController {
      constructor(private api: ApiService) {}
      @Get() async handle() { await this.api.ping(); return { called: true }; }
    }

    @Module({
      imports: [HttpModule.register({ baseURL: 'https://my-api.com' })],
      providers: [ApiService],
      controllers: [PingController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await app.getHonoApp().request('/ping');
    expect(fetch).toHaveBeenCalledWith('https://my-api.com/status', expect.objectContaining({ method: 'GET' }));
  });

  it('HttpModule.registerAsync() resolves config from injected factory', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ async: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const BASE_URL = new InjectionToken<string>('BASE_URL');

    @Injectable()
    class RemoteService {
      constructor(private http: HttpService) {}
      fetch() { return this.http.get('/data'); }
    }

    @Controller('/async-http')
    class AsyncHttpController {
      constructor(private svc: RemoteService) {}
      @Get() async handle() { await this.svc.fetch(); return { ok: true }; }
    }

    @Module({
      imports: [
        HttpModule.registerAsync({
          useFactory: (url: string) => ({ baseURL: url }),
          inject: [BASE_URL],
        }),
      ],
      providers: [
        { provide: BASE_URL, useValue: 'https://async-api.com' },
        RemoteService,
      ],
      controllers: [AsyncHttpController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await app.getHonoApp().request('/async-http');
    expect(fetch).toHaveBeenCalledWith('https://async-api.com/data', expect.anything());
  });

  it('HttpRequestException is thrown for non-2xx responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Not Found', { status: 404, statusText: 'Not Found' }),
    );

    @Injectable()
    class FetchService {
      constructor(private http: HttpService) {}
      async fetch() {
        try {
          await this.http.get('https://api.test/missing');
          return { threw: false };
        } catch (e) {
          return { threw: true, status: (e as HttpRequestException).status };
        }
      }
    }

    @Controller('/exc')
    class ExcController {
      constructor(private svc: FetchService) {}
      @Get() async handle() { return this.svc.fetch(); }
    }

    @Module({ imports: [HttpModule], providers: [FetchService], controllers: [ExcController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/exc');
    expect(await res.json()).toEqual({ threw: true, status: 404 });
  });
});

// =============================================================================
// HealthModule
// =============================================================================

describe('HealthModule', () => {
  beforeEach(() => {
    // HealthModule is a plain @Module() class; re-register after MetadataRegistry.clear()
    MetadataRegistry.setModuleOptions(HealthModule, {
      providers: [HealthCheckService, HealthIndicatorService, HttpHealthIndicator],
      exports: [HealthCheckService, HealthIndicatorService, HttpHealthIndicator],
    });
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('HealthCheckService.check() returns status:ok when all indicators pass', async () => {
    @Controller('/health')
    class HealthController {
      constructor(
        private health: HealthCheckService,
        private indicator: HealthIndicatorService,
      ) {}

      @Get()
      check() {
        return this.health.check([
          () => this.indicator.check('db').up({ responseTime: 5 }),
        ]);
      }
    }

    @Module({ imports: [HealthModule], controllers: [HealthController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/health');
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.status).toBe('ok');
    expect(body.info.db.status).toBe('up');
  });

  it('HealthCheckService returns 503 when an indicator is down', async () => {
    @Controller('/health-down')
    class DownController {
      constructor(
        private health: HealthCheckService,
        private indicator: HealthIndicatorService,
      ) {}

      @Get()
      check() {
        return this.health.check([
          () => this.indicator.check('redis').up(),
          () => this.indicator.check('db').down({ message: 'timeout' }),
        ]);
      }
    }

    @Module({ imports: [HealthModule], controllers: [DownController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/health-down');
    expect(res.status).toBe(503);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.status).toBe('error');
    expect(body.error.db.status).toBe('down');
  });

  it('HttpHealthIndicator.pingCheck() returns up for 2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('OK', { status: 200 })));

    @Controller('/health-http')
    class HttpHealthController {
      constructor(
        private health: HealthCheckService,
        private http: HttpHealthIndicator,
      ) {}

      @Get()
      check() {
        return this.health.check([
          () => this.http.pingCheck('api', 'https://api.test/ping'),
        ]);
      }
    }

    @Module({ imports: [HealthModule], controllers: [HttpHealthController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/health-http');
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((await res.json() as any).info.api.status).toBe('up');
  });
});

// =============================================================================
// @Sse() Server-Sent Events
// =============================================================================

describe('@Sse() Server-Sent Events', () => {
  it('@Sse() registers a GET route that returns text/event-stream', async () => {
    @Controller('/stream')
    class StreamController {
      @Sse('/events')
      events() {
        return new Response('data: hello\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
    }

    @Module({ controllers: [StreamController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/stream/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toBe('data: hello\n\n');
  });

  it('@Sse() and @Get() can coexist on the same controller', async () => {
    @Controller('/mixed')
    class MixedController {
      @Get('/data') data() { return { type: 'json' }; }

      @Sse('/live')
      stream() {
        return new Response('data: tick\n\n', {
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        });
      }
    }

    @Module({ controllers: [MixedController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const json = await hono.request('/mixed/data');
    expect(await json.json()).toEqual({ type: 'json' });

    const sse = await hono.request('/mixed/live');
    expect(sse.headers.get('content-type')).toBe('text/event-stream');
    expect(sse.headers.get('cache-control')).toBe('no-cache');
  });

  it('@Sse() passes through guards and interceptors in the pipeline', async () => {
    let guardCalled = false;

    @Injectable()
    class TrackGuard implements CanActivate {
      canActivate() { guardCalled = true; return true; }
    }

    @Controller('/guarded-sse')
    @UseGuards(TrackGuard)
    class GuardedSseController {
      @Sse('/feed')
      feed() {
        return new Response('data: ok\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
    }

    @Module({ providers: [TrackGuard], controllers: [GuardedSseController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await app.getHonoApp().request('/guarded-sse/feed');
    expect(guardCalled).toBe(true);
  });
});

// =============================================================================
// useExisting provider alias in module context
// =============================================================================

describe('useExisting provider alias', () => {
  it('alias resolves to the same singleton instance as the real token', async () => {
    @Injectable()
    class RealService {
      id = Math.random();
      getValue() { return this.id; }
    }

    const ALIAS = new InjectionToken<RealService>('ALIAS');

    @Controller('/alias')
    class AliasController {
      constructor(
        @Inject(ALIAS) private aliased: RealService,
        private real: RealService,
      ) {}

      @Get()
      handle() {
        return { same: this.aliased === this.real, value: this.real.getValue() };
      }
    }

    @Module({
      providers: [
        RealService,
        { provide: ALIAS, useExisting: RealService },
      ],
      controllers: [AliasController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/alias');
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.same).toBe(true);
  });

  it('multiple aliases can point to the same service', async () => {
    @Injectable()
    class LoggerService {
      log(msg: string) { return msg; }
    }

    const LOGGER = new InjectionToken<LoggerService>('LOGGER');
    const APP_LOGGER = new InjectionToken<LoggerService>('APP_LOGGER');

    @Controller('/multi-alias')
    class MultiAliasController {
      constructor(
        @Inject(LOGGER) private l1: LoggerService,
        @Inject(APP_LOGGER) private l2: LoggerService,
        private real: LoggerService,
      ) {}

      @Get()
      handle() {
        return { l1Real: this.l1 === this.real, l2Real: this.l2 === this.real };
      }
    }

    @Module({
      providers: [
        LoggerService,
        { provide: LOGGER, useExisting: LoggerService },
        { provide: APP_LOGGER, useExisting: LoggerService },
      ],
      controllers: [MultiAliasController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/multi-alias');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.l1Real).toBe(true);
    expect(body.l2Real).toBe(true);
  });
});

// =============================================================================
// forRootAsync() dynamic module pattern
// =============================================================================

describe('forRootAsync() dynamic module pattern', () => {
  it('HttpModule.registerAsync() resolves config from ConfigService', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: 'async-config' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    @Injectable()
    class DataService {
      constructor(private http: HttpService) {}
      async fetch() { return (await this.http.get<{ data: string }>('/resource')).data; }
    }

    @Controller('/async-root')
    class AsyncRootController {
      constructor(private svc: DataService) {}
      @Get() async handle() { return this.svc.fetch(); }
    }

    @Module({
      imports: [
        ConfigModule.forRoot({ config: { API_BASE: 'https://async-root.test' } }),
        HttpModule.registerAsync({
          imports: [ConfigModule.forRoot({ config: { API_BASE: 'https://async-root.test' } })],
          useFactory: (config: ConfigService) => ({
            baseURL: config.get<string>('API_BASE') ?? '',
          }),
          inject: [ConfigService],
        }),
      ],
      providers: [DataService],
      controllers: [AsyncRootController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await app.getHonoApp().request('/async-root');
    expect(fetch).toHaveBeenCalledWith(
      'https://async-root.test/resource',
      expect.objectContaining({ method: 'GET' }),
    );
    vi.restoreAllMocks();
  });

  it('async factory receives injected dependency before module initializes', async () => {
    const CONFIG_VAL = new InjectionToken<string>('CONFIG_VAL');

    @Injectable()
    class CheckService {
      constructor(private http: HttpService) {}
      getBaseURL() {
        // Access the options via a GET to verify they were set correctly
        return 'configured';
      }
    }

    @Controller('/factory-order')
    class FactoryOrderController {
      constructor(private svc: CheckService) {}
      @Get() handle() { return { result: this.svc.getBaseURL() }; }
    }

    @Module({
      imports: [
        HttpModule.registerAsync({
          useFactory: (val: string) => ({ baseURL: `https://${val}.test` }),
          inject: [CONFIG_VAL],
        }),
      ],
      providers: [
        { provide: CONFIG_VAL, useValue: 'injected-factory' },
        CheckService,
      ],
      controllers: [FactoryOrderController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/factory-order');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'configured' });
  });
});
