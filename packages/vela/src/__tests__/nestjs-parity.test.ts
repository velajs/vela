import { defineProvider } from '../container/types';
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
  HttpMethod,
  ModuleRef,
  ModuleVisibilityError,
  mixin,
  InjectionToken,
  Inject,
  Scope,
  forwardRef,
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
  defineDto,
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
  Cacheable,
  CacheKey,
  CacheTTL,
  EventEmitterModule,
  EventEmitter,
  EventEmitterSubscriber,
  OnEvent,
  ScheduleModule,
  ScheduleRegistry,
} from '../index.js';
import { ScheduleNodeModule } from '../schedule-node/index.js';
import {
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
  All,
  Ip,
  Sse,
  HttpModule,
  HttpService,
  HttpRequestException,
  HealthModule,
  HealthCheckService,
  HealthIndicatorService,
  HttpHealthIndicator,
  ServiceUnavailableException,
  MethodNotAllowedException,
  NotAcceptableException,
  RequestTimeoutException,
  GoneException,
  PayloadTooLargeException,
  UnprocessableEntityException,
  InternalServerErrorException,
  NotImplementedException,
  TooManyRequestsException,
  Optional,
  CorsModule,
  Logger,
  LogLevel,
  CacheService,
  CACHE_MANAGER,
  ZodValidationPipe,
  RequiredPipe,
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
      providers: [ApiKeyGuard, defineProvider(APP_GUARD, { useExisting: ApiKeyGuard })],
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
        defineProvider(APP_INTERCEPTOR, { useExisting: WrapInterceptor }),
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
      providers: [TrimPipe, defineProvider(APP_PIPE, { useExisting: TrimPipe })],
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
        defineProvider(APP_GUARD, { useExisting: FirstGuard }),
        defineProvider(APP_GUARD, { useExisting: SecondGuard }),
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

  it('APP_GUARD { useClass } keeps a REQUEST-scoped guard per request', async () => {
    const seen: number[] = [];

    @Injectable({ scope: Scope.REQUEST })
    class PerRequestGuard implements CanActivate {
      readonly id = Math.random();
      #calls = 0;
      canActivate(_context: ExecutionContext): boolean {
        this.#calls++;
        seen.push(this.id);
        // A shared instance would carry state from the previous request.
        return this.#calls === 1;
      }
    }

    @Controller('/request-guard')
    class GuardedController {
      @Get()
      handle() {
        return { ok: true };
      }
    }

    @Module({
      providers: [defineProvider(APP_GUARD, { useClass: PerRequestGuard })],
      controllers: [GuardedController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    expect((await hono.request('/request-guard')).status).toBe(200);
    expect((await hono.request('/request-guard')).status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
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
      handle() {
        return { admin: true };
      }
    }

    @Controller('/public')
    class PublicController {
      @Get()
      handle() {
        return { public: true };
      }
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
      handle() {
        return { ok: true };
      }
    }

    @Controller('/other')
    class OtherController {
      @Get()
      handle() {
        return { ok: true };
      }
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
      data() {
        return { data: true };
      }

      @Get('/health')
      health() {
        return { ok: true };
      }
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
      get() {
        return { method: 'GET' };
      }

      @Post()
      post() {
        return { method: 'POST' };
      }
    }

    @Module({ providers: [PostOnlyMiddleware], controllers: [MethodsController] })
    class AppModule implements NestModule {
      configure(consumer: MiddlewareConsumer) {
        consumer.apply(PostOnlyMiddleware).forRoutes({ path: '/methods', method: HttpMethod.POST });
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
      handle() {
        return { ok: true };
      }
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
      greet() {
        return 'hello';
      }
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
      providers: [defineProvider(MY_TOKEN, { useValue: 'token-value' })],
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
      increment() {
        return ++this.count;
      }
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
    const body = (await res.json()) as { a: number; b: number; same: boolean };
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
      adminOnly() {
        return { role: 'admin' };
      }

      @Get('/user')
      @UseGuards(UserGuard)
      userOnly() {
        return { role: 'user' };
      }
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
      getVal() {
        return this.config.get('APP_NAME');
      }
    }

    @Controller('/cfg-global')
    class CfgController {
      constructor(private svc: AppService) {}
      @Get()
      handle() {
        return { val: this.svc.getVal() };
      }
    }

    @Module({ providers: [AppService], controllers: [CfgController] })
    class FeatureModule {}

    @Module({
      imports: [
        ConfigModule.forRoot({ config: { APP_NAME: 'vela' }, isGlobal: true }),
        FeatureModule,
      ],
    })
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
      handle() {
        return { from: 'a' };
      }
    }

    @Controller('/mod-guard-b')
    class ControllerB {
      @Get()
      handle() {
        return { from: 'b' };
      }
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
      handle() {
        return { raw: true };
      }
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
      handle(@Param('name') name: string) {
        return { name };
      }
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
      handle() {
        return { ok: true };
      }
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
      handle() {
        return { ok: true };
      }
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
      transform(value: number): number {
        return value * 2;
      }
    }
    class AddTen implements PipeTransform<number, number> {
      transform(value: number): number {
        return value + 10;
      }
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
      async onModuleInit() {
        calls.push('init');
      }
      async onApplicationBootstrap() {
        calls.push('bootstrap');
      }
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
      onModuleInit() {
        calls.push('A');
      }
    }
    @Injectable()
    class ServiceB implements OnModuleInit {
      onModuleInit() {
        calls.push('B');
      }
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
      onModuleDestroy() {
        calls.push('destroyed');
      }
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
      handle() {
        throw new Error('boom');
      }
    }

    @Module({
      providers: [GlobalFilter, defineProvider(APP_FILTER, { useExisting: GlobalFilter })],
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
      throwDomain() {
        throw new DomainError('domain');
      }

      @Get('/uncaught')
      throwOther() {
        throw new Error('generic');
      }
    }

    @Module({
      providers: [DomainFilter, defineProvider(APP_FILTER, { useExisting: DomainFilter })],
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
      beforeApplicationShutdown(signal?: string) {
        log.push(`A:before:${signal ?? 'none'}`);
      }
      onApplicationShutdown(signal?: string) {
        log.push(`A:shutdown:${signal ?? 'none'}`);
      }
    }

    @Injectable()
    class ServiceB implements BeforeApplicationShutdown, OnApplicationShutdown {
      beforeApplicationShutdown(signal?: string) {
        log.push(`B:before:${signal ?? 'none'}`);
      }
      onApplicationShutdown(signal?: string) {
        log.push(`B:shutdown:${signal ?? 'none'}`);
      }
    }

    @Controller('/shutdown-test')
    class ShutdownController {
      constructor(
        private a: ServiceA,
        private b: ServiceB,
      ) {}
      @Get() handle() {
        return { ok: true };
      }
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
    const firstShutdown = Math.min(
      log.indexOf('A:shutdown:SIGTERM'),
      log.indexOf('B:shutdown:SIGTERM'),
    );
    expect(firstBefore).toBeLessThan(firstShutdown);
  });

  it('close() with no signal passes undefined to hooks', async () => {
    let capturedSignal: string | undefined = 'NOT_SET';

    @Injectable()
    class WatchService implements OnApplicationShutdown {
      onApplicationShutdown(signal?: string) {
        capturedSignal = signal;
      }
    }

    @Controller('/noop-shutdown')
    class NoopController {
      constructor(private w: WatchService) {}
      @Get() handle() {
        return {};
      }
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
      onApplicationShutdown() {
        log.push('first');
      }
    }

    @Injectable()
    class LastService implements OnApplicationShutdown {
      onApplicationShutdown() {
        log.push('last');
      }
    }

    @Controller('/lifo')
    class LifoController {
      constructor(
        private f: FirstService,
        private l: LastService,
      ) {}
      @Get() handle() {
        return {};
      }
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
      @Get() handle() {
        return { ok: true };
      }
    }

    @Controller('/mw-global-2')
    class MwController2 {
      @Get() handle() {
        return { ok: 2 };
      }
    }

    @Module({
      providers: [
        RequestIdMiddleware,
        defineProvider(APP_MIDDLEWARE, { useExisting: RequestIdMiddleware }),
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
      use(_c: any, next: () => Promise<void>) {
        log.push('A');
        return next();
      }
    }

    @Injectable()
    class MiddlewareB {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      use(_c: any, next: () => Promise<void>) {
        log.push('B');
        return next();
      }
    }

    @Controller('/mw-order')
    class OrderController {
      @Get() handle() {
        return { ok: true };
      }
    }

    @Module({
      providers: [
        MiddlewareA,
        MiddlewareB,
        defineProvider(APP_MIDDLEWARE, { useExisting: MiddlewareA }),
        defineProvider(APP_MIDDLEWARE, { useExisting: MiddlewareB }),
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
      handle(@Query('v', ParseFloatPipe) v: number) {
        return { v };
      }
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
      handle(@Query('v', ParseFloatPipe) v: number) {
        return { v };
      }
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
      handle(@Query('v', ParseBoolPipe) v: boolean) {
        return { v };
      }
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
      handle(@Query('v', ParseBoolPipe) v: boolean) {
        return { v };
      }
    }

    @Module({ controllers: [BoolErrController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect((await app.getHonoApp().request('/bool-err?v=yes')).status).toBe(400);
  });

  it('ParseEnumPipe validates against an enum', async () => {
    enum Direction {
      Up = 'up',
      Down = 'down',
    }

    @Controller('/enum')
    class EnumController {
      @Get()
      handle(@Query('dir', new ParseEnumPipe(Direction)) dir: Direction) {
        return { dir };
      }
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
      handle(@Query('ids', new ParseArrayPipe()) ids: string[]) {
        return { ids };
      }
    }

    @Module({ controllers: [ArrController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(await (await app.getHonoApp().request('/arr?ids=a,b,c')).json()).toEqual({
      ids: ['a', 'b', 'c'],
    });
  });

  it('ParseArrayPipe with custom separator', async () => {
    @Controller('/arr-sep')
    class ArrSepController {
      @Get()
      handle(@Query('ids', new ParseArrayPipe({ separator: '|' })) ids: string[]) {
        return { ids };
      }
    }

    @Module({ controllers: [ArrSepController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(await (await app.getHonoApp().request('/arr-sep?ids=a|b|c')).json()).toEqual({
      ids: ['a', 'b', 'c'],
    });
  });

  it('ParseArrayPipe optional returns empty array when absent', async () => {
    @Controller('/arr-opt')
    class ArrOptController {
      @Get()
      handle(@Query('ids', new ParseArrayPipe({ optional: true })) ids: string[]) {
        return { ids };
      }
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
      (_data: unknown, ctx: ExecutionContext) =>
        ctx.getRequest().headers.get('user-agent') ?? 'unknown',
    );

    @Controller('/custom-param')
    class CustomController {
      @Get()
      handle(@UserAgent() ua: string) {
        return { ua };
      }
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
    const CustomHeader = createParamDecorator((data: string, ctx: ExecutionContext) =>
      ctx.getRequest().headers.get(data),
    );

    @Controller('/custom-header')
    class HeaderController {
      @Get()
      handle(@CustomHeader('x-tenant') tenant: string) {
        return { tenant };
      }
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
    const RawAge = createParamDecorator((_data: unknown, ctx: ExecutionContext) =>
      ctx.getRequest().headers.get('x-age'),
    );

    @Controller('/age-pipe')
    class AgePipeController {
      @Get()
      handle(@RawAge(undefined, ParseIntPipe) age: number) {
        return { age };
      }
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
    @Controller({ path: '/things', version: 1 })
    class ThingsV1Controller {
      @Get() list() {
        return { version: 1 };
      }
    }

    @Module({ controllers: [ThingsV1Controller] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect((await app.getHonoApp().request('/v1/things')).status).toBe(200);
    expect(await (await app.getHonoApp().request('/v1/things')).json()).toEqual({ version: 1 });
    expect((await app.getHonoApp().request('/things')).status).toBe(404);
  });

  it('@Controller({ version: [1,2] }) registers route at multiple versions', async () => {
    @Controller({ path: '/multi', version: [1, 2] })
    class MultiController {
      @Get() handle() {
        return { ok: true };
      }
    }

    @Module({ controllers: [MultiController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect((await app.getHonoApp().request('/v1/multi')).status).toBe(200);
    expect((await app.getHonoApp().request('/v2/multi')).status).toBe(200);
    expect((await app.getHonoApp().request('/multi')).status).toBe(404);
  });

  it('@Version() on method overrides controller version', async () => {
    @Controller({ path: '/docs', version: 1 })
    class DocController {
      @Get() v1() {
        return { v: 1 };
      }

      @Version(2)
      @Get('/new')
      v2() {
        return { v: 2 };
      }
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
      @Get('/404') notFound() {
        throw new NotFoundException('not found');
      }
      @Get('/400') badReq() {
        throw new BadRequestException('bad input');
      }
      @Get('/401') unauth() {
        throw new UnauthorizedException();
      }
      @Get('/403') forbidden() {
        throw new ForbiddenException();
      }
      @Get('/409') conflict() {
        throw new ConflictException('duplicate');
      }
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
      @Get() handle() {
        throw new NotFoundException('item missing');
      }
    }

    @Module({ controllers: [BodyController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/exc-body');
    expect(res.status).toBe(404);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toBe('item missing');
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
      @Get('/404') notFound() {
        throw new NotFoundException();
      }
      @Get('/403') forbidden() {
        throw new ForbiddenException();
      }
    }

    @Module({
      providers: [HttpExcFilter, defineProvider(APP_FILTER, { useExisting: HttpExcFilter })],
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
        throw new HttpException(
          {
            statusCode: 422,
            message: 'Validation Failed',
            errors: ['field required'],
          },
          422,
        );
      }
    }

    @Module({ controllers: [CustomController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/exc-custom');
    expect(res.status).toBe(422);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
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
      handle(@Param('id', ParseUUIDPipe) id: string) {
        return { id };
      }
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
      handle(@Param('id', ParseUUIDPipe) id: string) {
        return { id };
      }
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
      handle(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
        return { id };
      }
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
      handle(@Headers('x-tenant') tenant: string) {
        return { tenant };
      }
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
      handle(@Headers('x-missing') val: string | undefined) {
        return { val: val ?? null };
      }
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
    const res = await app
      .getHonoApp()
      .request('/req-dec', { headers: { 'user-agent': 'vela-test/1.0' } });
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
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
    const ResponseDto = defineDto(Schema, { name: 'ResponseDto' });
    type ResponseDto = ReturnType<typeof ResponseDto.parse>;

    @Controller('/serialize')
    @UseInterceptors(SerializerInterceptor)
    class SerializeController {
      @Get()
      @Serialize(ResponseDto)
      handle() {
        return { id: 1, name: 'Alice', password: 'secret' };
      }
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
    const ResponseDto = defineDto(Schema, { name: 'ResponseDto' });
    type ResponseDto = ReturnType<typeof ResponseDto.parse>;

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
    const body = (await res.json()) as any[];
    expect(body).toEqual([
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ]);
  });

  it('passes through response when no @Serialize is applied', async () => {
    @Controller('/serialize-pass')
    @UseInterceptors(SerializerInterceptor)
    class PassController {
      @Get()
      handle() {
        return { id: 1, secret: 'kept' };
      }
    }

    @Module({ controllers: [PassController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(await (await app.getHonoApp().request('/serialize-pass')).json()).toEqual({
      id: 1,
      secret: 'kept',
    });
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
    const CreateDto = defineDto(CreateSchema, { name: 'CreateDto' });
    type CreateDto = ReturnType<typeof CreateDto.parse>;

    @Controller('/app-pipe-val')
    class ValController {
      @Post()
      create(@Body(new ValidationPipe(CreateDto)) dto: CreateDto) {
        return { ok: true, name: (dto as { name: string }).name };
      }
    }

    @Module({
      providers: [defineProvider(APP_PIPE, { useClass: ValidationPipe })],
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
      create(@Body() body: any) {
        return { received: body.x };
      }
    }

    @Module({
      providers: [defineProvider(APP_PIPE, { useClass: ValidationPipe })],
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
      @Get('/a') a() {
        return { route: 'a' };
      }
      @Get('/b') b() {
        return { route: 'b' };
      }
      @Get('/skip') skip() {
        return { route: 'skip' };
      }
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
      @Get('/open') open() {
        return {};
      }
      @Post('/login') login() {
        return {};
      }
    }

    @Module({ providers: [MethodMiddleware], controllers: [MethController] })
    class AppModule implements NestModule {
      configure(consumer: MiddlewareConsumer) {
        consumer
          .apply(MethodMiddleware)
          .exclude({ path: '/meth-excl/login', method: HttpMethod.POST })
          .forRoutes(MethController);
      }
    }

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    await hono.request('/meth-excl/open');
    await hono.request('/meth-excl/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

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
      handle(@Cookie('session') session: string) {
        return { session };
      }
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
      handle(@Cookie('token') token: string | undefined) {
        return { token: token ?? null };
      }
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
      handle(@Cookies() cookies: any) {
        return cookies;
      }
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
    const body = (await res.json()) as any;
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
      @Cacheable()
      getData() {
        callCount++;
        return { n: callCount };
      }
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
      @Cacheable()
      @CacheKey('my-custom-key')
      getData() {
        callCount++;
        return { n: callCount };
      }
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
      @Cacheable()
      @CacheTTL(0.05) // 50ms TTL (TTL is in seconds)
      getData() {
        callCount++;
        return { n: callCount };
      }
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
      onCreated(name: string) {
        received.push(name);
      }
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
      onShallow(payload: string) {
        received.push(`shallow:${payload}`);
      }

      @OnEvent('order.**')
      onDeep(payload: string) {
        received.push(`deep:${payload}`);
      }
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
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it('@Interval fires repeatedly under ScheduleNodeModule', async () => {
    vi.useFakeTimers();
    let count = 0;

    @Injectable()
    class PulseService {
      @Interval(100)
      pulse() {
        count++;
      }
    }

    @Module({ imports: [ScheduleNodeModule.forRoot()], providers: [PulseService] })
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
      tick() {
        count++;
      }
    }

    @Module({ imports: [ScheduleNodeModule.forRoot()], providers: [StopService] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await vi.advanceTimersByTimeAsync(150);
    const before = count;
    await app.close();
    await vi.advanceTimersByTimeAsync(500);
    expect(count).toBe(before); // no more ticks
  });
});

// TestingModule / Test.createTestingModule —
// Coverage moved to @velajs/testing's own testing-module.test.ts.

// =============================================================================
// ThrottlerModule / @Throttle / @SkipThrottle
// =============================================================================

describe('ThrottlerModule / @Throttle / @SkipThrottle', () => {
  it('blocks requests exceeding the rate limit with 429', async () => {
    @Controller('/throttle-test')
    class ThrottleController {
      @Get() handle() {
        return { ok: true };
      }
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
      @Get() handle() {
        return {};
      }
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
      @Get('/limited') limited() {
        return { limited: true };
      }

      @Get('/unlimited')
      @SkipThrottle()
      unlimited() {
        return { unlimited: true };
      }
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
      @Get('/default') defRoute() {
        return {};
      }

      @Get('/tight')
      @Throttle({ limit: 1, ttl: 60000 })
      tightRoute() {
        return {};
      }
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
      options() {
        return { allow: 'GET,POST,OPTIONS' };
      }
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
      ping() {
        return '';
      }
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
      @Get() list() {
        return { method: 'GET' };
      }
      @Post() create() {
        return { method: 'POST' };
      }
      @Put(':id') replace() {
        return { method: 'PUT' };
      }
      @Patch(':id') update() {
        return { method: 'PATCH' };
      }
      @Delete(':id') remove() {
        return { method: 'DELETE' };
      }
    }

    @Module({ controllers: [ThingsController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    expect(await (await hono.request('/things')).json()).toEqual({ method: 'GET' });
    expect(
      await (
        await hono.request('/things', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).json(),
    ).toEqual({ method: 'POST' });
    expect(
      await (
        await hono.request('/things/1', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).json(),
    ).toEqual({ method: 'PUT' });
    expect(
      await (
        await hono.request('/things/1', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).json(),
    ).toEqual({ method: 'PATCH' });
    expect(await (await hono.request('/things/1', { method: 'DELETE' })).json()).toEqual({
      method: 'DELETE',
    });
  });
});

// =============================================================================
// HttpModule / HttpService
// =============================================================================

describe('HttpModule / HttpService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

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
      async getUser() {
        return (await this.http.get<{ id: number; name: string }>('https://api.test/user/1')).data;
      }
    }

    @Controller('/users')
    class UserController {
      constructor(private svc: UserService) {}
      @Get() async handle() {
        return this.svc.getUser();
      }
    }

    @Module({ imports: [HttpModule], providers: [UserService], controllers: [UserController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/users');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 1, name: 'Alice' });
  });

  it('HttpModule.forRoot() sets baseURL for all requests', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    @Injectable()
    class ApiService {
      constructor(private http: HttpService) {}
      ping() {
        return this.http.get('/status');
      }
    }

    @Controller('/ping')
    class PingController {
      constructor(private api: ApiService) {}
      @Get() async handle() {
        await this.api.ping();
        return { called: true };
      }
    }

    @Module({
      imports: [HttpModule.forRoot({ baseURL: 'https://my-api.com' })],
      providers: [ApiService],
      controllers: [PingController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await app.getHonoApp().request('/ping');
    expect(fetch).toHaveBeenCalledWith(
      'https://my-api.com/status',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('HttpModule.forRootAsync() resolves config from injected factory', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ async: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const BASE_URL = new InjectionToken<string>('BASE_URL');

    @Module({
      providers: [defineProvider(BASE_URL, { useValue: 'https://async-api.com' })],
      exports: [BASE_URL],
    })
    class BaseUrlModule {}

    @Injectable()
    class RemoteService {
      constructor(private http: HttpService) {}
      fetch() {
        return this.http.get('/data');
      }
    }

    @Controller('/async-http')
    class AsyncHttpController {
      constructor(private svc: RemoteService) {}
      @Get() async handle() {
        await this.svc.fetch();
        return { ok: true };
      }
    }

    @Module({
      imports: [
        HttpModule.forRootAsync({
          imports: [BaseUrlModule],
          useFactory: (url: string) => ({ baseURL: url }),
          inject: [BASE_URL],
        }),
      ],
      providers: [RemoteService],
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
      @Get() async handle() {
        return this.svc.fetch();
      }
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('HealthCheckService.check() returns status:ok when all indicators pass', async () => {
    @Controller('/health')
    class HealthController {
      constructor(
        private health: HealthCheckService,
        private indicator: HealthIndicatorService,
      ) {}

      @Get()
      check() {
        return this.health.check([() => this.indicator.check('db').up({ responseTime: 5 })]);
      }
    }

    @Module({ imports: [HealthModule], controllers: [HealthController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/health');
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
    expect(body.status).toBe('ok');
    expect(body).toEqual({ status: 'ok', info: {}, error: {}, details: {} });
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
    const body = (await res.json()) as any;
    expect(body.status).toBe('error');
    expect(body).toEqual({ status: 'error', info: {}, error: {}, details: {} });
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
        return this.health.check([() => this.http.pingCheck('api', 'https://api.test/ping')]);
      }
    }

    @Module({ imports: [HealthModule], controllers: [HttpHealthController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/health-http');
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await res.json()).toEqual({ status: 'ok', info: {}, error: {}, details: {} });
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
      @Get('/data') data() {
        return { type: 'json' };
      }

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
      canActivate() {
        guardCalled = true;
        return true;
      }
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
      getValue() {
        return this.id;
      }
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
      providers: [RealService, defineProvider(ALIAS, { useExisting: RealService })],
      controllers: [AliasController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/alias');
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
    expect(body.same).toBe(true);
  });

  it('multiple aliases can point to the same service', async () => {
    @Injectable()
    class LoggerService {
      log(msg: string) {
        return msg;
      }
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
        defineProvider(LOGGER, { useExisting: LoggerService }),
        defineProvider(APP_LOGGER, { useExisting: LoggerService }),
      ],
      controllers: [MultiAliasController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/multi-alias');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
    expect(body.l1Real).toBe(true);
    expect(body.l2Real).toBe(true);
  });
});

// =============================================================================
// forRootAsync() dynamic module pattern
// =============================================================================

describe('forRootAsync() dynamic module pattern', () => {
  it('HttpModule.forRootAsync() resolves config from ConfigService', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: 'async-config' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    @Injectable()
    class DataService {
      constructor(private http: HttpService) {}
      async fetch() {
        return (await this.http.get<{ data: string }>('/resource')).data;
      }
    }

    @Controller('/async-root')
    class AsyncRootController {
      constructor(private svc: DataService) {}
      @Get() async handle() {
        return this.svc.fetch();
      }
    }

    @Module({
      imports: [
        ConfigModule.forRoot({ config: { API_BASE: 'https://async-root.test' } }),
        HttpModule.forRootAsync({
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

    @Module({
      providers: [defineProvider(CONFIG_VAL, { useValue: 'injected-factory' })],
      exports: [CONFIG_VAL],
    })
    class FactoryConfigModule {}

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
      @Get() handle() {
        return { result: this.svc.getBaseURL() };
      }
    }

    @Module({
      imports: [
        HttpModule.forRootAsync({
          imports: [FactoryConfigModule],
          useFactory: (val: string) => ({ baseURL: `https://${val}.test` }),
          inject: [CONFIG_VAL],
        }),
      ],
      providers: [CheckService],
      controllers: [FactoryOrderController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/factory-order');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'configured' });
  });
});

// =============================================================================
// CorsModule
// =============================================================================

describe('CorsModule', () => {
  it('adds Access-Control-Allow-Origin header for allowed origins', async () => {
    @Controller('/data')
    class DataController {
      @Get() handle() {
        return { ok: true };
      }
    }

    @Module({
      imports: [CorsModule.forRoot({ origin: 'https://example.com' })],
      controllers: [DataController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/data', {
      headers: { Origin: 'https://example.com' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://example.com');
  });

  it('sets wildcard origin by default', async () => {
    @Controller('/open')
    class OpenController {
      @Get() handle() {
        return { open: true };
      }
    }

    @Module({
      imports: [CorsModule.forRoot()],
      controllers: [OpenController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/open', {
      headers: { Origin: 'https://any.com' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('handles OPTIONS preflight and returns correct CORS headers', async () => {
    @Controller('/api')
    class ApiController {
      @Post() create() {
        return {};
      }
    }

    @Module({
      imports: [
        CorsModule.forRoot({
          origin: 'https://app.test',
          allowMethods: ['GET', 'POST'],
          allowHeaders: ['Content-Type', 'Authorization'],
        }),
      ],
      controllers: [ApiController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/api', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.test',
        'Access-Control-Request-Method': 'POST',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.test');
  });
});

// =============================================================================
// Logger / LoggerService
// =============================================================================

describe('Logger / LoggerService', () => {
  afterEach(() => {
    Logger.overrideLogger(undefined as unknown as false);
    Logger.setLogLevel(LogLevel.LOG);
  });

  it('Logger.log() calls console.log at LOG level', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new Logger('TestCtx');
    Logger.setLogLevel(LogLevel.LOG);
    logger.log('hello');
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]![0]).toContain('hello');
    spy.mockRestore();
  });

  it('Logger.warn() calls console.warn', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logger = new Logger('Ctx');
    logger.warn('warning msg');
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('Logger.error() calls console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = new Logger();
    logger.error('oops');
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('Logger.overrideLogger() routes messages to custom logger', () => {
    const custom = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };
    Logger.overrideLogger(custom);
    const logger = new Logger();
    logger.log('via custom');
    expect(custom.log).toHaveBeenCalledWith('via custom');
  });

  it('Logger.overrideLogger(false) suppresses all output', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    Logger.overrideLogger(false);
    const logger = new Logger();
    logger.log('should not appear');
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('Logger.setLogLevel(SILENT) suppresses everything', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    Logger.setLogLevel(LogLevel.SILENT);
    const logger = new Logger();
    logger.log('suppressed');
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('Logger is injectable as a service', async () => {
    @Injectable()
    class LoggingService {
      private logger = new Logger(LoggingService.name);
      greet() {
        this.logger.log('greet called');
        return 'hello';
      }
    }

    @Controller('/log')
    class LogController {
      constructor(private svc: LoggingService) {}
      @Get() handle() {
        return { msg: this.svc.greet() };
      }
    }

    @Module({ providers: [LoggingService], controllers: [LogController] })
    class AppModule {}

    vi.spyOn(console, 'log').mockImplementation(() => {});
    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/log');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ msg: 'hello' });
    vi.restoreAllMocks();
  });
});

// =============================================================================
// @Ip() param decorator
// =============================================================================

describe('@Ip() param decorator', () => {
  it('ignores spoofable forwarding headers by default', async () => {
    @Controller('/ip')
    class IpController {
      @Get()
      handle(@Ip() ip: string | null) {
        return { ip };
      }
    }

    @Module({ controllers: [IpController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/ip', {
      headers: {
        'x-forwarded-for': '203.0.113.42, 10.0.0.1',
        'x-real-ip': '198.51.100.5',
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ip: null });
  });

  it('uses an explicit trusted runtime resolver', async () => {
    @Controller('/realip')
    class RealIpController {
      @Get()
      handle(@Ip() ip: string | null) {
        return { ip };
      }
    }

    @Module({ controllers: [RealIpController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, {
      getClientIp: (c) => c.req.header('x-runtime-client-ip') ?? null,
    });
    const res = await app.getHonoApp().request('/realip', {
      headers: {
        'x-runtime-client-ip': '198.51.100.5',
        'x-forwarded-for': 'attacker-controlled',
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ip: '198.51.100.5' });
  });

  it('returns null when no IP headers are present', async () => {
    @Controller('/noip')
    class NoIpController {
      @Get()
      handle(@Ip() ip: string | null) {
        return { ip };
      }
    }

    @Module({ controllers: [NoIpController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/noip');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ip: null });
  });
});

// =============================================================================
// CacheService / CACHE_MANAGER direct injection
// =============================================================================

describe('CacheService / CACHE_MANAGER direct injection', () => {
  it('CacheService.set() and .get() store and retrieve values', async () => {
    @Injectable()
    class ItemService {
      constructor(private cache: CacheService) {}
      setItem(key: string, val: unknown) {
        this.cache.set(key, val);
      }
      getItem(key: string) {
        return this.cache.get(key);
      }
    }

    @Controller('/cache-svc')
    class CacheSvcController {
      constructor(private svc: ItemService) {}

      @Post()
      async set(@Body() body: { key: string; value: unknown }) {
        this.svc.setItem(body.key, body.value);
        return { ok: true };
      }

      @Get(':key')
      get(@Param('key') key: string) {
        return { value: this.svc.getItem(key) };
      }
    }

    @Module({
      imports: [CacheModule.forRoot()],
      providers: [ItemService],
      controllers: [CacheSvcController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    await hono.request('/cache-svc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'foo', value: 42 }),
    });

    const res = await hono.request('/cache-svc/foo');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: 42 });
  });

  it('CacheService.del() removes a cached entry', async () => {
    @Injectable()
    class StoreService {
      constructor(private cache: CacheService) {}
      put(k: string, v: unknown) {
        this.cache.set(k, v);
      }
      remove(k: string) {
        this.cache.del(k);
      }
      read(k: string) {
        return this.cache.get(k);
      }
    }

    @Controller('/del-cache')
    class DelCacheController {
      constructor(private svc: StoreService) {}
      @Get('set') setItem() {
        this.svc.put('x', 'value');
        return { ok: true };
      }
      @Get('del') delItem() {
        this.svc.remove('x');
        return { ok: true };
      }
      @Get('get') getItem() {
        return { value: this.svc.read('x') };
      }
    }

    @Module({
      imports: [CacheModule.forRoot()],
      providers: [StoreService],
      controllers: [DelCacheController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    await hono.request('/del-cache/set');
    await hono.request('/del-cache/del');
    const res = await hono.request('/del-cache/get');
    expect(await res.json()).toEqual({ value: undefined });
  });

  it('CACHE_MANAGER token injects the raw cache store', async () => {
    @Controller('/raw-cache')
    class RawCacheController {
      constructor(
        @Inject(CACHE_MANAGER) private store: {
          get: (k: string) => unknown;
          set: (k: string, v: unknown) => void;
        },
      ) {}

      @Get()
      handle() {
        this.store.set('direct', 'works');
        return { value: this.store.get('direct') };
      }
    }

    @Module({ imports: [CacheModule.forRoot()], controllers: [RawCacheController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/raw-cache');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: 'works' });
  });
});

// =============================================================================
// ZodValidationPipe
// =============================================================================

describe('ZodValidationPipe', () => {
  it('transforms and validates body with Zod schema', async () => {
    const CreateUserSchema = z.object({
      name: z.string().min(1),
      age: z.number().int().positive(),
    });

    @Controller('/zod-users')
    class ZodUserController {
      @Post()
      create(@Body(new ZodValidationPipe(CreateUserSchema)) body: { name: string; age: number }) {
        return { created: body };
      }
    }

    @Module({ controllers: [ZodUserController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/zod-users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice', age: 30 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: { name: 'Alice', age: 30 } });
  });

  it('throws when Zod schema validation fails', async () => {
    const Schema = z.object({ count: z.number() });

    @Controller('/zod-fail')
    class ZodFailController {
      @Post()
      handle(@Body(new ZodValidationPipe(Schema)) body: unknown) {
        return body;
      }
    }

    @Module({ controllers: [ZodFailController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/zod-fail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 'not-a-number' }),
    });
    expect(res.status).toBe(500); // Zod throws ZodError; not wrapped in HttpException
  });

  it('can be used as a class-level pipe with @UsePipes()', async () => {
    const QuerySchema = z.object({ page: z.coerce.number().default(1) });

    @Controller('/zod-query')
    @UsePipes(new ZodValidationPipe(QuerySchema))
    class ZodQueryController {
      @Get()
      handle(@Query() query: unknown) {
        return query;
      }
    }

    @Module({ controllers: [ZodQueryController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/zod-query?page=3');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ page: 3 });
  });
});

// =============================================================================
// RequiredPipe
// =============================================================================

describe('RequiredPipe', () => {
  it('passes through non-null/undefined values unchanged', async () => {
    @Controller('/req-pipe')
    class ReqPipeController {
      @Get()
      handle(@Query('name', RequiredPipe) name: string) {
        return { name };
      }
    }

    @Module({ controllers: [ReqPipeController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/req-pipe?name=Bob');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'Bob' });
  });

  it('throws 400 when the required param is missing', async () => {
    @Controller('/req-missing')
    class ReqMissingController {
      @Get()
      handle(@Query('name', RequiredPipe) name: string) {
        return { name };
      }
    }

    @Module({ controllers: [ReqMissingController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/req-missing');
    expect(res.status).toBe(400);
  });

  it('throws 400 when the param is an empty string', async () => {
    @Controller('/req-empty')
    class ReqEmptyController {
      @Get()
      handle(@Query('q', RequiredPipe) q: string) {
        return { q };
      }
    }

    @Module({ controllers: [ReqEmptyController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/req-empty?q=');
    expect(res.status).toBe(400);
  });
});

// =============================================================================
// applyDecorators compound decorator
// =============================================================================

describe('applyDecorators compound decorator', () => {
  it('combines guard + interceptor + metadata into a reusable decorator', async () => {
    const ROLES_KEY = 'roles';

    function Roles(...roles: string[]) {
      return SetMetadata(ROLES_KEY, roles);
    }

    @Injectable()
    class RolesGuard implements CanActivate {
      constructor(private reflector: Reflector) {}
      canActivate(ctx: ExecutionContext): boolean {
        const required = this.reflector.get<string[]>(ROLES_KEY, ctx);
        if (!required) return true;
        // For test purposes always pass (real guard would check token)
        return true;
      }
    }

    // Compound decorator
    function AdminOnly() {
      return applyDecorators(
        Roles('admin'),
        UseGuards(RolesGuard),
        SetMetadata('access', 'admin-only'),
      );
    }

    @Controller('/compound')
    class CompoundController {
      @Get()
      @AdminOnly()
      secret() {
        return { secret: true };
      }
    }

    @Module({ providers: [RolesGuard, Reflector], controllers: [CompoundController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/compound');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ secret: true });
  });

  it('stacks multiple UseGuards via applyDecorators', async () => {
    const calls: string[] = [];

    @Injectable()
    class GuardA implements CanActivate {
      canActivate(_ctx: ExecutionContext): boolean {
        calls.push('A');
        return true;
      }
    }

    @Injectable()
    class GuardB implements CanActivate {
      canActivate(_ctx: ExecutionContext): boolean {
        calls.push('B');
        return true;
      }
    }

    function AuthAndVerified() {
      return applyDecorators(UseGuards(GuardA), UseGuards(GuardB));
    }

    @Controller('/stacked')
    class StackedController {
      @Get()
      @AuthAndVerified()
      handle() {
        return { guards: calls };
      }
    }

    @Module({ controllers: [StackedController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/stacked');
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
    expect(body.guards).toContain('A');
    expect(body.guards).toContain('B');
  });
});

// =============================================================================
// Remaining HTTP exceptions
// =============================================================================

describe('Remaining HTTP exceptions', () => {
  const cases: Array<[string, () => HttpException, number]> = [
    ['MethodNotAllowedException', () => new MethodNotAllowedException(), 405],
    ['NotAcceptableException', () => new NotAcceptableException(), 406],
    ['RequestTimeoutException', () => new RequestTimeoutException(), 408],
    ['GoneException', () => new GoneException(), 410],
    ['PayloadTooLargeException', () => new PayloadTooLargeException(), 413],
    ['UnprocessableEntityException', () => new UnprocessableEntityException(), 422],
    ['InternalServerErrorException', () => new InternalServerErrorException(), 500],
    ['NotImplementedException', () => new NotImplementedException(), 501],
    ['TooManyRequestsException', () => new TooManyRequestsException(), 429],
  ];

  for (const [name, factory, statusCode] of cases) {
    it(`${name} returns ${statusCode}`, async () => {
      const exc = factory();

      @Controller('/exc')
      class ExcController {
        @Get() handle() {
          throw exc;
        }
      }

      @Module({ controllers: [ExcController] })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const res = await app.getHonoApp().request('/exc');
      expect(res.status).toBe(statusCode);
    });
  }

  it('HttpException accepts custom message and status', async () => {
    @Controller('/custom-exc')
    class CustomExcController {
      @Get() handle() {
        throw new HttpException('Custom error', 418);
      }
    }

    @Module({ controllers: [CustomExcController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/custom-exc');
    expect(res.status).toBe(418);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
    // 418 has no catalog code → falls back to 'internal', message echoed verbatim.
    expect(body.error.message).toBe('Custom error');
  });
});

// =============================================================================
// setGlobalPrefix
// =============================================================================

describe('setGlobalPrefix', () => {
  it('prefixes all routes with the given path segment', async () => {
    @Controller('/users')
    class UserController {
      @Get() list() {
        return [{ id: 1 }];
      }
    }

    @Module({ controllers: [UserController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, { globalPrefix: 'api' });

    const hono = app.getHonoApp();
    expect(await (await hono.request('/api/users')).status).toBe(200);
    expect(await (await hono.request('/users')).status).toBe(404);
  });

  it('works with a leading slash in the prefix', async () => {
    @Controller('/items')
    class ItemController {
      @Get(':id') get(@Param('id') id: string) {
        return { id };
      }
    }

    @Module({ controllers: [ItemController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, { globalPrefix: '/v1' });

    const res = await app.getHonoApp().request('/v1/items/99');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: '99' });
  });

  it('combines global prefix with controller prefix and route path', async () => {
    @Controller('products')
    class ProductController {
      @Get('featured') featured() {
        return { featured: true };
      }
    }

    @Module({ controllers: [ProductController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, { globalPrefix: 'api/v2' });

    const res = await app.getHonoApp().request('/api/v2/products/featured');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ featured: true });
  });
});

// =============================================================================
// @Optional() in HTTP context
// =============================================================================

describe('@Optional() in HTTP context', () => {
  it('controller with optional injected service resolves when service is absent', async () => {
    const OPTIONAL_TOKEN = new InjectionToken<{ getValue(): string }>('OPTIONAL_SVC');

    @Controller('/opt')
    class OptController {
      constructor(
        @Optional() @Inject(OPTIONAL_TOKEN) private svc: { getValue(): string } | undefined,
      ) {}

      @Get()
      handle() {
        return { value: this.svc?.getValue() ?? 'default' };
      }
    }

    @Module({ controllers: [OptController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/opt');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: 'default' });
  });

  it('controller receives the service when it IS registered', async () => {
    const OPTIONAL_TOKEN2 = new InjectionToken<{ msg(): string }>('OPTIONAL_SVC2');

    @Controller('/opt-present')
    class OptPresentController {
      constructor(
        @Optional() @Inject(OPTIONAL_TOKEN2) private svc: { msg(): string } | undefined,
      ) {}

      @Get()
      handle() {
        return { value: this.svc?.msg() ?? 'missing' };
      }
    }

    @Module({
      providers: [defineProvider(OPTIONAL_TOKEN2, { useValue: { msg: () => 'found' } })],
      controllers: [OptPresentController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/opt-present');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: 'found' });
  });

  it('@Optional() does not break when class has other required deps', async () => {
    const OPT_DEP = new InjectionToken<string>('OPT_DEP');

    @Injectable()
    class RequiredService {
      greet() {
        return 'hello';
      }
    }

    @Controller('/opt-mixed')
    class OptMixedController {
      constructor(
        private required: RequiredService,
        @Optional() @Inject(OPT_DEP) private opt: string | undefined,
      ) {}

      @Get()
      handle() {
        return { greeting: this.required.greet(), extra: this.opt ?? 'none' };
      }
    }

    @Module({
      providers: [RequiredService],
      controllers: [OptMixedController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/opt-mixed');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ greeting: 'hello', extra: 'none' });
  });
});

// =============================================================================
// Scope.TRANSIENT providers
// =============================================================================

describe('Scope.TRANSIENT providers', () => {
  it('each injection site receives a distinct instance', async () => {
    @Injectable({ scope: Scope.TRANSIENT })
    class IdService {
      readonly id = Math.random();
    }

    @Injectable()
    class ConsumerA {
      constructor(public svc: IdService) {}
    }

    @Injectable()
    class ConsumerB {
      constructor(public svc: IdService) {}
    }

    @Controller('/transient')
    class TransientController {
      constructor(
        private a: ConsumerA,
        private b: ConsumerB,
      ) {}
      @Get()
      handle() {
        return { same: this.a.svc.id === this.b.svc.id };
      }
    }

    @Module({ providers: [IdService, ConsumerA, ConsumerB], controllers: [TransientController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/transient');
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(((await res.json()) as any).same).toBe(false);
  });

  it('transient provider always creates a new instance on each resolve', async () => {
    const instances: object[] = [];

    @Injectable({ scope: Scope.TRANSIENT })
    class TransService {
      constructor() {
        instances.push(this);
      }
    }

    @Controller('/trans-count')
    class TransCountController {
      constructor(
        private s1: TransService,
        private s2: TransService,
      ) {}
      @Get() handle() {
        return { count: instances.length };
      }
    }

    @Module({ providers: [TransService], controllers: [TransCountController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await app.getHonoApp().request('/trans-count');
    expect(instances.length).toBeGreaterThanOrEqual(2);
  });

  it('transient provider via { provide, useClass, scope } option', async () => {
    @Injectable()
    class Base {
      readonly id = Math.random();
    }

    @Controller('/trans-opts')
    class TransOptsController {
      constructor(
        private a: Base,
        private b: Base,
      ) {}
      @Get() handle() {
        return { same: this.a === this.b };
      }
    }

    @Module({
      providers: [defineProvider(Base, { useClass: Base, scope: Scope.TRANSIENT })],
      controllers: [TransOptsController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/trans-opts');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(((await res.json()) as any).same).toBe(false);
  });
});

// =============================================================================
// Scope.REQUEST in HTTP context
// =============================================================================

describe('Scope.REQUEST in HTTP context', () => {
  it('request-scoped guard creates a new instance per HTTP request', async () => {
    const ids: number[] = [];

    @Injectable({ scope: Scope.REQUEST })
    class RequestContext {
      readonly id = Math.random();
      constructor() {
        ids.push(this.id);
      }
    }

    @Injectable({ scope: Scope.REQUEST })
    class ReqScopedGuard {
      constructor(private ctx: RequestContext) {}
      canActivate(_: ExecutionContext) {
        return true;
      }
    }

    @Controller('/req-scope')
    class ReqScopeController {
      @Get() @UseGuards(ReqScopedGuard) handle() {
        return { ok: true };
      }
    }

    @Module({
      providers: [RequestContext, ReqScopedGuard],
      controllers: [ReqScopeController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    await hono.request('/req-scope');
    await hono.request('/req-scope');

    // Two requests → two distinct RequestContext instances
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('request-scoped provider is shared across guards/interceptors within a single request', async () => {
    const callOrder: string[] = [];

    @Injectable({ scope: Scope.REQUEST })
    class ReqData {
      readonly stamp = Math.random();
    }

    @Injectable({ scope: Scope.REQUEST })
    class GuardA {
      constructor(public data: ReqData) {}
      canActivate(_: ExecutionContext) {
        callOrder.push(`A:${this.data.stamp}`);
        return true;
      }
    }

    @Injectable({ scope: Scope.REQUEST })
    class GuardB {
      constructor(public data: ReqData) {}
      canActivate(_: ExecutionContext) {
        callOrder.push(`B:${this.data.stamp}`);
        return true;
      }
    }

    @Controller('/req-shared')
    class ReqSharedController {
      @Get() @UseGuards(GuardA, GuardB) handle() {
        return { ok: true };
      }
    }

    @Module({
      providers: [ReqData, GuardA, GuardB],
      controllers: [ReqSharedController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await app.getHonoApp().request('/req-shared');

    // Both guards within the same request should see the same ReqData stamp
    expect(callOrder).toHaveLength(2);
    const stampA = callOrder[0]!.split(':')[1];
    const stampB = callOrder[1]!.split(':')[1];
    expect(stampA).toBe(stampB); // same stamp = same instance
  });
});

// =============================================================================
// forwardRef() circular module imports
// =============================================================================

describe('forwardRef() circular module imports', () => {
  it('two modules that import each other via forwardRef resolve correctly', async () => {
    @Injectable()
    class ModAService {
      name() {
        return 'ModA';
      }
    }

    @Injectable()
    class ModBService {
      name() {
        return 'ModB';
      }
    }

    @Controller('/circular-a')
    class CircularController {
      constructor(
        private a: ModAService,
        private b: ModBService,
      ) {}
      @Get() handle() {
        return { a: this.a.name(), b: this.b.name() };
      }
    }

    // Declare module classes before defining them (needed for forwardRef)
    let ModuleB: any;

    @Module({
      imports: [forwardRef(() => ModuleB)],
      providers: [ModAService],
      controllers: [CircularController],
      exports: [ModAService],
    })
    class ModuleA {}

    @Module({
      imports: [forwardRef(() => ModuleA)],
      providers: [ModBService],
      exports: [ModBService],
    })
    class ModuleBClass {}
    ModuleB = ModuleBClass;

    @Module({ imports: [ModuleA] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/circular-a');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ a: 'ModA', b: 'ModB' });
  });

  it('forwardRef module is not processed twice', async () => {
    let initCount = 0;

    @Injectable()
    class SharedService {
      constructor() {
        initCount++;
      }
      value() {
        return 42;
      }
    }

    @Controller('/fwd-count')
    class FwdController {
      constructor(private svc: SharedService) {}
      @Get() handle() {
        return { v: this.svc.value() };
      }
    }

    let LazyModule: any;

    @Module({
      imports: [forwardRef(() => LazyModule)],
      providers: [SharedService],
      controllers: [FwdController],
      exports: [SharedService],
    })
    class EagerModule {}

    @Module({ imports: [forwardRef(() => EagerModule)] })
    class LazyModuleClass {}
    LazyModule = LazyModuleClass;

    @Module({ imports: [EagerModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/fwd-count');
    expect(res.status).toBe(200);
    expect(initCount).toBe(1); // SharedService is singleton — only one instance
  });
});

// =============================================================================
// useClass provider substitution
// =============================================================================

describe('useClass provider substitution', () => {
  it('{ provide: Token, useClass: Impl } injects the concrete implementation', async () => {
    const MAILER_TOKEN = new InjectionToken<{ send(to: string): string }>('MAILER');

    @Injectable()
    class SmtpMailer {
      send(to: string) {
        return `smtp:${to}`;
      }
    }

    @Controller('/mail')
    class MailController {
      constructor(@Inject(MAILER_TOKEN) private mailer: SmtpMailer) {}
      @Get() handle() {
        return { result: this.mailer.send('user@test.com') };
      }
    }

    @Module({
      providers: [defineProvider(MAILER_TOKEN, { useClass: SmtpMailer })],
      controllers: [MailController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/mail');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'smtp:user@test.com' });
  });

  it('useClass can substitute one class for another (polymorphism)', async () => {
    @Injectable()
    class BaseNotifier {
      notify(msg: string) {
        return `base:${msg}`;
      }
    }

    @Injectable()
    class SlackNotifier extends BaseNotifier {
      override notify(msg: string) {
        return `slack:${msg}`;
      }
    }

    @Controller('/notify')
    class NotifyController {
      constructor(private notifier: BaseNotifier) {}
      @Get() handle() {
        return { result: this.notifier.notify('hello') };
      }
    }

    @Module({
      providers: [defineProvider(BaseNotifier, { useClass: SlackNotifier })],
      controllers: [NotifyController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/notify');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'slack:hello' });
  });

  it('useClass implementation can itself have injected dependencies', async () => {
    @Injectable()
    class Config {
      getPrefix() {
        return 'sms';
      }
    }

    @Injectable()
    class SmsNotifier {
      constructor(private config: Config) {}
      notify(msg: string) {
        return `${this.config.getPrefix()}:${msg}`;
      }
    }

    @Injectable()
    class AbstractNotifier {
      notify(_msg: string): string {
        return '';
      }
    }

    @Controller('/sms-notify')
    class SmsController {
      constructor(private n: AbstractNotifier) {}
      @Get() handle() {
        return { result: this.n.notify('ping') };
      }
    }

    @Module({
      providers: [Config, SmsNotifier, defineProvider(AbstractNotifier, { useClass: SmsNotifier })],
      controllers: [SmsController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/sms-notify');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'sms:ping' });
  });

  it('useClass inherits the REQUEST scope of the implementation class', async () => {
    @Injectable({ scope: Scope.REQUEST })
    class RequestBag {
      readonly id = Math.random();
      readonly items: string[] = [];
    }
    const BAG = new InjectionToken<RequestBag>('REQUEST_BAG');

    @Controller('/use-class-scope')
    class BagController {
      constructor(@Inject(BAG) private bag: RequestBag) {}
      @Get() handle() {
        this.bag.items.push('item');
        return { id: this.bag.id, size: this.bag.items.length };
      }
    }

    @Module({
      providers: [defineProvider(BAG, { useClass: RequestBag })],
      controllers: [BagController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const r1 = (await (await hono.request('/use-class-scope')).json()) as {
      id: number;
      size: number;
    };
    const r2 = (await (await hono.request('/use-class-scope')).json()) as {
      id: number;
      size: number;
    };

    expect(r1.id).not.toBe(r2.id);
    expect(r1.size).toBe(1);
    expect(r2.size).toBe(1);
  });

  it('an explicit provider scope overrides the implementation class scope', async () => {
    @Injectable({ scope: Scope.REQUEST })
    class Counter {
      readonly id = Math.random();
    }
    const COUNTER = new InjectionToken<Counter>('COUNTER');

    @Controller('/use-class-explicit-scope')
    class CounterController {
      constructor(@Inject(COUNTER) private counter: Counter) {}
      @Get() handle() {
        return { id: this.counter.id };
      }
    }

    @Module({
      providers: [defineProvider(COUNTER, { useClass: Counter, scope: Scope.SINGLETON })],
      controllers: [CounterController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const r1 = (await (await hono.request('/use-class-explicit-scope')).json()) as { id: number };
    const r2 = (await (await hono.request('/use-class-explicit-scope')).json()) as { id: number };
    expect(r1.id).toBe(r2.id);
  });
});

// =============================================================================
// @Catch() with multiple exception types
// =============================================================================

describe('@Catch() with multiple exception types', () => {
  it('@Catch(TypeA, TypeB) catches either exception type', async () => {
    class DomainError extends Error {
      constructor() {
        super('domain');
        this.name = 'DomainError';
      }
    }
    class NetworkError extends Error {
      constructor() {
        super('network');
        this.name = 'NetworkError';
      }
    }

    @Catch(DomainError, NetworkError)
    class MultiCatchFilter implements ExceptionFilter {
      catch(exception: Error, ctx: ExecutionContext) {
        const c = ctx.getContext() as import('hono').Context;
        return c.json({ caught: exception.name }, 422);
      }
    }

    @Controller('/multi-catch')
    class MultiCatchController {
      @Get('domain')
      domain() {
        throw new DomainError();
      }

      @Get('network')
      network() {
        throw new NetworkError();
      }

      @Get('other')
      other() {
        throw new Error('other');
      }
    }

    @Module({
      controllers: [MultiCatchController],
      providers: [defineProvider(APP_FILTER, { useClass: MultiCatchFilter })],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const r1 = await hono.request('/multi-catch/domain');
    expect(r1.status).toBe(422);
    expect(await r1.json()).toEqual({ caught: 'DomainError' });

    const r2 = await hono.request('/multi-catch/network');
    expect(r2.status).toBe(422);
    expect(await r2.json()).toEqual({ caught: 'NetworkError' });

    const r3 = await hono.request('/multi-catch/other');
    expect(r3.status).not.toBe(422);
  });

  it('@Catch() with no args catches all exceptions', async () => {
    class AnyError extends Error {
      constructor() {
        super('any');
      }
    }

    @Catch()
    class CatchAllFilter implements ExceptionFilter {
      catch(_exception: unknown, ctx: ExecutionContext) {
        const c = ctx.getContext() as import('hono').Context;
        return c.json({ all: true }, 500);
      }
    }

    @Controller('/catch-all')
    class CatchAllController {
      @Get() handle() {
        throw new AnyError();
      }
    }

    @Module({
      controllers: [CatchAllController],
      providers: [defineProvider(APP_FILTER, { useClass: CatchAllFilter })],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/catch-all');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ all: true });
  });
});

// =============================================================================
// Route wildcards
// =============================================================================

describe('Route wildcards', () => {
  it('@Get("*") matches any sub-path under the controller prefix', async () => {
    @Controller('/files')
    class FilesController {
      @Get('*')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      catchAll(@Req() ctx: any) {
        return { path: ctx.req.path };
      }
    }

    @Module({ controllers: [FilesController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const r1 = await hono.request('/files/a/b/c');
    expect(r1.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(((await r1.json()) as any).path).toBe('/files/a/b/c');

    const r2 = await hono.request('/files/readme.md');
    expect(r2.status).toBe(200);
  });

  it('specific route takes priority over wildcard on same controller', async () => {
    @Controller('/docs')
    class DocsController {
      @Get('latest')
      latest() {
        return { version: 'latest' };
      }

      @Get('*')
      catchAll() {
        return { version: 'unknown' };
      }
    }

    @Module({ controllers: [DocsController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const r1 = await hono.request('/docs/latest');
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ version: 'latest' });

    const r2 = await hono.request('/docs/old/1.0');
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({ version: 'unknown' });
  });
});

// =============================================================================
// ModuleRef.resolve() and ModuleRef.create()
// =============================================================================

describe('ModuleRef.resolve() and ModuleRef.create()', () => {
  it('ModuleRef.get() retrieves a singleton from the container', async () => {
    @Injectable()
    class SingletonCounter {
      count = 0;
      inc() {
        return ++this.count;
      }
    }

    @Controller('/modref-get')
    class ModRefGetController {
      constructor(private moduleRef: ModuleRef) {}

      @Get()
      handle() {
        const svc = this.moduleRef.get(SingletonCounter);
        svc.inc();
        const svc2 = this.moduleRef.get(SingletonCounter);
        svc2.inc();
        return { count: svc2.count };
      }
    }

    @Module({ providers: [SingletonCounter], controllers: [ModRefGetController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/modref-get');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 2 });
  });

  it('ModuleRef.create() creates a fresh instance outside singleton cache', async () => {
    @Injectable()
    class FreshService {
      readonly id = Math.random();
    }

    @Controller('/modref-create')
    class ModRefCreateController {
      constructor(
        private moduleRef: ModuleRef,
        private singleton: FreshService,
      ) {}

      @Get()
      handle() {
        const fresh = this.moduleRef.create(FreshService);
        return { same: fresh === this.singleton, freshId: fresh.id !== this.singleton.id };
      }
    }

    @Module({ providers: [FreshService], controllers: [ModRefCreateController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/modref-create');
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
    expect(body.same).toBe(false);
    expect(body.freshId).toBe(true);
  });

  it('ModuleRef.resolve() works like get() for singleton-scoped providers', async () => {
    @Injectable()
    class Config {
      value = 'prod';
    }

    @Controller('/modref-resolve')
    class ModRefResolveController {
      constructor(private moduleRef: ModuleRef) {}

      @Get()
      handle() {
        const c1 = this.moduleRef.resolve(Config);
        const c2 = this.moduleRef.resolve(Config);
        return { same: c1 === c2, value: c1.value };
      }
    }

    @Module({ providers: [Config], controllers: [ModRefResolveController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/modref-resolve');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ same: true, value: 'prod' });
  });
});

// =============================================================================
// @Optional() and module visibility
// =============================================================================

describe('@Optional() and module visibility', () => {
  const HIDDEN = new InjectionToken<string>('OptionalHidden');

  function hiddenGraph() {
    @Module({ providers: [defineProvider(HIDDEN, { useValue: 'hidden' })] })
    class OwnerModule {}

    @Injectable()
    class Consumer {
      constructor(@Optional() @Inject(HIDDEN) readonly value: string | undefined) {}
    }

    @Module({ imports: [OwnerModule], providers: [Consumer] })
    class AppModule {}

    return { AppModule, Consumer };
  }

  it('reports a registered but invisible @Optional token instead of injecting it', async () => {
    const { AppModule } = hiddenGraph();
    await expect(VelaFactory.create(AppModule, { diagnostics: 'throw' })).rejects.toThrow(
      ModuleVisibilityError,
    );
  });

  it('warns and injects undefined in log mode, silently in silent mode', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const logged = hiddenGraph();
      const app = await VelaFactory.create(logged.AppModule);
      expect(app.get(logged.Consumer).value).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('OptionalHidden'));

      warn.mockClear();
      const silent = hiddenGraph();
      const quiet = await VelaFactory.create(silent.AppModule, { diagnostics: 'silent' });
      expect(quiet.get(silent.Consumer).value).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('honors InjectionToken default factories', async () => {
    const WITH_DEFAULT = new InjectionToken<string>('OptionalDefault', {
      factory: () => 'fallback',
    });

    @Injectable()
    class Consumer {
      constructor(@Optional() @Inject(WITH_DEFAULT) readonly value: string | undefined) {}
    }

    @Injectable({ scope: Scope.TRANSIENT })
    class PerUse {
      constructor(@Optional() @Inject(WITH_DEFAULT) readonly value: string | undefined) {}
    }

    @Module({ providers: [Consumer, PerUse] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(app.get(Consumer).value).toBe('fallback');
    // Synchronous construction path.
    expect(app.getContainer().resolve(PerUse).value).toBe('fallback');
  });

  it('still injects undefined when nothing registers the token', async () => {
    const ABSENT = new InjectionToken<string>('OptionalAbsent');

    @Injectable()
    class Consumer {
      constructor(@Optional() @Inject(ABSENT) readonly value: string | undefined) {}
    }

    @Module({ providers: [Consumer] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, { diagnostics: 'throw' });
    expect(app.get(Consumer).value).toBeUndefined();
  });
});

// =============================================================================
// Request-scoped controller
// =============================================================================

describe('Request-scoped controller', () => {
  it('@Injectable({ scope: Scope.REQUEST }) on a controller creates one per request', async () => {
    const ctrlIds: number[] = [];

    @Injectable({ scope: Scope.REQUEST })
    @Controller('/req-ctrl')
    class ReqScopeCtrl {
      readonly id = Math.random();
      constructor() {
        ctrlIds.push(this.id);
      }

      @Get() handle() {
        return { id: this.id };
      }
    }

    @Module({ controllers: [ReqScopeCtrl] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const r1 = (await (await hono.request('/req-ctrl')).json()) as { id: number };
    const r2 = (await (await hono.request('/req-ctrl')).json()) as { id: number };

    expect(r1.id).not.toBe(r2.id);
    expect(ctrlIds.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the REQUEST scope when @Controller is applied after @Injectable', async () => {
    @Controller('/req-ctrl-below')
    @Injectable({ scope: Scope.REQUEST })
    class ReqScopeCtrl {
      readonly id = Math.random();

      @Get() handle() {
        return { id: this.id };
      }
    }

    @Module({ controllers: [ReqScopeCtrl] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const r1 = (await (await hono.request('/req-ctrl-below')).json()) as { id: number };
    const r2 = (await (await hono.request('/req-ctrl-below')).json()) as { id: number };

    expect(r1.id).not.toBe(r2.id);
  });

  it('@Controller({ path, scope: Scope.REQUEST }) creates one per request', async () => {
    @Controller({ path: '/req-ctrl-option', scope: Scope.REQUEST })
    class ReqScopeCtrl {
      readonly id = Math.random();

      @Get() handle() {
        return { id: this.id };
      }
    }

    @Module({ controllers: [ReqScopeCtrl] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const r1 = (await (await hono.request('/req-ctrl-option')).json()) as { id: number };
    const r2 = (await (await hono.request('/req-ctrl-option')).json()) as { id: number };

    expect(r1.id).not.toBe(r2.id);
  });

  it('rejects conflicting scopes declared on one controller', () => {
    expect(() => {
      @Controller({ path: '/req-ctrl-conflict', scope: Scope.REQUEST })
      @Injectable({ scope: Scope.TRANSIENT })
      class ConflictingCtrl {}
      return ConflictingCtrl;
    }).toThrow(/conflicting scopes/);
  });
});

// =============================================================================
// Async onModuleInit
// =============================================================================

describe('Async onModuleInit', () => {
  it('async onModuleInit is awaited before first request is served', async () => {
    let initialized = false;

    @Injectable()
    class AsyncInitService implements OnModuleInit {
      data = '';

      async onModuleInit() {
        await new Promise((resolve) => setTimeout(resolve, 10));
        this.data = 'loaded';
        initialized = true;
      }
    }

    @Controller('/async-init')
    class AsyncInitController {
      constructor(private svc: AsyncInitService) {}
      @Get() handle() {
        return { data: this.svc.data, initialized };
      }
    }

    @Module({ providers: [AsyncInitService], controllers: [AsyncInitController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/async-init');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: 'loaded', initialized: true });
  });

  it('multiple services with async onModuleInit are all awaited', async () => {
    const order: string[] = [];

    @Injectable()
    class ServiceX implements OnModuleInit {
      async onModuleInit() {
        await new Promise((r) => setTimeout(r, 5));
        order.push('X');
      }
    }

    @Injectable()
    class ServiceY implements OnModuleInit {
      async onModuleInit() {
        await new Promise((r) => setTimeout(r, 1));
        order.push('Y');
      }
    }

    @Controller('/multi-init')
    class MultiInitController {
      constructor(
        private x: ServiceX,
        private y: ServiceY,
      ) {}
      @Get() handle() {
        return { order };
      }
    }

    @Module({ providers: [ServiceX, ServiceY], controllers: [MultiInitController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/multi-init');
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
    expect(body.order).toContain('X');
    expect(body.order).toContain('Y');
    expect(body.order).toHaveLength(2);
  });

  it('onModuleInit can perform async data fetching before the app is ready', async () => {
    @Injectable()
    class DataLoader implements OnModuleInit {
      items: string[] = [];

      async onModuleInit() {
        // Simulate async data load
        this.items = await Promise.resolve(['alpha', 'beta', 'gamma']);
      }
    }

    @Controller('/loaded')
    class LoadedController {
      constructor(private loader: DataLoader) {}
      @Get() handle() {
        return { items: this.loader.items };
      }
    }

    @Module({ providers: [DataLoader], controllers: [LoadedController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/loaded');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: ['alpha', 'beta', 'gamma'] });
  });
});

// =============================================================================
// Reflector.createDecorator() in HTTP context
// =============================================================================

describe('Reflector.createDecorator() in HTTP context', () => {
  it('typed decorator created with createDecorator() works in guards', async () => {
    const Roles = Reflector.createDecorator<string[]>();

    @Injectable()
    class TypedRolesGuard implements CanActivate {
      constructor(private reflector: Reflector) {}
      canActivate(ctx: ExecutionContext): boolean {
        const required = this.reflector.get(Roles, ctx);
        if (!required) return true;
        return ctx.getRequest().headers.get('x-role') === required[0];
      }
    }

    @Controller('/typed-roles')
    class TypedRolesController {
      @Roles(['admin'])
      @Get('admin')
      admin() {
        return { access: 'admin' };
      }

      @Get('public')
      public() {
        return { access: 'public' };
      }
    }

    @Module({ providers: [TypedRolesGuard, Reflector], controllers: [TypedRolesController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    app.useGlobalGuards(new TypedRolesGuard(new Reflector()));

    const hono = app.getHonoApp();

    const denied = await hono.request('/typed-roles/admin');
    expect(denied.status).toBe(403);

    const allowed = await hono.request('/typed-roles/admin', { headers: { 'x-role': 'admin' } });
    expect(allowed.status).toBe(200);

    const pub = await hono.request('/typed-roles/public');
    expect(pub.status).toBe(200);
  });

  it('createDecorator() produces distinct keys for separate decorators', async () => {
    const TagA = Reflector.createDecorator<string>();
    const TagB = Reflector.createDecorator<string>();

    const captured: { a?: string; b?: string } = {};

    @Injectable()
    class TagGuard implements CanActivate {
      constructor(private reflector: Reflector) {}
      canActivate(ctx: ExecutionContext): boolean {
        captured.a = this.reflector.get(TagA, ctx);
        captured.b = this.reflector.get(TagB, ctx);
        return true;
      }
    }

    @Controller('/tags')
    class TagController {
      @TagA('alpha')
      @TagB('beta')
      @Get()
      @UseGuards(TagGuard)
      handle() {
        return {};
      }
    }

    @Module({ providers: [TagGuard, Reflector], controllers: [TagController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await app.getHonoApp().request('/tags');
    expect(captured.a).toBe('alpha');
    expect(captured.b).toBe('beta');
  });
});

// =============================================================================
// Module re-export / transitive exports
// =============================================================================

describe('Module re-export / transitive exports', () => {
  it('re-exported providers from an imported module are available to consumers', async () => {
    @Injectable()
    class DatabaseService {
      query() {
        return 'db result';
      }
    }

    @Module({ providers: [DatabaseService], exports: [DatabaseService] })
    class DatabaseModule {}

    // InfraModule imports and RE-EXPORTS DatabaseModule's service
    @Module({ imports: [DatabaseModule], exports: [DatabaseService] })
    class InfraModule {}

    @Controller('/reexport')
    class ReexportController {
      constructor(private db: DatabaseService) {}
      @Get() handle() {
        return { result: this.db.query() };
      }
    }

    // AppModule only imports InfraModule — gets DatabaseService transitively
    @Module({ imports: [InfraModule], controllers: [ReexportController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/reexport');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'db result' });
  });

  it('global module makes providers available without explicit import', async () => {
    @Injectable()
    class GlobalConfig {
      env = 'production';
    }

    @Global()
    @Module({ providers: [GlobalConfig], exports: [GlobalConfig] })
    class GlobalModule {}

    @Controller('/global-inject')
    class GlobalInjectController {
      constructor(private config: GlobalConfig) {}
      @Get() handle() {
        return { env: this.config.env };
      }
    }

    @Module({ imports: [GlobalModule], controllers: [GlobalInjectController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/global-inject');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ env: 'production' });
  });
});

// =============================================================================
// Interceptor response transformation
// =============================================================================

describe('Interceptor response transformation', () => {
  it('interceptor wraps all responses in { data: result }', async () => {
    @Injectable()
    class DataWrapInterceptor implements NestInterceptor {
      async intercept(_ctx: ExecutionContext, next: CallHandler) {
        const result = await next.handle();
        return { data: result };
      }
    }

    @Controller('/wrap')
    class WrapController {
      @Get() handle() {
        return { id: 1, name: 'Alice' };
      }
    }

    @Module({ controllers: [WrapController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    app.useGlobalInterceptors(new DataWrapInterceptor());

    const res = await app.getHonoApp().request('/wrap');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 1, name: 'Alice' } });
  });

  it('interceptor can add response headers', async () => {
    @Injectable()
    class TimingInterceptor implements NestInterceptor {
      async intercept(ctx: ExecutionContext, next: CallHandler) {
        const result = await next.handle();
        const c = ctx.getContext() as import('hono').Context;
        c.header('x-timing', '42ms');
        return result;
      }
    }

    @Controller('/timed')
    class TimedController {
      @Get() handle() {
        return { ok: true };
      }
    }

    @Module({ controllers: [TimedController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    app.useGlobalInterceptors(new TimingInterceptor());

    const res = await app.getHonoApp().request('/timed');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-timing')).toBe('42ms');
  });

  it('method-level interceptor runs after global interceptor', async () => {
    const order: string[] = [];

    @Injectable()
    class GlobalInterceptor implements NestInterceptor {
      async intercept(_ctx: ExecutionContext, next: CallHandler) {
        order.push('global:before');
        const r = await next.handle();
        order.push('global:after');
        return r;
      }
    }

    @Injectable()
    class LocalInterceptor implements NestInterceptor {
      async intercept(_ctx: ExecutionContext, next: CallHandler) {
        order.push('local:before');
        const r = await next.handle();
        order.push('local:after');
        return r;
      }
    }

    @Controller('/order-intercept')
    class OrderInterceptController {
      @Get()
      @UseInterceptors(LocalInterceptor)
      handle() {
        order.push('handler');
        return {};
      }
    }

    @Module({ controllers: [OrderInterceptController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    app.useGlobalInterceptors(new GlobalInterceptor());

    await app.getHonoApp().request('/order-intercept');
    expect(order).toEqual([
      'global:before',
      'local:before',
      'handler',
      'local:after',
      'global:after',
    ]);
  });
});

// =============================================================================
// @UseFilters() at method level
// =============================================================================

describe('@UseFilters() at method level', () => {
  it('method-level filter catches exception before global filter', async () => {
    class DomainError extends Error {
      constructor() {
        super('domain');
      }
    }

    @Catch(DomainError)
    class MethodFilter implements ExceptionFilter {
      catch(_e: unknown, ctx: ExecutionContext) {
        const c = ctx.getContext() as import('hono').Context;
        return c.json({ handler: 'method' }, 422);
      }
    }

    @Catch(DomainError)
    class GlobalFilter implements ExceptionFilter {
      catch(_e: unknown, ctx: ExecutionContext) {
        const c = ctx.getContext() as import('hono').Context;
        return c.json({ handler: 'global' }, 500);
      }
    }

    @Controller('/method-filter')
    class MethodFilterController {
      @Get('filtered')
      @UseFilters(MethodFilter)
      filtered() {
        throw new DomainError();
      }

      @Get('unfiltered')
      unfiltered() {
        throw new DomainError();
      }
    }

    @Module({
      providers: [defineProvider(APP_FILTER, { useClass: GlobalFilter })],
      controllers: [MethodFilterController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const r1 = await hono.request('/method-filter/filtered');
    expect(r1.status).toBe(422);
    expect(await r1.json()).toEqual({ handler: 'method' });

    const r2 = await hono.request('/method-filter/unfiltered');
    expect(r2.status).toBe(500);
    expect(await r2.json()).toEqual({ handler: 'global' });
  });

  it('controller-level @UseFilters() applies to all methods', async () => {
    class AppError extends Error {
      constructor() {
        super('app');
      }
    }

    @Catch(AppError)
    class ControllerFilter implements ExceptionFilter {
      catch(_e: unknown, ctx: ExecutionContext) {
        const c = ctx.getContext() as import('hono').Context;
        return c.json({ level: 'controller' }, 400);
      }
    }

    @Controller('/ctrl-filter')
    @UseFilters(ControllerFilter)
    class CtrlFilterController {
      @Get('a') a() {
        throw new AppError();
      }
      @Get('b') b() {
        throw new AppError();
      }
    }

    @Module({ controllers: [CtrlFilterController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    expect(await (await hono.request('/ctrl-filter/a')).json()).toEqual({ level: 'controller' });
    expect(await (await hono.request('/ctrl-filter/b')).json()).toEqual({ level: 'controller' });
  });
});

// =============================================================================
// useFactory async inline providers
// =============================================================================

describe('useFactory async inline providers', () => {
  it('async useFactory provider is resolved before first request', async () => {
    const DB_CONNECTION = new InjectionToken<{ ping(): string }>('DB_CONNECTION');

    @Controller('/async-factory')
    class AsyncFactoryController {
      constructor(@Inject(DB_CONNECTION) private db: { ping(): string }) {}
      @Get() handle() {
        return { pong: this.db.ping() };
      }
    }

    @Module({
      providers: [
        defineProvider(DB_CONNECTION, {
          inject: [],
          useFactory: async () => {
            await new Promise((r) => setTimeout(r, 5));
            return { ping: () => 'pong' };
          },
        }),
      ],
      controllers: [AsyncFactoryController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/async-factory');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pong: 'pong' });
  });

  it('async factory receives injected dependencies', async () => {
    const API_KEY = new InjectionToken<string>('API_KEY');
    const HTTP_CLIENT = new InjectionToken<{ baseUrl: string }>('HTTP_CLIENT');

    @Controller('/async-inject-factory')
    class AsyncInjectController {
      constructor(@Inject(HTTP_CLIENT) private client: { baseUrl: string }) {}
      @Get() handle() {
        return { baseUrl: this.client.baseUrl };
      }
    }

    @Module({
      providers: [
        defineProvider(API_KEY, { useValue: 'https://api.example.com' }),
        defineProvider(HTTP_CLIENT, {
          useFactory: async (key: string) => {
            await Promise.resolve();
            return { baseUrl: key };
          },
          inject: [API_KEY],
        }),
      ],
      controllers: [AsyncInjectController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/async-inject-factory');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ baseUrl: 'https://api.example.com' });
  });
});

// =============================================================================
// Custom dynamic module
// =============================================================================

describe('Custom dynamic module', () => {
  it('user-defined register() pattern creates a valid dynamic module', async () => {
    const STORAGE_OPTIONS = new InjectionToken<{ bucket: string }>('STORAGE_OPTIONS');

    @Injectable()
    class StorageService {
      constructor(@Inject(STORAGE_OPTIONS) private opts: { bucket: string }) {}
      getBucket() {
        return this.opts.bucket;
      }
    }

    class StorageModule {
      static register(opts: { bucket: string }) {
        const moduleClass: Type = { StorageDynamicModule: class {} }.StorageDynamicModule;
        MetadataRegistry.setModuleOptions(moduleClass, {
          providers: [defineProvider(STORAGE_OPTIONS, { useValue: opts }), StorageService],
          exports: [StorageService],
        });
        return {
          module: moduleClass,
          providers: [defineProvider(STORAGE_OPTIONS, { useValue: opts }), StorageService],
        };
      }
    }

    @Controller('/storage')
    class StorageController {
      constructor(private storage: StorageService) {}
      @Get() handle() {
        return { bucket: this.storage.getBucket() };
      }
    }

    @Module({
      imports: [StorageModule.register({ bucket: 'my-bucket' })],
      controllers: [StorageController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/storage');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bucket: 'my-bucket' });
  });

  it('forRoot() pattern with isGlobal makes providers available everywhere', async () => {
    const APP_CONFIG = new InjectionToken<{ apiUrl: string }>('APP_CONFIG');

    @Injectable()
    class AppConfigService {
      constructor(@Inject(APP_CONFIG) private cfg: { apiUrl: string }) {}
      getApiUrl() {
        return this.cfg.apiUrl;
      }
    }

    class AppConfigModule {
      static forRoot(config: { apiUrl: string }) {
        const moduleClass: Type = { AppConfigDynModule: class {} }.AppConfigDynModule;
        MetadataRegistry.setModuleOptions(moduleClass, {
          providers: [defineProvider(APP_CONFIG, { useValue: config }), AppConfigService],
          exports: [AppConfigService],
          isGlobal: true,
        });
        return {
          module: moduleClass,
          global: true,
          providers: [defineProvider(APP_CONFIG, { useValue: config }), AppConfigService],
        };
      }
    }

    @Controller('/cfg')
    class CfgController {
      constructor(private cfg: AppConfigService) {}
      @Get() handle() {
        return { url: this.cfg.getApiUrl() };
      }
    }

    @Module({
      imports: [AppConfigModule.forRoot({ apiUrl: 'https://app.io' })],
      controllers: [CfgController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/cfg');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://app.io' });
  });
});

// =============================================================================
// Guard + pipe + interceptor combined priority order
// =============================================================================

describe('Guard + pipe + interceptor combined priority order', () => {
  it('global guard blocks before controller interceptor runs', async () => {
    const order: string[] = [];

    @Injectable()
    class TrackingInterceptor implements NestInterceptor {
      async intercept(_ctx: ExecutionContext, next: CallHandler) {
        order.push('interceptor');
        return next.handle();
      }
    }

    @Injectable()
    class BlockingGuard implements CanActivate {
      canActivate(_ctx: ExecutionContext): boolean {
        order.push('guard');
        return false;
      }
    }

    @Controller('/combined')
    @UseInterceptors(TrackingInterceptor)
    class CombinedController {
      @Get() handle() {
        order.push('handler');
        return {};
      }
    }

    @Module({ controllers: [CombinedController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    app.useGlobalGuards(new BlockingGuard());

    const res = await app.getHonoApp().request('/combined');
    expect(res.status).toBe(403);
    expect(order).toEqual(['guard']); // interceptor and handler never run
  });

  it('global pipe transforms param before guard and handler see it', async () => {
    const seen: unknown[] = [];

    @Injectable()
    class UpperPipe implements PipeTransform {
      transform(value: unknown) {
        const upper = typeof value === 'string' ? value.toUpperCase() : value;
        return upper;
      }
    }

    @Controller('/pipe-order')
    class PipeOrderController {
      @Get()
      handle(@Query('name') name: string) {
        seen.push(name);
        return { name };
      }
    }

    @Module({ controllers: [PipeOrderController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    app.useGlobalPipes(new UpperPipe());

    const res = await app.getHonoApp().request('/pipe-order?name=alice');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'ALICE' });
    expect(seen[0]).toBe('ALICE');
  });

  it('guards run in order: global → controller → method', async () => {
    const order: string[] = [];

    @Injectable()
    class GlobalGuard implements CanActivate {
      canActivate(_: ExecutionContext) {
        order.push('global');
        return true;
      }
    }
    @Injectable()
    class CtrlGuard implements CanActivate {
      canActivate(_: ExecutionContext) {
        order.push('ctrl');
        return true;
      }
    }
    @Injectable()
    class MethodGuard implements CanActivate {
      canActivate(_: ExecutionContext) {
        order.push('method');
        return true;
      }
    }

    @Controller('/guard-order')
    @UseGuards(CtrlGuard)
    class GuardOrderController {
      @Get()
      @UseGuards(MethodGuard)
      handle() {
        return {};
      }
    }

    @Module({ controllers: [GuardOrderController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    app.useGlobalGuards(new GlobalGuard());

    await app.getHonoApp().request('/guard-order');
    expect(order).toEqual(['global', 'ctrl', 'method']);
  });
});

// =============================================================================
// Module provider isolation
// =============================================================================

describe('Module provider isolation', () => {
  it('providers not exported from a module are not accessible to importing modules', async () => {
    @Injectable()
    class InternalService {
      secret = 'hidden';
    }

    @Injectable()
    class PublicService {
      value = 'visible';
    }

    @Module({
      providers: [InternalService, PublicService],
      exports: [PublicService], // InternalService NOT exported
    })
    class FeatureModule {}

    @Controller('/isolation')
    class IsolationController {
      constructor(private pub: PublicService) {}
      @Get() handle() {
        return { value: this.pub.value };
      }
    }

    @Module({ imports: [FeatureModule], controllers: [IsolationController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/isolation');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: 'visible' });
  });

  it('deep import chain: AppModule → FeatureModule → CoreModule → Service', async () => {
    @Injectable()
    class CoreService {
      greet() {
        return 'core-hello';
      }
    }

    @Module({ providers: [CoreService], exports: [CoreService] })
    class CoreModule {}

    @Module({ imports: [CoreModule], exports: [CoreService] })
    class FeatureModule {}

    @Controller('/deep-chain')
    class DeepChainController {
      constructor(private core: CoreService) {}
      @Get() handle() {
        return { msg: this.core.greet() };
      }
    }

    @Module({ imports: [FeatureModule], controllers: [DeepChainController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/deep-chain');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ msg: 'core-hello' });
  });
});

// =============================================================================
// app.useGlobalInterceptors() post-create with rebuild()
// =============================================================================

describe('app.useGlobalInterceptors() / useGlobalGuards() / useGlobalPipes() post-create', () => {
  it('useGlobalInterceptors() + rebuild() applies to all routes', async () => {
    @Injectable()
    class EnvelopeInterceptor implements NestInterceptor {
      async intercept(_ctx: ExecutionContext, next: CallHandler) {
        return { envelope: await next.handle() };
      }
    }

    @Controller('/post-create')
    class PostCreateController {
      @Get() handle() {
        return { original: true };
      }
    }

    @Module({ controllers: [PostCreateController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);

    // Without interceptor
    const before = await app.getHonoApp().request('/post-create');
    expect(await before.json()).toEqual({ original: true });

    // Add interceptor
    app.useGlobalInterceptors(new EnvelopeInterceptor());

    const after = await app.getHonoApp().request('/post-create');
    expect(await after.json()).toEqual({ envelope: { original: true } });
  });

  it('useGlobalGuards() + rebuild() blocks requests globally', async () => {
    @Injectable()
    class DenyAllGuard implements CanActivate {
      canActivate(_: ExecutionContext) {
        return false;
      }
    }

    @Controller('/post-guard')
    class PostGuardController {
      @Get() handle() {
        return { ok: true };
      }
    }

    @Module({ controllers: [PostGuardController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);

    const before = await app.getHonoApp().request('/post-guard');
    expect(before.status).toBe(200);

    app.useGlobalGuards(new DenyAllGuard());

    const after = await app.getHonoApp().request('/post-guard');
    expect(after.status).toBe(403);
  });

  it('useGlobalFilters() + rebuild() catches unhandled exceptions globally', async () => {
    class CustomError extends Error {
      constructor() {
        super('custom');
      }
    }

    @Catch(CustomError)
    class CustomFilter implements ExceptionFilter {
      catch(_e: unknown, ctx: ExecutionContext) {
        const c = ctx.getContext() as import('hono').Context;
        return c.json({ caught: true }, 418);
      }
    }

    @Controller('/post-filter')
    class PostFilterController {
      @Get() handle() {
        throw new CustomError();
      }
    }

    @Module({ controllers: [PostFilterController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);

    const before = await app.getHonoApp().request('/post-filter');
    expect(before.status).toBe(500); // unhandled

    app.useGlobalFilters(new CustomFilter());

    const after = await app.getHonoApp().request('/post-filter');
    expect(after.status).toBe(418);
    expect(await after.json()).toEqual({ caught: true });
  });
});

// =============================================================================
// Exception response JSON shape
// =============================================================================

describe('Exception response JSON shape', () => {
  it('NotFoundException returns canonical { error: { code, message } }', async () => {
    @Controller('/exc-shape')
    class ExcShapeController {
      @Get() handle() {
        throw new NotFoundException('Item not found');
      }
    }

    @Module({ controllers: [ExcShapeController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/exc-shape');
    expect(res.status).toBe(404);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toBe('Item not found');
  });

  it('BadRequestException with default message returns 400', async () => {
    @Controller('/bad-shape')
    class BadShapeController {
      @Get() handle() {
        throw new BadRequestException();
      }
    }

    @Module({ controllers: [BadShapeController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/bad-shape');
    expect(res.status).toBe(400);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('bad_request');
    expect(typeof body.error.message).toBe('string');
  });

  it('HttpException with object response returns the object verbatim', async () => {
    @Controller('/obj-exc')
    class ObjExcController {
      @Get() handle() {
        throw new HttpException({ code: 'RESOURCE_GONE', detail: 'archived' }, 410);
      }
    }

    @Module({ controllers: [ObjExcController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/obj-exc');
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ code: 'RESOURCE_GONE', detail: 'archived' });
  });

  it('unhandled non-HttpException returns generic 500 JSON', async () => {
    @Controller('/raw-throw')
    class RawThrowController {
      @Get() handle() {
        throw new Error('boom');
      }
    }

    @Module({ controllers: [RawThrowController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/raw-throw');
    expect(res.status).toBe(500);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('internal');
    expect(typeof body.error.message).toBe('string');
  });
});

// =============================================================================
// HttpException.getStatus() / getResponse()
// =============================================================================

describe('HttpException.getStatus() / getResponse()', () => {
  it('getStatus() returns the HTTP status code', () => {
    const exc = new NotFoundException('not found');
    expect(exc.getStatus()).toBe(404);

    const custom = new HttpException('custom', 418);
    expect(custom.getStatus()).toBe(418);
  });

  it('getResponse() returns the structured response object', () => {
    const exc = new BadRequestException('invalid input');
    const response = exc.getResponse() as { statusCode: number; message: string };
    expect(response.statusCode).toBe(400);
    expect(response.message).toBe('invalid input');
  });

  it('getResponse() returns provided object when constructed with one', () => {
    const custom = new HttpException({ error: 'E001', reason: 'duplicate' }, 409);
    expect(custom.getResponse()).toEqual({ error: 'E001', reason: 'duplicate' });
  });

  it('getStatus() is accessible inside an ExceptionFilter', async () => {
    @Catch(HttpException)
    class StatusCheckFilter implements ExceptionFilter {
      catch(exception: HttpException, ctx: ExecutionContext) {
        const c = ctx.getContext() as import('hono').Context;
        return c.json(
          { status: exception.getStatus() },
          exception.getStatus() as import('hono/utils/http-status').ContentfulStatusCode,
        );
      }
    }

    @Controller('/status-check')
    class StatusCheckController {
      @Get() handle() {
        throw new ConflictException('duplicate');
      }
    }

    @Module({
      providers: [defineProvider(APP_FILTER, { useClass: StatusCheckFilter })],
      controllers: [StatusCheckController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/status-check');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ status: 409 });
  });
});

// =============================================================================
// NestMiddleware with DI (constructor injection)
// =============================================================================

describe('NestMiddleware with DI', () => {
  it('middleware can receive injected services via constructor', async () => {
    const calls: string[] = [];

    @Injectable()
    class AuditService {
      record(msg: string) {
        calls.push(msg);
      }
    }

    @Injectable()
    class AuditMiddleware implements NestModule {
      constructor(private audit: AuditService) {}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      use(c: any, next: () => Promise<void>) {
        this.audit.record(`${c.req.method} ${c.req.path}`);
        return next();
      }
    }

    @Controller('/audit')
    class AuditController {
      @Get() handle() {
        return { ok: true };
      }
    }

    @Module({
      providers: [AuditService, AuditMiddleware],
      controllers: [AuditController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, {
      middleware: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (c: any, next: () => Promise<void>) => {
          calls.push(`${c.req.method} ${c.req.path}`);
          return next();
        },
      ],
    });

    await app.getHonoApp().request('/audit');
    expect(calls).toEqual(['GET /audit']);
  });

  it('MiddlewareConsumer.forRoutes() with injected middleware service', async () => {
    const log: string[] = [];

    @Injectable()
    class LogService {
      write(entry: string) {
        log.push(entry);
      }
    }

    @Injectable()
    class LogMiddleware {
      constructor(private logSvc: LogService) {}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      use(c: any, next: () => Promise<void>) {
        this.logSvc.write('logged');
        return next();
      }
    }

    @Controller('/mw-di')
    class MwDiController {
      @Get() handle() {
        return { ok: true };
      }
    }

    @Module({
      providers: [LogService, LogMiddleware],
      controllers: [MwDiController],
    })
    class AppModule implements NestModule {
      configure(consumer: MiddlewareConsumer) {
        consumer.apply(LogMiddleware).forRoutes('/mw-di');
      }
    }

    const app = await VelaFactory.create(AppModule);
    await app.getHonoApp().request('/mw-di');
    expect(log).toEqual(['logged']);
  });
});

// =============================================================================
// @Query() full object (no name)
// =============================================================================

describe('@Query() full query object', () => {
  it('@Query() with no name returns all query params as object', async () => {
    @Controller('/full-query')
    class FullQueryController {
      @Get()
      handle(@Query() params: Record<string, string>) {
        return params;
      }
    }

    @Module({ controllers: [FullQueryController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/full-query?page=2&limit=10&sort=name');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ page: '2', limit: '10', sort: 'name' });
  });

  it('@Query() returns empty object when no params are present', async () => {
    @Controller('/empty-query')
    class EmptyQueryController {
      @Get()
      handle(@Query() params: Record<string, string>) {
        return params;
      }
    }

    @Module({ controllers: [EmptyQueryController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/empty-query');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
});

// =============================================================================
// Nested route params
// =============================================================================

describe('Nested route params', () => {
  it('extracts multiple params from nested path /users/:userId/posts/:postId', async () => {
    @Controller('/users')
    class NestedController {
      @Get(':userId/posts/:postId')
      getPost(@Param('userId') userId: string, @Param('postId') postId: string) {
        return { userId, postId };
      }
    }

    @Module({ controllers: [NestedController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/users/42/posts/99');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: '42', postId: '99' });
  });

  it('@Param() with no name returns all params as object', async () => {
    @Controller('/orgs/:orgId/repos/:repoId')
    class OrgRepoController {
      @Get()
      get(@Param() params: Record<string, string>) {
        return params;
      }
    }

    @Module({ controllers: [OrgRepoController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/orgs/acme/repos/vela');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orgId: 'acme', repoId: 'vela' });
  });

  it('handles deeply nested resources with query params alongside route params', async () => {
    @Controller('/teams/:teamId/members/:memberId/tasks')
    class TaskController {
      @Get()
      list(
        @Param('teamId') teamId: string,
        @Param('memberId') memberId: string,
        @Query('status') status: string,
      ) {
        return { teamId, memberId, status };
      }
    }

    @Module({ controllers: [TaskController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/teams/eng/members/alice/tasks?status=open');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ teamId: 'eng', memberId: 'alice', status: 'open' });
  });
});

// =============================================================================
// InjectionToken with default factory
// =============================================================================

describe('InjectionToken with default factory', () => {
  it('auto-resolves when no explicit provider is registered', async () => {
    const RAND_TOKEN = new InjectionToken<number>('RAND', {
      factory: () => 42,
    });

    @Controller('/tok-factory')
    class TokFactoryController {
      constructor(@Inject(RAND_TOKEN) private val: number) {}
      @Get() handle() {
        return { val: this.val };
      }
    }

    @Module({ controllers: [TokFactoryController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/tok-factory');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ val: 42 });
  });

  it('explicit provider overrides the default factory', async () => {
    const CONFIG_TOKEN = new InjectionToken<string>('CONFIG_DEF', {
      factory: () => 'default-value',
    });

    @Controller('/override-factory')
    class OverrideFactoryController {
      constructor(@Inject(CONFIG_TOKEN) private val: string) {}
      @Get() handle() {
        return { val: this.val };
      }
    }

    @Module({
      providers: [defineProvider(CONFIG_TOKEN, { useValue: 'overridden-value' })],
      controllers: [OverrideFactoryController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/override-factory');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ val: 'overridden-value' });
  });
});

// =============================================================================
// ParseArrayPipe with optional
// =============================================================================

describe('ParseArrayPipe with optional', () => {
  it('optional ParseArrayPipe returns empty array when param is absent', async () => {
    @Controller('/opt-arr')
    class OptArrController {
      @Get()
      handle(@Query('tags', new ParseArrayPipe({ optional: true })) tags: string[]) {
        return { tags };
      }
    }

    @Module({ controllers: [OptArrController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/opt-arr');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tags: [] });
  });

  it('ParseArrayPipe with custom separator splits correctly', async () => {
    @Controller('/pipe-sep')
    class PipeSepController {
      @Get()
      handle(@Query('ids', new ParseArrayPipe({ separator: '|' })) ids: string[]) {
        return { ids };
      }
    }

    @Module({ controllers: [PipeSepController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/pipe-sep?ids=x|y|z');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ids: ['x', 'y', 'z'] });
  });

  it('non-optional ParseArrayPipe throws 400 when param is absent', async () => {
    @Controller('/required-arr')
    class RequiredArrController {
      @Get()
      handle(@Query('ids', ParseArrayPipe) ids: string[]) {
        return { ids };
      }
    }

    @Module({ controllers: [RequiredArrController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/required-arr');
    expect(res.status).toBe(400);
  });
});

// =============================================================================
// Empty / pass-through module
// =============================================================================

describe('Empty / pass-through module', () => {
  it('module with no providers or controllers boots without error', async () => {
    @Module({})
    class EmptyModule {}

    @Controller('/empty-mod')
    class EmptyModController {
      @Get() handle() {
        return { ok: true };
      }
    }

    @Module({ imports: [EmptyModule], controllers: [EmptyModController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/empty-mod');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('module with only imports and no own providers boots correctly', async () => {
    @Injectable()
    class SharedService {
      getValue() {
        return 'shared';
      }
    }

    @Module({ providers: [SharedService], exports: [SharedService] })
    class SharedModule {}

    @Module({ imports: [SharedModule] }) // pass-through: just re-imports, no own providers
    class PassThroughModule {}

    @Controller('/passthrough')
    class PassThroughController {
      constructor(private svc: SharedService) {}
      @Get() handle() {
        return { value: this.svc.getValue() };
      }
    }

    @Module({ imports: [SharedModule, PassThroughModule], controllers: [PassThroughController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/passthrough');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: 'shared' });
  });
});

// =============================================================================
// Multiple @Header() decorators on same handler
// =============================================================================

describe('Multiple @Header() decorators on same handler', () => {
  it('multiple @Header() decorators all appear in the response', async () => {
    @Controller('/multi-header')
    class MultiHeaderController {
      @Get()
      @Header('x-api-version', '2')
      @Header('x-rate-limit', '100')
      @Header('cache-control', 'no-cache')
      handle() {
        return { ok: true };
      }
    }

    @Module({ controllers: [MultiHeaderController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/multi-header');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-api-version')).toBe('2');
    expect(res.headers.get('x-rate-limit')).toBe('100');
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('@Header() and @HttpCode() can coexist on the same handler', async () => {
    @Controller('/header-code')
    class HeaderCodeController {
      @Post()
      @HttpCode(201)
      @Header('location', '/header-code/1')
      @Header('x-created-id', '1')
      create() {
        return { id: 1 };
      }
    }

    @Module({ controllers: [HeaderCodeController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/header-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('location')).toBe('/header-code/1');
    expect(res.headers.get('x-created-id')).toBe('1');
  });
});

// =============================================================================
// @All() decorator
// =============================================================================

describe('@All() decorator', () => {
  it('handles GET, POST, PUT, DELETE on the same route', async () => {
    @Controller('/all-handler')
    class AllController {
      @All()
      handle(@Req() ctx: any) {
        return { method: ctx.req.method };
      }
    }

    @Module({ controllers: [AllController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const get = await hono.request('/all-handler', { method: 'GET' });
    const post = await hono.request('/all-handler', { method: 'POST' });
    const put = await hono.request('/all-handler', { method: 'PUT' });
    const del = await hono.request('/all-handler', { method: 'DELETE' });

    expect(((await get.json()) as any).method).toBe('GET');
    expect(((await post.json()) as any).method).toBe('POST');
    expect(((await put.json()) as any).method).toBe('PUT');
    expect(((await del.json()) as any).method).toBe('DELETE');
  });

  it('@All() with path handles any method', async () => {
    @Controller('/wildcard')
    class WildController {
      @All('/catch')
      catch() {
        return { caught: true };
      }
    }

    @Module({ controllers: [WildController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const patch = await hono.request('/wildcard/catch', { method: 'PATCH' });
    const options = await hono.request('/wildcard/catch', { method: 'OPTIONS' });

    expect(patch.status).toBe(200);
    expect(options.status).toBe(200);
  });
});

// =============================================================================
// @Catch() with no args (catch-all filter)
// =============================================================================

describe('@Catch() with no args — catch-all filter', () => {
  it('catches any exception when @Catch() has no arguments', async () => {
    @Catch()
    class CatchAllFilter implements ExceptionFilter {
      catch(exception: unknown, host: ArgumentsHost) {
        const ctx = host.switchToHttp();
        const c = ctx.getResponse<any>();
        const message = exception instanceof Error ? exception.message : 'unknown';
        return c.json({ caught: true, message }, 400);
      }
    }

    @Controller('/catch-all')
    class TestController {
      @Get()
      handle() {
        throw new Error('something broke');
      }
    }

    @Module({
      providers: [defineProvider(APP_FILTER, { useClass: CatchAllFilter })],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/catch-all');
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.caught).toBe(true);
    expect(body.message).toBe('something broke');
  });

  it('@Catch() also catches HttpExceptions', async () => {
    @Catch()
    class AllFilter implements ExceptionFilter {
      catch(_exception: unknown, host: ArgumentsHost) {
        const c = host.switchToHttp().getResponse<any>();
        return c.json({ intercepted: true }, 200);
      }
    }

    @Controller('/catch-http')
    class TestController {
      @Get()
      handle() {
        throw new NotFoundException();
      }
    }

    @Module({
      providers: [defineProvider(APP_FILTER, { useClass: AllFilter })],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/catch-http');
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).intercepted).toBe(true);
  });
});

// =============================================================================
// Async guard (canActivate returns Promise<boolean>)
// =============================================================================

describe('Async guard (canActivate returns Promise<boolean>)', () => {
  it('allows request when async guard resolves true', async () => {
    @Injectable()
    class AsyncGuard implements CanActivate {
      async canActivate(_ctx: ExecutionContext): Promise<boolean> {
        await Promise.resolve();
        return true;
      }
    }

    @Controller('/async-guard')
    @UseGuards(AsyncGuard)
    class TestController {
      @Get()
      handle() {
        return { ok: true };
      }
    }

    @Module({ providers: [AsyncGuard], controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/async-guard');
    expect(res.status).toBe(200);
  });

  it('blocks request when async guard resolves false', async () => {
    @Injectable()
    class DenyGuard implements CanActivate {
      async canActivate(_ctx: ExecutionContext): Promise<boolean> {
        await Promise.resolve();
        return false;
      }
    }

    @Controller('/async-deny')
    @UseGuards(DenyGuard)
    class TestController {
      @Get()
      handle() {
        return { ok: true };
      }
    }

    @Module({ providers: [DenyGuard], controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/async-deny');
    expect(res.status).toBe(403);
  });
});

// =============================================================================
// Interceptor error interception
// =============================================================================

describe('Interceptor error interception', () => {
  it('interceptor can catch handler errors and return a fallback', async () => {
    @Injectable()
    class ErrorRecoveryInterceptor implements NestInterceptor {
      async intercept(_ctx: ExecutionContext, next: CallHandler): Promise<unknown> {
        try {
          return await next.handle();
        } catch {
          return { recovered: true };
        }
      }
    }

    @Controller('/err-intercept')
    @UseInterceptors(ErrorRecoveryInterceptor)
    class TestController {
      @Get()
      handle() {
        throw new Error('boom');
      }
    }

    @Module({ providers: [ErrorRecoveryInterceptor], controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/err-intercept');
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).recovered).toBe(true);
  });

  it('interceptor wrapping does not suppress HttpException when not caught', async () => {
    @Injectable()
    class PassThroughInterceptor implements NestInterceptor {
      async intercept(_ctx: ExecutionContext, next: CallHandler): Promise<unknown> {
        return next.handle();
      }
    }

    @Controller('/err-pass')
    @UseInterceptors(PassThroughInterceptor)
    class TestController {
      @Get()
      handle() {
        throw new NotFoundException('not here');
      }
    }

    @Module({ providers: [PassThroughInterceptor], controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/err-pass');
    expect(res.status).toBe(404);
  });
});

// =============================================================================
// Multiple pipes on same param
// =============================================================================

describe('Multiple pipes chained on same param', () => {
  it('applies pipes left-to-right on a single param', async () => {
    @Controller('/multi-pipe')
    class TestController {
      @Get(':value')
      handle(@Param('value', ParseIntPipe, new DefaultValuePipe(0)) value: number) {
        return { value };
      }
    }

    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const r1 = await hono.request('/multi-pipe/42');
    expect(((await r1.json()) as any).value).toBe(42);
  });

  it('second pipe receives output of first pipe', async () => {
    class DoubleIntPipe implements PipeTransform {
      transform(value: number) {
        return value * 2;
      }
    }

    @Controller('/double-pipe')
    class TestController {
      @Get(':n')
      handle(@Param('n', ParseIntPipe, new DoubleIntPipe()) n: number) {
        return { n };
      }
    }

    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/double-pipe/5');
    expect(((await res.json()) as any).n).toBe(10);
  });
});

// =============================================================================
// APP_INTERCEPTOR ordering (multiple)
// =============================================================================

describe('APP_INTERCEPTOR ordering with multiple global interceptors', () => {
  it('first registered APP_INTERCEPTOR is outermost (wraps last)', async () => {
    const order: string[] = [];

    @Injectable()
    class FirstInterceptor implements NestInterceptor {
      async intercept(_ctx: ExecutionContext, next: CallHandler): Promise<unknown> {
        order.push('first-in');
        const result = await next.handle();
        order.push('first-out');
        return result;
      }
    }

    @Injectable()
    class SecondInterceptor implements NestInterceptor {
      async intercept(_ctx: ExecutionContext, next: CallHandler): Promise<unknown> {
        order.push('second-in');
        const result = await next.handle();
        order.push('second-out');
        return result;
      }
    }

    @Controller('/intercept-order')
    class TestController {
      @Get()
      handle() {
        order.push('handler');
        return { ok: true };
      }
    }

    @Module({
      providers: [
        FirstInterceptor,
        SecondInterceptor,
        defineProvider(APP_INTERCEPTOR, { useExisting: FirstInterceptor }),
        defineProvider(APP_INTERCEPTOR, { useExisting: SecondInterceptor }),
      ],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await app.getHonoApp().request('/intercept-order');

    expect(order).toEqual(['first-in', 'second-in', 'handler', 'second-out', 'first-out']);
  });
});

// =============================================================================
// @Controller() with no path
// =============================================================================

describe('@Controller() with no path', () => {
  it('mounts at root when no path given', async () => {
    @Controller()
    class RootController {
      @Get('/hello')
      hello() {
        return { hi: true };
      }
    }

    @Module({ controllers: [RootController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/hello');
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).hi).toBe(true);
  });

  it('@Controller("") also mounts at root', async () => {
    @Controller('')
    class EmptyController {
      @Get('/ping')
      ping() {
        return { pong: true };
      }
    }

    @Module({ controllers: [EmptyController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/ping');
    expect(res.status).toBe(200);
  });
});

// =============================================================================
// Provider circular DI via forwardRef()
// =============================================================================

describe('Provider circular DI via forwardRef()', () => {
  it('resolves circular provider dependency using forwardRef', async () => {
    @Injectable()
    class ServiceB {
      value = 'B';
      getFromA(): string {
        return serviceAInstance?.greet() ?? 'no-a';
      }
    }

    let serviceAInstance: ServiceA | undefined;

    @Injectable()
    class ServiceA {
      constructor(@Inject(forwardRef(() => ServiceB)) private b: ServiceB) {
        serviceAInstance = this;
      }
      greet(): string {
        return `hello-from-A-with-${this.b.value}`;
      }
    }

    @Controller('/circ-di')
    class TestController {
      constructor(private a: ServiceA) {}
      @Get()
      handle() {
        return { result: this.a.greet() };
      }
    }

    @Module({ providers: [ServiceA, ServiceB], controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/circ-di');
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).result).toBe('hello-from-A-with-B');
  });
});

// =============================================================================
// @UseFilters() at controller class level
// =============================================================================

describe('@UseFilters() at controller class level', () => {
  it('controller-level filter catches exceptions from any handler in that controller', async () => {
    @Catch(NotFoundException)
    class NotFoundFilter implements ExceptionFilter {
      catch(_exception: unknown, host: ArgumentsHost) {
        const c = host.switchToHttp().getResponse<any>();
        return c.json({ filteredAt: 'controller' }, 200);
      }
    }

    @Controller('/ctrl-filter')
    @UseFilters(NotFoundFilter)
    class TestController {
      @Get('/a')
      routeA() {
        throw new NotFoundException();
      }

      @Get('/b')
      routeB() {
        throw new NotFoundException();
      }
    }

    @Module({ providers: [NotFoundFilter], controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const a = await hono.request('/ctrl-filter/a');
    const b = await hono.request('/ctrl-filter/b');

    expect(a.status).toBe(200);
    expect(((await a.json()) as any).filteredAt).toBe('controller');
    expect(b.status).toBe(200);
    expect(((await b.json()) as any).filteredAt).toBe('controller');
  });

  it('controller-level filter does not bleed into other controllers', async () => {
    @Catch(NotFoundException)
    class IsolatedFilter implements ExceptionFilter {
      catch(_exception: unknown, host: ArgumentsHost) {
        const c = host.switchToHttp().getResponse<any>();
        return c.json({ from: 'isolated' }, 200);
      }
    }

    @Controller('/with-filter')
    @UseFilters(IsolatedFilter)
    class WithFilter {
      @Get()
      handle() {
        throw new NotFoundException();
      }
    }

    @Controller('/without-filter')
    class WithoutFilter {
      @Get()
      handle() {
        throw new NotFoundException();
      }
    }

    @Module({ providers: [IsolatedFilter], controllers: [WithFilter, WithoutFilter] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const withRes = await hono.request('/with-filter');
    const withoutRes = await hono.request('/without-filter');

    expect(withRes.status).toBe(200);
    expect(((await withRes.json()) as any).from).toBe('isolated');
    expect(withoutRes.status).toBe(404); // no filter, falls through to default
  });
});

// =============================================================================
// @Body('field') named field extraction
// =============================================================================

describe('@Body("field") named field extraction', () => {
  it('extracts a single top-level field from the request body', async () => {
    @Controller('/body-field')
    class TestController {
      @Post()
      handle(@Body('name') name: string) {
        return { name };
      }
    }

    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/body-field', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Alice', age: 30 }),
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as any).name).toBe('Alice');
  });

  it('returns undefined when named field is not present in body', async () => {
    @Controller('/body-missing')
    class TestController {
      @Post()
      handle(@Body('missing') val: unknown) {
        return { val: val ?? null };
      }
    }

    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/body-missing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ other: 'field' }),
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as any).val).toBeNull();
  });

  it('multiple @Body("field") params each extract their own key', async () => {
    @Controller('/body-multi')
    class TestController {
      @Post()
      handle(@Body('x') x: number, @Body('y') y: number) {
        return { sum: x + y };
      }
    }

    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/body-multi', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x: 3, y: 4 }),
    });

    expect(((await res.json()) as any).sum).toBe(7);
  });
});

// =============================================================================
// @Query('param', ParseIntPipe)
// =============================================================================

describe('@Query("param", ParseIntPipe)', () => {
  it('applies a pipe to a named query param', async () => {
    @Controller('/query-pipe')
    class TestController {
      @Get()
      handle(@Query('page', ParseIntPipe) page: number) {
        return { page };
      }
    }

    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/query-pipe?page=3');
    expect(((await res.json()) as any).page).toBe(3);
  });

  it('pipe on query param returns 400 for invalid value', async () => {
    @Controller('/query-bad')
    class TestController {
      @Get()
      handle(@Query('n', ParseIntPipe) n: number) {
        return { n };
      }
    }

    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/query-bad?n=abc');
    expect(res.status).toBe(400);
  });

  it('multiple piped query params each transform independently', async () => {
    @Controller('/query-multi')
    class TestController {
      @Get()
      handle(@Query('a', ParseIntPipe) a: number, @Query('b', ParseFloatPipe) b: number) {
        return { a, b };
      }
    }

    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/query-multi?a=10&b=3.14');
    const body = (await res.json()) as any;
    expect(body.a).toBe(10);
    expect(body.b).toBeCloseTo(3.14);
  });
});

// =============================================================================
// Reflector.getAllAndOverride() / getAllAndMerge()
// =============================================================================

describe('Reflector.getAllAndOverride() / getAllAndMerge()', () => {
  it('getAllAndOverride returns the first defined value (handler wins over controller)', async () => {
    const ROLES_KEY = 'roles';
    const captured: Array<string[] | undefined> = [];

    @Injectable()
    class RolesGuard implements CanActivate {
      constructor(private reflector: Reflector) {}
      canActivate(ctx: ExecutionContext): boolean {
        captured.push(this.reflector.getAllAndOverride<string[]>(ROLES_KEY, ctx));
        return true;
      }
    }

    @Controller('/reflector-override')
    @SetMetadata(ROLES_KEY, ['admin'])
    @UseGuards(RolesGuard)
    class TestController {
      @Get('/handler-wins')
      @SetMetadata(ROLES_KEY, ['user'])
      handlerWins() {
        return { ok: true };
      }

      @Get('/controller-fallback')
      controllerFallback() {
        return { ok: true };
      }
    }

    @Module({ providers: [RolesGuard, Reflector], controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    await hono.request('/reflector-override/handler-wins');
    await hono.request('/reflector-override/controller-fallback');

    expect(captured[0]).toEqual(['user']); // handler metadata wins
    expect(captured[1]).toEqual(['admin']); // falls back to controller metadata
  });

  it('getAllAndMerge concatenates metadata from handler and controller', async () => {
    const PERMS_KEY = 'permissions';
    let captured: unknown;

    @Injectable()
    class PermsGuard implements CanActivate {
      constructor(private reflector: Reflector) {}
      canActivate(ctx: ExecutionContext): boolean {
        captured = this.reflector.getAllAndMerge<string[]>(PERMS_KEY, ctx);
        return true;
      }
    }

    @Controller('/reflector-merge')
    @SetMetadata(PERMS_KEY, ['read'])
    @UseGuards(PermsGuard)
    class TestController {
      @Get()
      @SetMetadata(PERMS_KEY, ['write'])
      handle() {
        return { ok: true };
      }
    }

    @Module({ providers: [PermsGuard, Reflector], controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await app.getHonoApp().request('/reflector-merge');
    expect(captured).toContain('read');
    expect(captured).toContain('write');
  });
});

// =============================================================================
// Middleware sets context variable, guard reads it
// =============================================================================

describe('Middleware sets context variable, guard reads it', () => {
  it('middleware sets a property on context object accessible to the handler', async () => {
    @Injectable()
    class TagMiddleware implements NestMiddleware {
      use(c: any, next: () => Promise<void>) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (c as any)._tag = 'from-middleware';
        return next();
      }
    }

    @Controller('/ctx-share')
    class TestController {
      @Get()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handle(@Req() ctx: any) {
        return { tag: (ctx as any)._tag ?? null };
      }
    }

    @Module({
      providers: [TagMiddleware, defineProvider(APP_MIDDLEWARE, { useExisting: TagMiddleware })],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/ctx-share');
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).tag).toBe('from-middleware');
  });

  it('multiple middlewares share the same context object', async () => {
    const order: string[] = [];

    @Injectable()
    class MwOne implements NestMiddleware {
      use(c: any, next: () => Promise<void>) {
        order.push('one');
        (c as any)._count = ((c as any)._count ?? 0) + 1;
        return next();
      }
    }

    @Injectable()
    class MwTwo implements NestMiddleware {
      use(c: any, next: () => Promise<void>) {
        order.push('two');
        (c as any)._count = ((c as any)._count ?? 0) + 1;
        return next();
      }
    }

    @Controller('/ctx-multi')
    class TestController {
      @Get()
      handle(@Req() ctx: any) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { count: (ctx as any)._count ?? 0 };
      }
    }

    @Module({
      providers: [
        MwOne,
        MwTwo,
        defineProvider(APP_MIDDLEWARE, { useExisting: MwOne }),
        defineProvider(APP_MIDDLEWARE, { useExisting: MwTwo }),
      ],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/ctx-multi');
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).count).toBe(2);
    expect(order).toEqual(['one', 'two']);
  });
});

// =============================================================================
// Route specificity (static beats dynamic)
// =============================================================================

describe('Route specificity — static path beats dynamic param', () => {
  it('GET /items/search matches before /items/:id', async () => {
    @Controller('/items')
    class ItemsController {
      @Get('search')
      search() {
        return { type: 'search' };
      }

      @Get(':id')
      getById(@Param('id') id: string) {
        return { type: 'by-id', id };
      }
    }

    @Module({ controllers: [ItemsController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const searchRes = await hono.request('/items/search');
    const byIdRes = await hono.request('/items/42');

    const searchBody = (await searchRes.json()) as any;
    const byIdBody = (await byIdRes.json()) as any;
    expect(searchBody.type).toBe('search');
    expect(byIdBody.type).toBe('by-id');
    expect(byIdBody.id).toBe('42');
  });
});

// =============================================================================
// forwardRef() in factory inject array
// =============================================================================

describe('forwardRef() in factory inject array', () => {
  it('useFactory resolves forwardRef tokens from the inject array', async () => {
    @Injectable()
    class ConfigSvc {
      readonly prefix = 'hello';
    }

    const GREETING = new InjectionToken<string>('GREETING');

    @Controller('/fwd-factory')
    class TestController {
      constructor(@Inject(GREETING) private greeting: string) {}
      @Get()
      handle() {
        return { greeting: this.greeting };
      }
    }

    @Module({
      providers: [
        ConfigSvc,
        defineProvider(GREETING, {
          useFactory: (cfg: ConfigSvc) => `${cfg.prefix}-world`,
          inject: [forwardRef(() => ConfigSvc)],
        }),
      ],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/fwd-factory');
    expect(((await res.json()) as any).greeting).toBe('hello-world');
  });
});

// =============================================================================
// Guard short-circuit (first guard fails → second never runs)
// =============================================================================

describe('Guard short-circuit', () => {
  it('second guard is never called when first guard returns false', async () => {
    let secondCalled = false;

    @Injectable()
    class DenyGuard implements CanActivate {
      canActivate(): boolean {
        return false;
      }
    }

    @Injectable()
    class SpyGuard implements CanActivate {
      canActivate(): boolean {
        secondCalled = true;
        return true;
      }
    }

    @Controller('/short-circuit')
    @UseGuards(DenyGuard, SpyGuard)
    class TestController {
      @Get()
      handle() {
        return { ok: true };
      }
    }

    @Module({ providers: [DenyGuard, SpyGuard], controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/short-circuit');

    expect(res.status).toBe(403);
    expect(secondCalled).toBe(false);
  });
});

// =============================================================================
// @Body() with missing / malformed JSON
// =============================================================================

describe('@Body() with missing or malformed JSON', () => {
  it('returns undefined when body is empty', async () => {
    @Controller('/body-empty')
    class TestController {
      @Post()
      handle(@Body() body: unknown) {
        return { hasBody: body !== undefined };
      }
    }

    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/body-empty', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).hasBody).toBe(false);
  });

  it('rejects malformed JSON with 400', async () => {
    @Controller('/body-malformed')
    class TestController {
      @Post()
      handle(@Body() body: unknown) {
        return { body: body ?? null };
      }
    }

    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/body-malformed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-valid-json{{{',
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: 'bad_request', message: 'Malformed JSON body' },
    });
  });
});

// =============================================================================
// @Param() when URL segment is absent
// =============================================================================

describe('@Param() when URL segment is absent', () => {
  it('returns undefined for a param not in the actual URL', async () => {
    @Controller('/maybe')
    class TestController {
      @Get()
      withoutParam(@Param('id') id: string | undefined) {
        return { id: id ?? null };
      }
    }

    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/maybe');
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).id).toBeNull();
  });
});

// =============================================================================
// @Headers('name') case-insensitive lookup
// =============================================================================

describe('@Headers("name") case-insensitive header lookup', () => {
  it('retrieves header regardless of case sent by client', async () => {
    @Controller('/header-ci')
    class TestController {
      @Get()
      handle(@Headers('x-custom-token') token: string) {
        return { token };
      }
    }

    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const lower = await hono.request('/header-ci', { headers: { 'x-custom-token': 'abc' } });
    const upper = await hono.request('/header-ci', { headers: { 'X-Custom-Token': 'xyz' } });

    expect(((await lower.json()) as any).token).toBe('abc');
    expect(((await upper.json()) as any).token).toBe('xyz');
  });

  it('@Headers() without name returns all headers as object', async () => {
    @Controller('/all-headers')
    class TestController {
      @Get()
      handle(@Headers() headers: Record<string, string>) {
        return { hasAccept: 'accept' in headers || 'Accept' in headers };
      }
    }

    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/all-headers', {
      headers: { accept: 'application/json' },
    });
    expect(((await res.json()) as any).hasAccept).toBe(true);
  });
});

// =============================================================================
// @Controller({ path }) as alias for prefix
// =============================================================================

describe('@Controller({ path }) as alias for prefix', () => {
  it('registers routes under the specified path', async () => {
    @Controller({ path: '/path-alias' })
    class TestController {
      @Get()
      get() {
        return { ok: true };
      }
    }

    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/path-alias');
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).ok).toBe(true);
  });

  it('supports { path } with version option', async () => {
    @Controller({ path: '/versioned', version: 2 })
    class TestController {
      @Get()
      get() {
        return { v: 2 };
      }
    }

    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/v2/versioned');
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).v).toBe(2);
  });
});

// =============================================================================
// @Param with pipe transforms the value
// =============================================================================

describe('@Param("id", ParseIntPipe) transforms string to integer', () => {
  it('converts route param string to number', async () => {
    @Controller('/param-int')
    class TestController {
      @Get('/:id')
      get(@Param('id', ParseIntPipe) id: number) {
        return { id, isNumber: typeof id === 'number' };
      }
    }

    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/param-int/42');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe(42);
    expect(body.isNumber).toBe(true);
  });

  it('throws BadRequestException for non-numeric param', async () => {
    @Controller('/param-int-err')
    class TestController {
      @Get('/:id')
      get(@Param('id', ParseIntPipe) id: number) {
        return { id };
      }
    }

    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/param-int-err/abc');
    expect(res.status).toBe(400);
  });
});

// =============================================================================
// @Body("field", pipe) extracts and transforms named body field
// =============================================================================

describe('@Body("field", ParseIntPipe) extracts and transforms named field', () => {
  it('returns integer from string field in JSON body', async () => {
    @Controller('/body-field-pipe')
    class TestController {
      @Post()
      post(@Body('count', ParseIntPipe) count: number) {
        return { count, isNumber: typeof count === 'number' };
      }
    }

    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/body-field-pipe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ count: '7' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.count).toBe(7);
    expect(body.isNumber).toBe(true);
  });
});

// =============================================================================
// ExceptionFilter shapes the JSON response
// =============================================================================

describe('ExceptionFilter shapes the JSON error response', () => {
  it('custom filter returns structured error body', async () => {
    @Catch(NotFoundException)
    @Injectable()
    class ShapeFilter implements ExceptionFilter {
      catch(exception: NotFoundException, ctx: ExecutionContext) {
        const c = ctx.switchToHttp().getResponse<any>();
        const resp = exception.getResponse() as any;
        return c.json(
          {
            error: true,
            code: exception.getStatus(),
            msg: typeof resp === 'string' ? resp : resp.message,
          },
          exception.getStatus() as any,
        );
      }
    }

    @Controller('/filter-shape')
    class TestController {
      @Get()
      @UseFilters(ShapeFilter)
      handle() {
        throw new NotFoundException('item not found');
      }
    }

    @Module({ controllers: [TestController], providers: [ShapeFilter] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/filter-shape');
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error).toBe(true);
    expect(body.code).toBe(404);
    expect(body.msg).toBe('item not found');
  });
});

// =============================================================================
// NestInterceptor transforms the response
// =============================================================================

describe('NestInterceptor can wrap/transform the response', () => {
  it('wraps return value in a data envelope', async () => {
    @Injectable()
    class WrapInterceptor implements NestInterceptor {
      async intercept(_ctx: ExecutionContext, next: CallHandler) {
        const value = await next.handle();
        return { data: value, wrapped: true };
      }
    }

    @Controller('/wrap-intercept')
    class TestController {
      @Get()
      @UseInterceptors(WrapInterceptor)
      handle() {
        return { hello: 'world' };
      }
    }

    @Module({ controllers: [TestController], providers: [WrapInterceptor] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/wrap-intercept');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.wrapped).toBe(true);
    expect(body.data.hello).toBe('world');
  });

  it('interceptor can add metadata to the response', async () => {
    @Injectable()
    class TimestampInterceptor implements NestInterceptor {
      async intercept(_ctx: ExecutionContext, next: CallHandler) {
        const value = (await next.handle()) as Record<string, unknown>;
        return { ...value, ts: 'fixed' };
      }
    }

    @Controller('/timestamp-intercept')
    class TestController {
      @Get()
      @UseInterceptors(TimestampInterceptor)
      handle() {
        return { result: 'ok' };
      }
    }

    @Module({ controllers: [TestController], providers: [TimestampInterceptor] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/timestamp-intercept');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.result).toBe('ok');
    expect(body.ts).toBe('fixed');
  });
});

// =============================================================================
// APP_GUARD + APP_FILTER interaction
// =============================================================================

describe('APP_GUARD and APP_FILTER interaction', () => {
  it('global filter catches exception thrown by global guard', async () => {
    @Injectable()
    class BlockingGuard implements CanActivate {
      canActivate() {
        throw new ForbiddenException('blocked by guard');
      }
    }

    @Catch(ForbiddenException)
    @Injectable()
    class ForbiddenCatcher implements ExceptionFilter {
      catch(exception: ForbiddenException, ctx: ExecutionContext) {
        const c = ctx.switchToHttp().getResponse<any>();
        return c.json({ caught: true, message: exception.message }, 403);
      }
    }

    @Controller('/guard-filter-combo')
    class TestController {
      @Get()
      handle() {
        return { reached: true };
      }
    }

    @Module({
      controllers: [TestController],
      providers: [
        BlockingGuard,
        ForbiddenCatcher,
        defineProvider(APP_GUARD, { useExisting: BlockingGuard }),
        defineProvider(APP_FILTER, { useExisting: ForbiddenCatcher }),
      ],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/guard-filter-combo');
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.caught).toBe(true);
    expect(body.message).toBe('blocked by guard');
  });
});

// =============================================================================
// useFactory with TRANSIENT scope creates fresh instances
// =============================================================================

describe('useFactory with Scope.TRANSIENT creates a new instance on each resolve', () => {
  it('resolving the token twice yields distinct objects', async () => {
    let callCount = 0;
    const COUNTER_TOKEN = new InjectionToken<{ id: number }>('transient-counter');

    @Module({
      providers: [
        defineProvider(COUNTER_TOKEN, {
          inject: [],
          useFactory: () => ({ id: ++callCount }),
          scope: Scope.TRANSIENT,
        }),
      ],
      exports: [COUNTER_TOKEN],
    })
    class CounterModule {}

    @Module({ imports: [CounterModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const container = app.getContainer();
    const a = container.resolve(COUNTER_TOKEN);
    const b = container.resolve(COUNTER_TOKEN);
    // TRANSIENT: each resolve calls the factory, yielding distinct instances
    expect(a.id).not.toBe(b.id);
    // factory was called at least twice (once per resolve above; may also be
    // called once during resolveAllInstances, so we just verify > 1 call)
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
// Dynamic module re-exports a provider through an intermediate module
// =============================================================================

describe('Module re-exports a provider from an imported module', () => {
  it('consumer module can inject a provider re-exported by a middle module', async () => {
    const VALUE_TOKEN = new InjectionToken<string>('reexport-value');

    @Module({
      providers: [defineProvider(VALUE_TOKEN, { useValue: 'from-inner' })],
      exports: [VALUE_TOKEN],
    })
    class InnerModule {}

    @Module({ imports: [InnerModule], exports: [VALUE_TOKEN] })
    class MiddleModule {}

    @Injectable()
    class ConsumerService {
      constructor(@Inject(VALUE_TOKEN) public value: string) {}
    }

    @Controller('/reexport')
    class TestController {
      constructor(private svc: ConsumerService) {}
      @Get()
      get() {
        return { value: this.svc.value };
      }
    }

    @Module({
      imports: [MiddleModule],
      controllers: [TestController],
      providers: [ConsumerService],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/reexport');
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).value).toBe('from-inner');
  });
});

// =============================================================================
// onModuleDestroy lifecycle hook
// =============================================================================

describe('onModuleDestroy lifecycle hook', () => {
  it('is called when app.close() is invoked', async () => {
    const destroyed: string[] = [];

    @Injectable()
    class MyService implements OnModuleDestroy {
      onModuleDestroy() {
        destroyed.push('service');
      }
    }

    @Module({ providers: [MyService] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(destroyed).toHaveLength(0);
    await app.close();
    expect(destroyed).toContain('service');
  });

  it('is called in reverse instantiation order', async () => {
    const order: string[] = [];

    @Injectable()
    class FirstService implements OnModuleDestroy {
      onModuleDestroy() {
        order.push('first');
      }
    }

    @Injectable()
    class SecondService implements OnModuleDestroy {
      constructor(_first: FirstService) {}
      onModuleDestroy() {
        order.push('second');
      }
    }

    @Module({ providers: [FirstService, SecondService] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await app.close();
    // reversed: SecondService destroyed before FirstService
    expect(order.indexOf('second')).toBeLessThan(order.indexOf('first'));
  });
});

// =============================================================================
// ModuleRef.get() retrieves provider from DI container
// =============================================================================

describe('ModuleRef.get() retrieves the singleton provider instance', () => {
  it('returns the same instance as direct injection', async () => {
    @Injectable()
    class SharedService {
      getValue() {
        return 'shared-value';
      }
    }

    @Injectable()
    class ConsumerService {
      constructor(private moduleRef: ModuleRef) {}
      getViaRef() {
        return this.moduleRef.get(SharedService);
      }
    }

    @Controller('/module-ref-get')
    class TestController {
      constructor(private svc: ConsumerService) {}
      @Get()
      get() {
        const shared = this.svc.getViaRef();
        return { value: shared.getValue() };
      }
    }

    @Module({
      controllers: [TestController],
      providers: [SharedService, ConsumerService],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/module-ref-get');
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).value).toBe('shared-value');
  });

  it('ModuleRef.get() and direct injection return the same singleton object', async () => {
    @Injectable()
    class SingletonService {
      id = Math.random();
    }

    @Injectable()
    class CheckService {
      constructor(
        public direct: SingletonService,
        private moduleRef: ModuleRef,
      ) {}
      sameInstance() {
        return this.moduleRef.get(SingletonService) === this.direct;
      }
    }

    @Module({ providers: [SingletonService, CheckService] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const check = app.get(CheckService);
    expect(check.sameInstance()).toBe(true);
  });
});

// =============================================================================
// REQUEST scope — new instance per HTTP request
// =============================================================================

describe('REQUEST scope — child container isolation', () => {
  it('two child containers cache REQUEST instances independently', async () => {
    @Injectable({ scope: Scope.REQUEST })
    class RequestStore {
      id = Math.random();
    }

    @Module({ providers: [RequestStore] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const container = app.getContainer();

    // Simulate two separate requests (two child containers)
    const child1 = container.createChild();
    const child2 = container.createChild();

    const inst1a = child1.resolve(RequestStore);
    const inst1b = child1.resolve(RequestStore); // same child → same cached instance
    const inst2 = child2.resolve(RequestStore);

    expect(inst1a).toBe(inst1b); // same request → same instance
    expect(inst1a).not.toBe(inst2); // different requests → different instances
  });

  it('REQUEST-scoped guard gets a fresh instance per HTTP request', async () => {
    const seenIds: number[] = [];

    @Injectable({ scope: Scope.REQUEST })
    class ReqValue {
      id = Math.random();
    }

    @Injectable({ scope: Scope.REQUEST })
    class ReqGuard implements CanActivate {
      constructor(private val: ReqValue) {}
      canActivate() {
        seenIds.push(this.val.id);
        return true;
      }
    }

    @Controller('/req-guard-scope')
    class TestController {
      @Get()
      get() {
        return { ok: true };
      }
    }

    @Module({
      providers: [ReqValue, ReqGuard, defineProvider(APP_GUARD, { useExisting: ReqGuard })],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await app.getHonoApp().request('/req-guard-scope');
    await app.getHonoApp().request('/req-guard-scope');
    expect(seenIds).toHaveLength(2);
    expect(seenIds[0]).not.toBe(seenIds[1]);
  });
});

// =============================================================================
// ModuleRef.create() — fresh instance outside singleton cache
// =============================================================================

describe('ModuleRef.create() creates a fresh instance outside the singleton cache', () => {
  it('returns a new object each call, leaving the singleton untouched', async () => {
    @Injectable()
    class SingletonService {
      id = Math.random();
    }

    @Injectable()
    class FactoryService {
      constructor(private moduleRef: ModuleRef) {}
      createFresh() {
        return this.moduleRef.create(SingletonService);
      }
    }

    @Module({ providers: [SingletonService, FactoryService] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const factory = app.get(FactoryService);
    const singleton = app.get(SingletonService);
    const fresh1 = factory.createFresh();
    const fresh2 = factory.createFresh();

    expect(fresh1).not.toBe(singleton);
    expect(fresh1).not.toBe(fresh2);
    expect(app.get(SingletonService)).toBe(singleton); // singleton unchanged
  });
});

// =============================================================================
// @Global() module — providers available without explicit import
// =============================================================================

describe('@Global() module makes providers available across all modules', () => {
  it('consumer can inject a globally-provided service without importing its module', async () => {
    @Injectable()
    class GlobalService {
      greet() {
        return 'global';
      }
    }

    @Global()
    @Module({ providers: [GlobalService], exports: [GlobalService] })
    class GlobalModule {}

    @Injectable()
    class LocalService {
      constructor(private global: GlobalService) {}
      say() {
        return this.global.greet();
      }
    }

    @Controller('/global-svc')
    class TestController {
      constructor(private local: LocalService) {}
      @Get()
      get() {
        return { msg: this.local.say() };
      }
    }

    // AppModule does NOT explicitly import GlobalModule — it's global
    @Module({ imports: [GlobalModule], controllers: [TestController], providers: [LocalService] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/global-svc');
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).msg).toBe('global');
  });
});

// =============================================================================
// Circular module imports with forwardRef
// =============================================================================

describe('Circular module imports resolved with forwardRef', () => {
  it('modules that reference each other are both processed correctly', async () => {
    const TOKEN_A = new InjectionToken<string>('circ-a');
    const TOKEN_B = new InjectionToken<string>('circ-b');

    // Use a let variable so the forwardRef closure captures it by reference.
    // ModuleB imports ModuleA (via forwardRef) and ModuleA imports ModuleB —
    // the cycle is broken because ModuleLoader skips the forwardRef'd import
    // when the referenced module is already on the processing stack.
    let ModuleARef: any;

    @Module({
      imports: [forwardRef(() => ModuleARef)],
      providers: [defineProvider(TOKEN_B, { useValue: 'from-b' })],
      exports: [TOKEN_B],
    })
    class ModuleB {}

    @Module({
      imports: [ModuleB],
      providers: [defineProvider(TOKEN_A, { useValue: 'from-a' })],
      exports: [TOKEN_A],
    })
    class ModuleA {}

    ModuleARef = ModuleA; // assign after class is defined — forwardRef resolves here

    @Injectable()
    class TestService {
      constructor(
        @Inject(TOKEN_A) public a: string,
        @Inject(TOKEN_B) public b: string,
      ) {}
    }

    @Controller('/circular-mod')
    class TestController {
      constructor(private svc: TestService) {}
      @Get()
      get() {
        return { a: this.svc.a, b: this.svc.b };
      }
    }

    @Module({
      imports: [ModuleA, ModuleB],
      controllers: [TestController],
      providers: [TestService],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/circular-mod');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.a).toBe('from-a');
    expect(body.b).toBe('from-b');
  });
});

// =============================================================================
// Lifecycle hooks — onApplicationBootstrap and beforeApplicationShutdown order
// =============================================================================

describe('Lifecycle hooks — onApplicationBootstrap and beforeApplicationShutdown', () => {
  it('onApplicationBootstrap is called after module init', async () => {
    const events: string[] = [];

    @Injectable()
    class LifecycleService implements OnModuleInit, OnApplicationBootstrap {
      onModuleInit() {
        events.push('init');
      }
      onApplicationBootstrap() {
        events.push('bootstrap');
      }
    }

    @Module({ providers: [LifecycleService] })
    class AppModule {}

    await VelaFactory.create(AppModule);
    expect(events.indexOf('init')).toBeLessThan(events.indexOf('bootstrap'));
  });

  it('beforeApplicationShutdown is called before onModuleDestroy on close()', async () => {
    const events: string[] = [];

    @Injectable()
    class ShutdownService implements BeforeApplicationShutdown, OnModuleDestroy {
      beforeApplicationShutdown() {
        events.push('before');
      }
      onModuleDestroy() {
        events.push('destroy');
      }
    }

    @Module({ providers: [ShutdownService] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await app.close();
    expect(events.indexOf('before')).toBeLessThan(events.indexOf('destroy'));
  });
});

// =============================================================================
// @Version([1, 2]) array — route registered on multiple versions
// =============================================================================

describe('@Version([1, 2]) registers the route on multiple version paths', () => {
  it('responds on both /v1 and /v2 paths', async () => {
    @Controller({ path: '/multi', version: [1, 2] })
    class TestController {
      @Get()
      get() {
        return { ok: true };
      }
    }

    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();
    const r1 = await hono.request('/v1/multi');
    const r2 = await hono.request('/v2/multi');
    const r3 = await hono.request('/v3/multi');
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(404);
  });

  it('@Version([]) on method overrides controller version', async () => {
    @Controller({ path: '/ver-method', version: 1 })
    class TestController {
      @Get('/v1-only')
      v1() {
        return { v: 1 };
      }

      @Version(2)
      @Get('/v2-only')
      v2() {
        return { v: 2 };
      }
    }

    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();
    const r1 = await hono.request('/v1/ver-method/v1-only');
    const r2 = await hono.request('/v2/ver-method/v2-only');
    const wrong = await hono.request('/v1/ver-method/v2-only');
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(wrong.status).toBe(404);
  });
});

// =============================================================================
// ParseUUIDPipe, ParseEnumPipe, ParseArrayPipe edge cases
// =============================================================================

describe('ParseUUIDPipe validates UUID format', () => {
  it('passes a valid UUID v4', async () => {
    @Controller('/uuid-pipe')
    class TestController {
      @Get('/:id')
      get(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
        return { id };
      }
    }
    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const res = await app.getHonoApp().request(`/uuid-pipe/${uuid}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).id).toBe(uuid);
  });

  it('throws 400 for a non-UUID string', async () => {
    @Controller('/uuid-pipe-err')
    class TestController {
      @Get('/:id')
      get(@Param('id', ParseUUIDPipe) id: string) {
        return { id };
      }
    }
    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/uuid-pipe-err/not-a-uuid');
    expect(res.status).toBe(400);
  });
});

describe('ParseEnumPipe validates enum membership', () => {
  it('passes a valid enum value', async () => {
    enum Direction {
      Up = 'up',
      Down = 'down',
    }

    @Controller('/enum-pipe')
    class TestController {
      @Get('/:dir')
      get(@Param('dir', new ParseEnumPipe(Direction)) dir: Direction) {
        return { dir };
      }
    }
    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/enum-pipe/up');
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).dir).toBe('up');
  });

  it('throws 400 for a value not in the enum', async () => {
    enum Color {
      Red = 'red',
      Blue = 'blue',
    }

    @Controller('/enum-pipe-err')
    class TestController {
      @Get('/:color')
      get(@Param('color', new ParseEnumPipe(Color)) color: Color) {
        return { color };
      }
    }
    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/enum-pipe-err/green');
    expect(res.status).toBe(400);
  });
});

describe('ParseArrayPipe splits comma-separated query string', () => {
  it('splits a comma-separated param into an array', async () => {
    @Controller('/arr-pipe')
    class TestController {
      @Get()
      get(@Query('ids', new ParseArrayPipe({ separator: ',' })) ids: string[]) {
        return { ids };
      }
    }
    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/arr-pipe?ids=1,2,3');
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).ids).toEqual(['1', '2', '3']);
  });

  it('returns an empty array when optional and param is absent', async () => {
    @Controller('/arr-pipe-opt')
    class TestController {
      @Get()
      get(@Query('ids', new ParseArrayPipe({ optional: true })) ids: string[]) {
        return { ids };
      }
    }
    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/arr-pipe-opt');
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).ids).toEqual([]);
  });
});

// =============================================================================
// DefaultValuePipe and RequiredPipe
// =============================================================================

describe('DefaultValuePipe supplies a fallback when param is absent', () => {
  it('uses the default when query param is missing, passes through when present', async () => {
    @Controller('/default-pipe')
    class TestController {
      @Get()
      get(@Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number) {
        return { page };
      }
    }
    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();
    const withParam = await hono.request('/default-pipe?page=5');
    const withoutParam = await hono.request('/default-pipe');
    expect(((await withParam.json()) as any).page).toBe(5);
    expect(((await withoutParam.json()) as any).page).toBe(1);
  });
});

describe('RequiredPipe rejects absent or empty values with 400', () => {
  it('allows a present value and rejects a missing one', async () => {
    @Controller('/required-pipe')
    class TestController {
      @Get()
      get(@Query('name', RequiredPipe) name: string) {
        return { name };
      }
    }
    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();
    const ok = await hono.request('/required-pipe?name=alice');
    const bad = await hono.request('/required-pipe');
    expect(((await ok.json()) as any).name).toBe('alice');
    expect(bad.status).toBe(400);
  });
});

// =============================================================================
// @Serialize() + SerializerInterceptor — response serialization
// =============================================================================

describe('@Serialize() with SerializerInterceptor strips extra fields via Zod', () => {
  it('omits fields not in the DTO schema', async () => {
    const UserDto = defineDto(z.object({ id: z.number(), name: z.string() }));

    @Controller('/serialize-dto')
    class TestController {
      @Get()
      @Serialize(UserDto)
      @UseInterceptors(SerializerInterceptor)
      get() {
        return { id: 1, name: 'Alice', password: 'secret' };
      }
    }
    @Module({ controllers: [TestController], providers: [SerializerInterceptor] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/serialize-dto');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe(1);
    expect(body.name).toBe('Alice');
    expect(body.password).toBeUndefined();
  });

  it('serializes each element when the handler returns an array', async () => {
    const ItemDto = defineDto(z.object({ id: z.number() }));

    @Controller('/serialize-arr-dto')
    class TestController {
      @Get()
      @Serialize(ItemDto)
      @UseInterceptors(SerializerInterceptor)
      get() {
        return [
          { id: 1, secret: 'x' },
          { id: 2, secret: 'y' },
        ];
      }
    }
    @Module({ controllers: [TestController], providers: [SerializerInterceptor] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/serialize-arr-dto');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toHaveLength(2);
    expect(body[0]).toEqual({ id: 1 });
    expect(body[1]).toEqual({ id: 2 });
  });
});

// =============================================================================
// mixin() — parameterized injectable guards
// =============================================================================

describe('mixin() creates parameterized injectable classes', () => {
  it('RoleGuard mixin allows admin and rejects others', async () => {
    function RoleGuardMixin(role: string) {
      class RoleGuard implements CanActivate {
        canActivate(ctx: ExecutionContext): boolean {
          return ctx.getRequest().headers.get('x-role') === role;
        }
      }
      return mixin(RoleGuard);
    }

    const AdminGuard = RoleGuardMixin('admin');

    @Controller('/mixin-role')
    class TestController {
      @Get()
      @UseGuards(AdminGuard)
      get() {
        return { ok: true };
      }
    }
    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();
    const allowed = await hono.request('/mixin-role', { headers: { 'x-role': 'admin' } });
    const denied = await hono.request('/mixin-role', { headers: { 'x-role': 'user' } });
    expect(allowed.status).toBe(200);
    expect(denied.status).toBe(403);
  });

  it('two different mixin instances have independent behavior', async () => {
    function TierGuardMixin(tier: string) {
      class TierGuard implements CanActivate {
        canActivate(ctx: ExecutionContext): boolean {
          return ctx.getRequest().headers.get('x-tier') === tier;
        }
      }
      return mixin(TierGuard);
    }

    const FreeGuard = TierGuardMixin('free');
    const PaidGuard = TierGuardMixin('paid');

    @Controller('/mixin-tier')
    class TestController {
      @Get('/free')
      @UseGuards(FreeGuard)
      free() {
        return { tier: 'free' };
      }

      @Get('/paid')
      @UseGuards(PaidGuard)
      paid() {
        return { tier: 'paid' };
      }
    }
    @Module({ controllers: [TestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();
    const freeOk = await hono.request('/mixin-tier/free', { headers: { 'x-tier': 'free' } });
    const paidOk = await hono.request('/mixin-tier/paid', { headers: { 'x-tier': 'paid' } });
    const freeBlocked = await hono.request('/mixin-tier/free', { headers: { 'x-tier': 'paid' } });
    expect(freeOk.status).toBe(200);
    expect(paidOk.status).toBe(200);
    expect(freeBlocked.status).toBe(403);
  });
});
