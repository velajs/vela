import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  VelaFactory,
  Controller,
  Get,
  Post,
  Module,
  Injectable,
  InjectionToken,
  MetadataRegistry,
  HttpModule,
  HttpService,
  HttpRequestException,
} from '../index.js';

beforeEach(() => {
  MetadataRegistry.clear();
  vi.restoreAllMocks();
});

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const contentType = typeof body === 'string' ? 'text/plain' : 'application/json';
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': contentType, ...headers },
    }),
  );
}

// =============================================================================
// HttpModule
// =============================================================================

describe('HttpModule', () => {
  it('should inject HttpService and perform a GET request', async () => {
    mockFetch(200, { id: 1, name: 'Alice' });

    @Injectable()
    class UserService {
      constructor(private http: HttpService) {}
      async getUser() {
        const res = await this.http.get<{ id: number; name: string }>('https://api.test/user/1');
        return res.data;
      }
    }

    @Controller('/users')
    class UserController {
      constructor(private svc: UserService) {}
      @Get()
      async handle() {
        return this.svc.getUser();
      }
    }

    @Module({
      imports: [HttpModule],
      providers: [UserService],
      controllers: [UserController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/users');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 1, name: 'Alice' });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.test/user/1',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('should use baseURL from HttpModule.forRoot()', async () => {
    mockFetch(200, { ok: true });

    @Injectable()
    class ApiService {
      constructor(private http: HttpService) {}
      ping() {
        return this.http.get('/ping');
      }
    }

    @Controller('/test')
    class TestController {
      constructor(private api: ApiService) {}
      @Get()
      async handle() {
        const res = await this.api.ping();
        return res.data;
      }
    }

    @Module({
      imports: [HttpModule.forRoot({ baseURL: 'https://api.example.com' })],
      providers: [ApiService],
      controllers: [TestController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await app.getHonoApp().request('/test');
    expect(fetch).toHaveBeenCalledWith('https://api.example.com/ping', expect.anything());
  });

  it('should serialize body as JSON for POST', async () => {
    mockFetch(201, { created: true });

    @Injectable()
    class PostService {
      constructor(private http: HttpService) {}
      create(data: unknown) {
        return this.http.post('https://api.test/items', data);
      }
    }

    @Controller('/create')
    class CreateController {
      constructor(private svc: PostService) {}
      @Post()
      async handle() {
        const res = await this.svc.create({ name: 'widget' });
        return res.data;
      }
    }

    @Module({
      imports: [HttpModule],
      providers: [PostService],
      controllers: [CreateController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await app.getHonoApp().request('/create', { method: 'POST' });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.test/items',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'widget' }),
      }),
    );
  });

  it('should append query params to the URL', async () => {
    mockFetch(200, []);

    @Injectable()
    class SearchService {
      constructor(private http: HttpService) {}
      search() {
        return this.http.get('https://api.test/search', { params: { q: 'hello', page: 2 } });
      }
    }

    @Controller('/search')
    class SearchController {
      constructor(private svc: SearchService) {}
      @Get()
      async handle() {
        const res = await this.svc.search();
        return res.data;
      }
    }

    @Module({
      imports: [HttpModule],
      providers: [SearchService],
      controllers: [SearchController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await app.getHonoApp().request('/search');
    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain('q=hello');
    expect(url).toContain('page=2');
  });

  it('should throw HttpRequestException on non-2xx responses', async () => {
    mockFetch(404, { message: 'Not Found' });

    @Injectable()
    class FailService {
      constructor(private http: HttpService) {}
      async fetch() {
        return this.http.get('https://api.test/missing');
      }
    }

    @Controller('/fail')
    class FailController {
      constructor(private svc: FailService) {}
      @Get()
      async handle() {
        try {
          await this.svc.fetch();
          return { ok: true };
        } catch (e) {
          if (e instanceof HttpRequestException) {
            return { error: e.status };
          }
          throw e;
        }
      }
    }

    @Module({
      imports: [HttpModule],
      providers: [FailService],
      controllers: [FailController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/fail');
    expect(await res.json()).toEqual({ error: 404 });
  });

  it('should merge default headers with per-request headers', async () => {
    mockFetch(200, {});

    @Injectable()
    class AuthService {
      constructor(private http: HttpService) {}
      call() {
        return this.http.get('https://api.test/me', {
          headers: { 'X-Request-Id': '123' },
        });
      }
    }

    @Controller('/auth')
    class AuthController {
      constructor(private svc: AuthService) {}
      @Get()
      async handle() {
        await this.svc.call();
        return { ok: true };
      }
    }

    @Module({
      imports: [HttpModule.forRoot({ headers: { Authorization: 'Bearer token' } })],
      providers: [AuthService],
      controllers: [AuthController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await app.getHonoApp().request('/auth');
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer token');
    expect((init.headers as Record<string, string>)['X-Request-Id']).toBe('123');
  });

  it('registerAsync() should resolve baseURL from an injected service', async () => {
    mockFetch(200, { ok: true });

    const API_BASE = new InjectionToken<string>('API_BASE');

    @Injectable()
    class ApiConfigService {
      getBaseUrl() {
        return 'https://async.example.com';
      }
    }

    @Injectable()
    class AsyncApiService {
      constructor(private http: HttpService) {}
      ping() {
        return this.http.get('/ping');
      }
    }

    @Controller('/async-test')
    class AsyncController {
      constructor(private api: AsyncApiService) {}
      @Get()
      async handle() {
        const res = await this.api.ping();
        return res.data;
      }
    }

    @Module({
      imports: [
        HttpModule.forRootAsync({
          imports: [],
          useFactory: (cfg: ApiConfigService) => ({ baseURL: cfg.getBaseUrl() }),
          inject: [ApiConfigService],
        }),
      ],
      providers: [ApiConfigService, AsyncApiService],
      controllers: [AsyncController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await app.getHonoApp().request('/async-test');
    expect(fetch).toHaveBeenCalledWith('https://async.example.com/ping', expect.anything());
  });
});
