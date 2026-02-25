import { describe, it, expect, beforeEach } from 'vitest';
import {
  Test,
  Controller,
  Get,
  Injectable,
  Inject,
  Module,
  InjectionToken,
  UseGuards,
  UseInterceptors,
  MetadataRegistry,
} from '../index.js';
import type {
  CanActivate,
  ExecutionContext,
  NestInterceptor,
  CallHandler,
} from '../index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

// =============================================================================
// 1. compile() creates a working module — resolve a simple service via get()
// =============================================================================

describe('Test.createTestingModule', () => {
  it('should compile and resolve a simple service via get()', async () => {
    @Injectable()
    class GreetService {
      greet() {
        return 'hello';
      }
    }

    const moduleRef = await Test.createTestingModule({
      providers: [GreetService],
    }).compile();

    const service = moduleRef.get(GreetService);
    expect(service).toBeInstanceOf(GreetService);
    expect(service.greet()).toBe('hello');
  });

  // ===========================================================================
  // 2. overrideProvider().useValue() — mock replaces real service
  // ===========================================================================

  it('should override a provider with useValue', async () => {
    @Injectable()
    class DataService {
      getData() {
        return 'real-data';
      }
    }

    const moduleRef = await Test.createTestingModule({
      providers: [DataService],
    })
      .overrideProvider(DataService)
      .useValue({ getData: () => 'mocked-data' })
      .compile();

    const service = moduleRef.get(DataService);
    expect(service.getData()).toBe('mocked-data');
  });

  // ===========================================================================
  // 3. overrideProvider().useClass() — alternative class replaces original
  // ===========================================================================

  it('should override a provider with useClass', async () => {
    @Injectable()
    class OriginalService {
      getValue() {
        return 'original';
      }
    }

    class MockService {
      getValue() {
        return 'mock';
      }
    }

    const moduleRef = await Test.createTestingModule({
      providers: [OriginalService],
    })
      .overrideProvider(OriginalService)
      .useClass(MockService)
      .compile();

    const service = moduleRef.get(OriginalService);
    expect(service.getValue()).toBe('mock');
  });

  // ===========================================================================
  // 4. overrideProvider().useFactory() — factory with injected deps
  // ===========================================================================

  it('should override a provider with useFactory', async () => {
    @Injectable()
    class ConfigService {
      getPrefix() {
        return 'prefix';
      }
    }

    @Injectable()
    class FormatterService {
      format(value: string) {
        return value;
      }
    }

    const moduleRef = await Test.createTestingModule({
      providers: [ConfigService, FormatterService],
    })
      .overrideProvider(FormatterService)
      .useFactory({
        factory: (config: ConfigService) => ({
          format: (value: string) => `${config.getPrefix()}-${value}`,
        }),
        inject: [ConfigService],
      })
      .compile();

    const formatter = moduleRef.get<{ format: (v: string) => string }>(FormatterService);
    expect(formatter.format('test')).toBe('prefix-test');
  });

  // ===========================================================================
  // 5. overrideGuard().useValue() — swap guard, verify endpoint behavior
  // ===========================================================================

  it('should override a guard with useValue', async () => {
    @Injectable()
    class AuthGuard implements CanActivate {
      canActivate(_context: ExecutionContext): boolean {
        return false; // always block
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

    // Override guard to always allow
    const moduleRef = await Test.createTestingModule({
      providers: [AuthGuard],
      controllers: [SecureController],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    const app = moduleRef.createNestApplication();
    const hono = app.getHonoApp();

    const res = await hono.request('/secure');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ secret: 'data' });
  });

  // ===========================================================================
  // 6. overrideInterceptor().useValue() — swap interceptor
  // ===========================================================================

  it('should override an interceptor with useValue', async () => {
    @Injectable()
    class WrapInterceptor implements NestInterceptor {
      async intercept(_ctx: ExecutionContext, next: CallHandler) {
        const result = await next.handle();
        return { data: result, original: true };
      }
    }

    @Controller('/wrapped')
    @UseInterceptors(WrapInterceptor)
    class WrappedController {
      @Get()
      hello() {
        return 'hello';
      }
    }

    // Override interceptor to just pass through
    const moduleRef = await Test.createTestingModule({
      providers: [WrapInterceptor],
      controllers: [WrappedController],
    })
      .overrideInterceptor(WrapInterceptor)
      .useValue({
        intercept: async (_ctx: ExecutionContext, next: CallHandler) => {
          const result = await next.handle();
          return { data: result, mocked: true };
        },
      })
      .compile();

    const app = moduleRef.createNestApplication();
    const hono = app.getHonoApp();

    const res = await hono.request('/wrapped');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: 'hello', mocked: true });
  });

  // ===========================================================================
  // 7. createNestApplication() returns working VelaApplication with getHonoApp()
  // ===========================================================================

  it('should return a VelaApplication from createNestApplication()', async () => {
    @Controller('/ping')
    class PingController {
      @Get()
      ping() {
        return { pong: true };
      }
    }

    @Module({ controllers: [PingController] })
    class PingModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [PingModule],
    }).compile();

    const app = moduleRef.createNestApplication();
    expect(app).toBeDefined();
    expect(typeof app.getHonoApp).toBe('function');
    expect(typeof app.get).toBe('function');

    const hono = app.getHonoApp();
    const res = await hono.request('/ping');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pong: true });
  });

  // ===========================================================================
  // 8. Full HTTP integration: override service, hit endpoint, verify mocked response
  // ===========================================================================

  it('should support full HTTP integration with overridden service', async () => {
    @Injectable()
    class UserService {
      getUser(id: string) {
        return { id, name: 'Real User' };
      }
    }

    @Controller('/users')
    class UserController {
      constructor(private userService: UserService) {}

      @Get('/:id')
      findOne() {
        return this.userService.getUser('1');
      }
    }

    const moduleRef = await Test.createTestingModule({
      providers: [UserService],
      controllers: [UserController],
    })
      .overrideProvider(UserService)
      .useValue({ getUser: (id: string) => ({ id, name: 'Mock User' }) })
      .compile();

    const app = moduleRef.createNestApplication();
    const hono = app.getHonoApp();

    const res = await hono.request('/users/1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: '1', name: 'Mock User' });
  });

  // ===========================================================================
  // 9. Multiple overrides chained in same builder
  // ===========================================================================

  it('should support multiple chained overrides', async () => {
    @Injectable()
    class ServiceA {
      getValue() {
        return 'a';
      }
    }

    @Injectable()
    class ServiceB {
      getValue() {
        return 'b';
      }
    }

    @Controller('/multi')
    class MultiController {
      constructor(
        private a: ServiceA,
        private b: ServiceB,
      ) {}

      @Get()
      handle() {
        return { a: this.a.getValue(), b: this.b.getValue() };
      }
    }

    const moduleRef = await Test.createTestingModule({
      providers: [ServiceA, ServiceB],
      controllers: [MultiController],
    })
      .overrideProvider(ServiceA)
      .useValue({ getValue: () => 'mock-a' })
      .overrideProvider(ServiceB)
      .useValue({ getValue: () => 'mock-b' })
      .compile();

    const app = moduleRef.createNestApplication();
    const hono = app.getHonoApp();

    const res = await hono.request('/multi');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ a: 'mock-a', b: 'mock-b' });
  });

  // ===========================================================================
  // 10. Override with InjectionToken (not just class token)
  // ===========================================================================

  it('should override providers using InjectionToken', async () => {
    const API_URL = new InjectionToken<string>('API_URL');

    @Injectable()
    class ApiService {
      constructor(@Inject(API_URL) private url: string) {}

      getUrl() {
        return this.url;
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

    const moduleRef = await Test.createTestingModule({
      providers: [
        ApiService,
        { token: API_URL, useValue: 'https://real-api.com' },
      ],
      controllers: [ApiController],
    })
      .overrideProvider(API_URL)
      .useValue('https://mock-api.com')
      .compile();

    const app = moduleRef.createNestApplication();
    const hono = app.getHonoApp();

    const res = await hono.request('/api/url');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://mock-api.com' });
  });

  // ===========================================================================
  // close() delegates to the application
  // ===========================================================================

  it('should call close() on the underlying application', async () => {
    const calls: string[] = [];

    @Injectable()
    class CleanupService {
      onModuleDestroy() {
        calls.push('destroyed');
      }
    }

    const moduleRef = await Test.createTestingModule({
      providers: [CleanupService],
    }).compile();

    await moduleRef.close();
    expect(calls).toContain('destroyed');
  });
});
