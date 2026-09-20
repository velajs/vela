import { describe, it, expect, beforeEach } from 'vitest';
import {
  Injectable,
  Inject,
  Controller,
  Get,
  Module,
  InjectionToken,
  REQUEST_CONTEXT,
  RequestContextKey,
  UseGuards,
  MetadataRegistry,
  createLazyParamDecorator,
  defineProvider,
} from '@velajs/vela';
import type { CanActivate, ExecutionContext, OnModuleInit, OnModuleDestroy } from '@velajs/vela';
import { Test } from '../test.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

// =============================================================================
// 1. Basic compile + get()
// =============================================================================

describe('Test.createTestingModule', () => {
  it('should compile a module and resolve a provider', async () => {
    @Injectable()
    class CatsService {
      findAll() {
        return ['cat1', 'cat2'];
      }
    }

    @Module({ providers: [CatsService] })
    class CatsModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [CatsModule],
    }).compile();

    const service = moduleRef.get(CatsService);
    expect(service.findAll()).toEqual(['cat1', 'cat2']);
  });

  // ===========================================================================
  // 2. Inline providers (no module import)
  // ===========================================================================

  it('should support inline providers without importing a module', async () => {
    @Injectable()
    class InlineService {
      value = 42;
    }

    const moduleRef = await Test.createTestingModule({
      providers: [InlineService],
    }).compile();

    const service = moduleRef.get(InlineService);
    expect(service.value).toBe(42);
  });

  // ===========================================================================
  // 3. overrideProvider().useValue()
  // ===========================================================================

  it('should override a provider with useValue', async () => {
    @Injectable()
    class UsersService {
      getUsers() {
        return ['real-user'];
      }
    }

    @Module({ providers: [UsersService] })
    class UsersModule {}

    const mockService = { getUsers: () => ['mock-user'] };

    const moduleRef = await Test.createTestingModule({
      imports: [UsersModule],
    })
      .overrideProvider(UsersService)
      .useValue(mockService)
      .compile();

    const service = moduleRef.get(UsersService);
    expect(service.getUsers()).toEqual(['mock-user']);
  });

  // ===========================================================================
  // 4. overrideProvider() with InjectionToken
  // ===========================================================================

  it('should override token-based providers', async () => {
    const DB_URL = new InjectionToken<string>('DB_URL');

    @Module({
      providers: [defineProvider(DB_URL, { useValue: 'postgres://prod' })],
    })
    class DbModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [DbModule],
    })
      .overrideProvider(DB_URL)
      .useValue('sqlite://test')
      .compile();

    const url = moduleRef.get(DB_URL);
    expect(url).toBe('sqlite://test');
  });

  // ===========================================================================
  // 5. overrideProvider().useClass()
  // ===========================================================================

  it('should override a provider with useClass', async () => {
    @Injectable()
    class RealMailer {
      send() {
        return 'real-email-sent';
      }
    }

    @Injectable()
    class FakeMailer {
      send() {
        return 'fake-email-sent';
      }
    }

    @Module({ providers: [RealMailer] })
    class MailModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [MailModule],
    })
      .overrideProvider(RealMailer)
      .useClass(FakeMailer)
      .compile();

    const mailer = moduleRef.get(RealMailer);
    expect(mailer.send()).toBe('fake-email-sent');
  });

  // ===========================================================================
  // 6. overrideProvider().useFactory()
  // ===========================================================================

  it('should override a provider with useFactory', async () => {
    const CONFIG = new InjectionToken<{ env: string }>('CONFIG');

    @Injectable()
    class EnvService {
      getEnv() {
        return 'test';
      }
    }

    @Module({
      providers: [EnvService, defineProvider(CONFIG, { useValue: { env: 'production' } })],
    })
    class ConfigModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule],
    })
      .overrideProvider(CONFIG)
      .useFactory({
        factory: (envService) => ({ env: envService.getEnv() }),
        inject: [EnvService],
      })
      .compile();

    const config = moduleRef.get(CONFIG);
    expect(config).toEqual({ env: 'test' });
  });

  // ===========================================================================
  // 7. createApplication() for HTTP testing
  // ===========================================================================

  it('should create an application for HTTP testing', async () => {
    @Injectable()
    class ItemsService {
      getItems() {
        return [{ id: 1, name: 'Item 1' }];
      }
    }

    @Controller('/items')
    class ItemsController {
      constructor(private itemsService: ItemsService) {}

      @Get()
      findAll() {
        return this.itemsService.getItems();
      }
    }

    @Module({
      providers: [ItemsService],
      controllers: [ItemsController],
    })
    class ItemsModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [ItemsModule],
    }).compile();

    const app = await moduleRef.createApplication();
    const hono = app.getHonoApp();

    const res = await hono.request('/items');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 1, name: 'Item 1' }]);
  });

  // ===========================================================================
  // 8. Overridden providers in HTTP responses
  // ===========================================================================

  it('should use overridden providers in HTTP responses', async () => {
    @Injectable()
    class PriceService {
      getPrice() {
        return 99.99;
      }
    }

    @Controller('/price')
    class PriceController {
      constructor(private priceService: PriceService) {}

      @Get()
      getPrice() {
        return { price: this.priceService.getPrice() };
      }
    }

    @Module({
      providers: [PriceService],
      controllers: [PriceController],
    })
    class PriceModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [PriceModule],
    })
      .overrideProvider(PriceService)
      .useValue({ getPrice: () => 0 })
      .compile();

    const app = await moduleRef.createApplication();
    const hono = app.getHonoApp();

    const res = await hono.request('/price');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ price: 0 });
  });

  // ===========================================================================
  // 9. overrideGuard()
  // ===========================================================================

  it('should override a guard', async () => {
    @Injectable()
    class AuthGuard implements CanActivate {
      canActivate(_context: ExecutionContext): boolean {
        return false; // always blocks
      }
    }

    @Controller('/secure')
    @UseGuards(AuthGuard)
    class SecureController {
      @Get()
      secret() {
        return { secret: 'data' };
      }
    }

    @Module({
      providers: [AuthGuard],
      controllers: [SecureController],
    })
    class SecureModule {}

    // Override the guard to always allow
    const moduleRef = await Test.createTestingModule({
      imports: [SecureModule],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    const app = await moduleRef.createApplication();
    const hono = app.getHonoApp();

    const res = await hono.request('/secure');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ secret: 'data' });
  });

  // ===========================================================================
  // 10. Lifecycle hooks
  // ===========================================================================

  it('should call onModuleInit at compile and onModuleDestroy at close', async () => {
    const calls: string[] = [];

    @Injectable()
    class LifecycleService implements OnModuleInit, OnModuleDestroy {
      onModuleInit() {
        calls.push('init');
      }
      onModuleDestroy() {
        calls.push('destroy');
      }
    }

    @Module({ providers: [LifecycleService] })
    class LifecycleModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [LifecycleModule],
    }).compile();

    expect(calls).toEqual(['init']);

    await moduleRef.close();
    expect(calls).toEqual(['init', 'destroy']);
  });

  // ===========================================================================
  // 11. Multiple chained overrides
  // ===========================================================================

  it('should support multiple chained overrides', async () => {
    @Injectable()
    class ServiceA {
      getValue() {
        return 'real-a';
      }
    }

    @Injectable()
    class ServiceB {
      getValue() {
        return 'real-b';
      }
    }

    @Injectable()
    class ServiceC {
      constructor(
        private a: ServiceA,
        private b: ServiceB,
      ) {}

      getCombined() {
        return `${this.a.getValue()}-${this.b.getValue()}`;
      }
    }

    @Module({ providers: [ServiceA, ServiceB, ServiceC] })
    class MultiModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [MultiModule],
    })
      .overrideProvider(ServiceA)
      .useValue({ getValue: () => 'mock-a' })
      .overrideProvider(ServiceB)
      .useValue({ getValue: () => 'mock-b' })
      .compile();

    const serviceC = moduleRef.get(ServiceC);
    expect(serviceC.getCombined()).toBe('mock-a-mock-b');
  });

  // ===========================================================================
  // 12. REQUEST_CONTEXT-injecting guard works under Test.createTestingModule
  // ===========================================================================
  // Regression: before bootstrap-parity in compile(), guards that injected
  // REQUEST_CONTEXT (the documented vela pattern for @CurrentUser-style
  // lazy decorators) crashed with "REQUEST_CONTEXT can only be resolved
  // inside a request" because the testing builder skipped bootstrap's
  // request-scoped registration. This pins the behavior.

  it('supports guards + lazy param decorators backed by REQUEST_CONTEXT', async () => {
    const USER_KEY = new RequestContextKey<{ id: string }>('test.user');

    // The canonical vela pattern: a guard resolves REQUEST_CONTEXT from the
    // per-request child container (seeded by RouteManager via
    // setRequestInstance) and writes into its bag. A lazy parameter decorator
    // reads the same bag when the handler invokes its lazy function. Both
    // ordinary and lazy parameter decorators execute after guards.
    @Injectable()
    class GuardThatPopulates implements CanActivate {
      async canActivate(context: ExecutionContext): Promise<boolean> {
        const container = context.getContainer();
        if (!container) throw new Error('Missing request container');
        const reqCtx = container.resolve(REQUEST_CONTEXT);
        reqCtx.set(USER_KEY, { id: 'u-1' });
        return true;
      }
    }

    const CurrentUser = createLazyParamDecorator((_data, ctx: ExecutionContext) => {
      return ctx.getContainer()?.resolve(REQUEST_CONTEXT).get(USER_KEY);
    });

    @Controller('/me')
    @UseGuards(GuardThatPopulates)
    class MeController {
      @Get()
      me(@CurrentUser() loadUser: () => { id: string } | undefined) {
        return { id: loadUser()?.id };
      }
    }

    @Module({
      providers: [GuardThatPopulates],
      controllers: [MeController],
    })
    class GuardModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [GuardModule],
    }).compile();

    const app = await moduleRef.createApplication();
    const res = await app.getHonoApp().request('/me');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'u-1' });
  });
});
