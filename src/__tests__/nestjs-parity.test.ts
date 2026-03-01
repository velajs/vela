import { describe, it, expect, beforeEach } from 'vitest';
import {
  VelaFactory,
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
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
  UseGuards,
  UseInterceptors,
  UsePipes,
  UseFilters,
  SetMetadata,
  Reflector,
  applyDecorators,
  RequestMethod,
  ModuleRef,
  mixin,
  InjectionToken,
  ConfigModule,
  ConfigService,
} from '../index.js';
import type {
  MiddlewareConsumer,
  NestModule,
  CanActivate,
  ExecutionContext,
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
        { token: APP_GUARD, useExisting: ApiKeyGuard },
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
        { token: APP_INTERCEPTOR, useExisting: WrapInterceptor },
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
        { token: APP_PIPE, useExisting: TrimPipe },
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
        { token: APP_GUARD, useExisting: FirstGuard },
        { token: APP_GUARD, useExisting: SecondGuard },
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
      providers: [{ token: MY_TOKEN, useValue: 'token-value' }],
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
