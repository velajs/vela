import { describe, expect, it } from 'vitest';
import {
  Catch,
  Controller,
  Get,
  Global,
  Inject,
  Injectable,
  InjectionToken,
  Module,
  MultipleProvidersFoundError,
  NONCE_STORE,
  Param,
  REQUEST_CONTEXT,
  Reflector,
  Scope,
  SetMetadata,
  SkipThrottle,
  ThrottlerModule,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UsePipes,
  VelaFactory,
  defineProvider,
  resolvePipelineComponents,
  type ArgumentMetadata,
  type CallHandler,
  type CanActivate,
  type ExceptionFilter,
  type ExecutionContext,
  type NestInterceptor,
  type OnModuleInit,
  type NonceStore,
  type PipeTransform,
  type RequestContext,
} from '../index';
import { instantiate } from '../http/instantiate';
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

  it('gives an undecorated subclass the dependencies its parent declares', async () => {
    class AdminRolesGuard extends RolesGuard {}

    @Controller('/admin')
    @UseGuards(AdminRolesGuard)
    class AdminController {
      @Roles('admin')
      @Get()
      index() {
        return { ok: true };
      }
    }

    @Module({ controllers: [AdminController] })
    class AdminModule {}

    const app = await VelaFactory.create(AdminModule, { diagnostics: 'throw' });
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

  it('keeps the request scope an undecorated subclass inherits', async () => {
    const ids: string[] = [];

    @Injectable({ scope: Scope.REQUEST })
    class RequestGuard implements CanActivate {
      readonly id = crypto.randomUUID();
      canActivate(): boolean {
        ids.push(this.id);
        return true;
      }
    }

    @Injectable({ scope: Scope.REQUEST })
    class RequestRolesGuard extends RolesGuard {
      readonly id = crypto.randomUUID();
      override canActivate(context: ExecutionContext): boolean {
        ids.push(this.id);
        return super.canActivate(context);
      }
    }

    // One inherits no constructor dependencies, the other inherits the Reflector.
    class ParameterlessGuard extends RequestGuard {}
    class InjectedGuard extends RequestRolesGuard {}

    @Controller('/inherited')
    @UseGuards(ParameterlessGuard, InjectedGuard)
    class InheritedController {
      @Get()
      index() {
        return {};
      }
    }

    @Module({ controllers: [InheritedController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();
    expect((await hono.request('/inherited')).status).toBe(200);
    expect((await hono.request('/inherited')).status).toBe(200);
    expect(new Set(ids).size).toBe(4);
    await app.close();
  });

  it('builds an operation guard that another module registers without reaching into it', async () => {
    class OpenGuard implements CanActivate {
      canActivate(): boolean {
        return true;
      }
    }

    @Controller('/open')
    @UseGuards(OpenGuard)
    class OpenController {
      @Get()
      index() {
        return {};
      }
    }

    @Module({ controllers: [OpenController] })
    class OpenModule {}

    @Injectable()
    class OperationResolver {}

    @Module({ providers: [OperationResolver] })
    class OperationModule {}

    @Module({ imports: [OpenModule, OperationModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const container = app.getContainer();
    const [moduleId] = container.getOwnerModuleIds(OperationResolver);
    const [guard] = await resolvePipelineComponents('guard', [OpenGuard], container, moduleId);
    expect(guard).toBeInstanceOf(OpenGuard);
    expect(instantiate(OpenGuard, container, moduleId)).toBeInstanceOf(OpenGuard);
    await app.close();
  });

  it('builds a global guard class without materializing a lazy module that references it', async () => {
    const built: string[] = [];

    class AuditGuard implements CanActivate {
      constructor() {
        built.push('guard');
      }
      canActivate(): boolean {
        return true;
      }
    }

    @Controller('/lazy')
    @UseGuards(AuditGuard)
    class LazyController {
      @Get()
      index() {
        return {};
      }
    }

    @Module({ lazy: true, controllers: [LazyController] })
    class LazyFeature {}

    @Controller('/eager')
    class EagerController {
      @Get()
      index() {
        return {};
      }
    }

    @Module({ imports: [LazyFeature], controllers: [EagerController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    app.useGlobalGuards(AuditGuard);
    expect((await app.getHonoApp().request('/eager')).status).toBe(200);
    expect(built).toEqual(['guard']);
    expect(app.getContainer().isLazyPending(LazyController)).toBe(true);
    await app.close();
  });

  it('runs a module class hook after its providers, controllers and enhancers', async () => {
    const calls: string[] = [];

    class HookGuard implements CanActivate, OnModuleInit {
      onModuleInit(): void {
        calls.push('guard');
      }
      canActivate(): boolean {
        return true;
      }
    }

    @Injectable()
    class HookService implements OnModuleInit {
      onModuleInit(): void {
        calls.push('service');
      }
    }

    @Controller('/hooks')
    @UseGuards(HookGuard)
    class HookController implements OnModuleInit {
      onModuleInit(): void {
        calls.push('controller');
      }
      @Get()
      index() {
        return {};
      }
    }

    @Module({ providers: [HookService], controllers: [HookController] })
    class HookModule implements OnModuleInit {
      onModuleInit(): void {
        calls.push('module');
      }
    }

    @Injectable()
    class ConsumerService implements OnModuleInit {
      onModuleInit(): void {
        calls.push('consumer');
      }
    }

    @Module({ imports: [HookModule], providers: [ConsumerService] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    // Like Nest, each module finishes with its class, before its importers' providers.
    expect(calls.slice(0, 3).toSorted()).toEqual(['controller', 'guard', 'service']);
    expect(calls.slice(3)).toEqual(['module', 'consumer']);
    await app.close();

    calls.length = 0;
    @Module({ lazy: true, providers: [HookService], controllers: [HookController] })
    class LazyHookModule implements OnModuleInit {
      onModuleInit(): void {
        calls.push('module');
      }
    }

    @Module({ imports: [LazyHookModule] })
    class LazyAppModule {}

    const lazyApp = await VelaFactory.create(LazyAppModule);
    expect(calls).toEqual([]);
    expect((await lazyApp.getHonoApp().request('/hooks')).status).toBe(200);
    expect(calls.slice(0, 3).toSorted()).toEqual(['controller', 'guard', 'service']);
    expect(calls.at(-1)).toBe('module');
    await lazyApp.close();
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

describe('framework-global providers', () => {
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

  it('serve the application Reflector when a module also lists one', async () => {
    @Module({ providers: [Reflector] })
    class ReportsModule {}

    @Module({ imports: [ReportsModule, AdminModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const response = await app.getHonoApp().request('/admin', { headers: { 'x-role': 'admin' } });
    expect(response.status).toBe(200);
    await app.close();
  });

  it('serve the Reflector a global module exports to guards, built-in guards included', async () => {
    @Global()
    @Module({ providers: [Reflector], exports: [Reflector] })
    class SharedModule {}

    @Injectable()
    class ReflectorReader {
      constructor(readonly reflector: Reflector) {}
    }

    @Controller('/limited')
    class LimitedController {
      @Get()
      index() {
        return {};
      }

      @Get('/open')
      @SkipThrottle()
      open() {
        return {};
      }
    }

    @Module({
      imports: [ThrottlerModule.forRoot({ limit: 2, ttl: 60_000 })],
      providers: [ReflectorReader],
      controllers: [LimitedController],
    })
    class LimitedModule {}

    @Module({ imports: [SharedModule, AdminModule, LimitedModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();
    expect((await hono.request('/admin', { headers: { 'x-role': 'admin' } })).status).toBe(200);
    expect((await hono.request('/admin')).status).toBe(403);
    for (const status of [200, 200, 429]) {
      expect((await hono.request('/limited')).status).toBe(status);
    }
    for (const status of [200, 200, 200]) {
      expect((await hono.request('/limited/open')).status).toBe(status);
    }
    const container = app.getContainer();
    const [sharedId] = container.getOwnerModuleIds(SharedModule);
    expect(app.get(ReflectorReader).reflector).toBe(container.resolve(Reflector, sharedId));
    await app.close();
  });

  it('let a global module override a framework default such as NONCE_STORE', async () => {
    @Injectable()
    class SharedNonceStore implements NonceStore {
      async claim(): Promise<boolean> {
        return true;
      }
    }

    @Global()
    @Module({
      providers: [{ provide: NONCE_STORE, useClass: SharedNonceStore }],
      exports: [NONCE_STORE],
    })
    class NonceModule {}

    @Injectable()
    class TicketService {
      constructor(@Inject(NONCE_STORE) readonly nonces: NonceStore) {}
    }

    @Module({ providers: [TicketService] })
    class TicketModule {}

    @Module({ imports: [NonceModule, TicketModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(app.get(TicketService).nonces).toBeInstanceOf(SharedNonceStore);
    await app.close();
  });

  it('ignore a copy another module keeps private', async () => {
    const REGION = new InjectionToken<string>('shared region');

    @Global()
    @Module({ providers: [{ provide: REGION, useValue: 'global' }], exports: [REGION] })
    class RegionModule {}

    @Module({ providers: [{ provide: REGION, useValue: 'private' }] })
    class PrivateModule {}

    @Injectable()
    class RegionReader {
      constructor(@Inject(REGION) readonly region: string) {}
    }

    @Module({ imports: [RegionModule, PrivateModule], providers: [RegionReader] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(app.get(RegionReader).region).toBe('global');
    const [appId] = app.getContainer().getOwnerModuleIds(AppModule);
    expect(app.getContainer().resolveAll(REGION, appId)).toEqual(['global']);
    await app.close();
  });

  it('still report a token that two global modules export', async () => {
    const REGION = new InjectionToken<string>('global region');

    @Global()
    @Module({ providers: [defineProvider(REGION, { useValue: 'north' })], exports: [REGION] })
    class NorthModule {}

    @Global()
    @Module({ providers: [defineProvider(REGION, { useValue: 'south' })], exports: [REGION] })
    class SouthModule {}

    @Injectable()
    class RegionReader {
      constructor(@Inject(REGION) readonly region: string) {}
    }

    @Module({ imports: [NorthModule, SouthModule], providers: [RegionReader] })
    class AppModule {}

    await expect(VelaFactory.create(AppModule)).rejects.toThrow(MultipleProvidersFoundError);
  });
});
