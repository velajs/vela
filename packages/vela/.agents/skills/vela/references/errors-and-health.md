# Errors, Health, Throttling & Caching

Built-in HTTP exceptions and exception filters, plus the `HealthModule`, `ThrottlerModule`, and `CacheModule`. All on the main export `@velajs/vela`.

## HTTP exceptions

Throw an `HttpException` subclass from anywhere in the request path; Vela renders it with the right status. Each subclass takes an optional message (string or object):

```ts
import { NotFoundException, BadRequestException, ConflictException } from '@velajs/vela';

throw new NotFoundException(`Product ${id} not found`);   // 404
throw new BadRequestException({ field: 'email', reason: 'invalid' }); // 400, object body
```

The full family (status in parens): `BadRequestException`(400), `UnauthorizedException`(401), `ForbiddenException`(403), `NotFoundException`(404), `MethodNotAllowedException`(405), `NotAcceptableException`(406), `RequestTimeoutException`(408), `ConflictException`(409), `GoneException`(410), `PayloadTooLargeException`(413), `UnsupportedMediaTypeException`(415), `UnprocessableEntityException`(422), `TooManyRequestsException`(429), `InternalServerErrorException`(500), `NotImplementedException`(501), `BadGatewayException`(502), `ServiceUnavailableException`(503), `GatewayTimeoutException`(504).

The base `HttpException(response, statusCode)` takes the **response first, status second** (note the order). Methods: `getStatus()` → number, `getResponse()` → normalized object.

## Exception filters

`@Catch(...ErrorTypes)` + an `ExceptionFilter` intercepts matching errors. Zero args = catch-all. Apply with `@UseFilters` (controller/method) or globally via `defineProvider(APP_FILTER, { useClass: X })`:

```ts
import { Catch, ExceptionFilter, ExecutionContext, HttpException } from '@velajs/vela';

@Catch(BadRequestException, ForbiddenException)
class ClientErrorFilter implements ExceptionFilter {
  catch(exception: HttpException, _ctx: ExecutionContext): unknown {
    return { error: true, status: exception.getStatus() };
  }
}
```

Filters run closest-first (handler → controller → global) — see `pipeline.md`.

## Health checks — `HealthModule`

Import `HealthModule` (plain module, no options) and write your own endpoint injecting `HealthCheckService` + `HealthIndicatorService`:

```ts
import { HealthModule, HealthCheckService, HealthIndicatorService } from '@velajs/vela';

@Controller('/health')
class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicator: HealthIndicatorService,
  ) {}

  @Get()
  check() {
    return this.health.check([
      async () => this.indicator.check('app').up({ version: '1.0.0' }),
    ]);
  }
}
```

`check(indicators[])` runs each indicator (`() => Promise<HealthIndicatorResult>`), returns `{ status: 'ok' | 'error' | 'shutting_down', info, error, details }`, and throws `ServiceUnavailableException` (503) if any indicator is down or the app is shutting down. `HealthIndicatorService.check(key).up(data?)` / `.down(data?)` build results. `HttpHealthIndicator.pingCheck(key, url, { timeout?, expectedStatus? })` checks a remote URL via `fetch`.

## Throttling — `ThrottlerModule`

`ThrottlerModule.forRoot({ limit, ttl })` registers a global rate-limit guard (`APP_GUARD`) — importing it throttles all routes:

```ts
import { ThrottlerModule, Throttle, SkipThrottle } from '@velajs/vela';

@Module({ imports: [ThrottlerModule.forRoot({ limit: 100, ttl: 60_000 })] }) // ttl in MILLISECONDS
class AppModule {}

@Controller('/api')
class ApiController {
  @Get('/tight')
  @Throttle({ limit: 1, ttl: 60_000 })   // per-route override (both fields required)
  tight() { return { ok: true }; }

  @Get('/open')
  @SkipThrottle()                          // exempt this route
  open() { return { ok: true }; }
}
```

`ThrottlerModuleOptions`: `limit`, `ttl` (**milliseconds**), optional `storage`, `getTracker(request)` (application override), `generateKey`. It sets `X-RateLimit-*` headers and throws `TooManyRequestsException` (429) with `Retry-After` when the limit is exceeded. Custom stores implement `ThrottlerStore` (`increment(key, ttlMs)`, `reset(key)`); the default is in-memory.

## Caching — `CacheModule`

`CacheModule.forRoot({ ttl, max })` provides `CacheService` (manual) and `CacheInterceptor` (auto-cache GET responses):

```ts
import { CacheModule, CacheService, CacheInterceptor, CacheKey, CacheTTL } from '@velajs/vela';

@Module({ imports: [CacheModule.forRoot({ ttl: 60, max: 100 })] }) // ttl in SECONDS
class AppModule {}

@Controller('/reports')
class ReportsController {
  constructor(private readonly cache: CacheService) {}

  @Get('/summary')
  @UseInterceptors(CacheInterceptor)   // opt-in per route (or CacheModule.forRoot({ isGlobal: true }))
  @CacheKey('reports:summary')
  @CacheTTL(30)
  summary() { return this.buildSummary(); }

  @Get('/manual')
  manual() {
    const value = this.cache.get('n');
    const hit = typeof value === 'number' ? value : 0;
    this.cache.set('n', hit + 1);      // set(key, value, ttl?)
    return { count: hit + 1 };
  }
}
```

`CacheModuleOptions`: `ttl` (**seconds**, default 5), `max` (default 100), `isGlobal?` (registers `CacheInterceptor` app-wide), `store?`. `CacheService`: raw unknown `get(key)`, parser-inferred `getParsed(key, schema)`, `set(key, value, ttl?)`, `del(key)`, `clear()`. `CacheInterceptor` caches GET only; the key is `@CacheKey` or `cache:GET:<path>`. Stores: `MemoryCacheStore` (default) and `TieredCacheStore` (multi-tier, async).
