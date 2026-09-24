# Errors, Health, Throttling & Caching

Built-in HTTP exceptions and exception filters are on the main export `@velajs/vela`. `HealthModule` comes from `@velajs/vela/health`, `ThrottlerModule` from `@velajs/vela/throttler`, and `CacheModule` from `@velajs/vela/cache`.

## HTTP exceptions

Throw an `HttpException` subclass from anywhere in the request path; Vela renders it with the right status. Each subclass takes an optional message (string or object):

```ts
import { NotFoundException, BadRequestException, ConflictException } from '@velajs/vela';

throw new NotFoundException(`Product ${id} not found`);   // 404
throw new BadRequestException({ field: 'email', reason: 'invalid' }); // 400, object body
```

The full family (status in parens): `BadRequestException`(400), `UnauthorizedException`(401), `ForbiddenException`(403), `NotFoundException`(404), `MethodNotAllowedException`(405), `NotAcceptableException`(406), `RequestTimeoutException`(408), `ConflictException`(409), `GoneException`(410), `PayloadTooLargeException`(413), `UnsupportedMediaTypeException`(415), `UnprocessableEntityException`(422), `TooManyRequestsException`(429), `InternalServerErrorException`(500), `NotImplementedException`(501), `BadGatewayException`(502), `ServiceUnavailableException`(503), `GatewayTimeoutException`(504).

The base `HttpException(response, statusCode, options?)` takes the **response first, status second** (note the order); `options` is `{ details?, cause? }`, and each subclass takes `(message?, options?)`. Methods: `getStatus()` → number, `getResponse()` → normalized object, `getDetails()`, and `toResponse()`.

## One HTTP error renderer

Every HTTP failure — controller handlers, Vela middleware, raw Hono middleware (the last-resort `onError`), unmatched routes, request limits, RPC and GraphQL — renders through `renderHttpError(error, { catalog?, redactServerBodies? })` from `@velajs/vela`, after exception filters and the application's `ExceptionHandler.render` hook:

1. An exception-owned `toResponse()` returning `{ status, body }` (400–599). `HttpException` built with an object returns it verbatim (a health check's 503); `@velajs/crud`'s `CrudException` returns its `{ success: false, error }` envelope. Extend `HttpException` and override `toResponse()` to own a wire shape: only exceptions its constructor built own a response, and any other thrown object with a `toResponse()` is an unknown error (reported, redacted 500). Raw Hono middleware and RPC redact an owned 5xx body to its status title.
2. A string `HttpException` becomes `{ error: { code, message, details? } }`, with `code` taken from the status (`not_found`, `not_acceptable`, …; an unmapped 4xx is `bad_request`). A 5xx is a server fault: the client gets only the status title (for example `{ error: { code: 'internal', message: 'Internal Server Error' } }`), never your text or details.
3. A Hono `HTTPException` below 500 renders its message in that body; one built with its own `res` (an auth challenge) keeps that response.
4. Branded `VelaError`s render their code, message and data as `details`; anything else is a redacted 500.

Error edges answer only 400–599: as in Nest, `new HttpException(body, 302)` constructs and `getStatus()` returns 302, but it is reported and renders as a redacted 500. Redirect with `@Redirect()` or a returned `Response`.

Validation failures (`ValidationPipe`, `@Body(schema)`) render `{ error: { code: 'bad_request', message: 'Validation failed', details: { issues } } }`. An unmatched route answers `{ error: { code: 'not_found', message: 'Not Found' } }` with 404; an oversized body answers 413 `payload_too_large`. These framework rejections are not reported; as in Nest, global exception filters receive them (`NotFoundException`, `PayloadTooLargeException`, `BadRequestException`), and a filter's plain result keeps their status.

```ts
import { HttpException, type HttpErrorResponse } from '@velajs/vela';

class LockedException extends HttpException {
  constructor(readonly until: Date) { super('Locked', 423); }
  override toResponse(): HttpErrorResponse {
    return { status: 423, body: { error: { code: 'locked', until: this.until.toISOString() } } };
  }
}
```

## Exception filters

`@Catch(...ErrorTypes)` + an `ExceptionFilter` intercepts matching errors. Zero args = catch-all. Apply with `@UseFilters` (controller/method) or globally with a `{ provide: APP_FILTER, useClass: X }` provider. The first matching filter decides:

- a `Response` is sent as is;
- `{ status, body }` (exactly those keys) sets the status explicitly;
- any other value is the body, sent with the exception's status (`getErrorStatus(exception)`: `HttpException.getStatus()`, `VelaError.status`, else 500);
- `undefined` means not handled: the default renderer runs (never an empty 204).

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

Import `HealthModule` bare or through `HealthModule.forRoot()` (no options; both forms are one instance) and write your own endpoint injecting `HealthCheckService` + `HealthIndicatorService`:

```ts
import { HealthModule, HealthCheckService, HealthIndicatorService } from '@velajs/vela/health';

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
import { ThrottlerModule, Throttle, SkipThrottle } from '@velajs/vela/throttler';

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

`ThrottlerModuleOptions`: `limit`, `ttl` (**milliseconds**), optional `storage`, `getTracker(request)` (application override), `generateKey`. It sets `X-RateLimit-*` headers, publishes `{ limit, remaining?, reset }` under the `RATE_LIMIT` request-context key (`requestContext.get(RATE_LIMIT)`), and throws `TooManyRequestsException` (429) with `Retry-After` when the limit is exceeded. `ThrottlerGuard` runs in the `feature` guard phase, after authentication, so it partitions by the trusted identity whatever the import order. Custom stores implement `ThrottlerStore` (`increment(key, ttlMs)`, `reset(key)`); the default is in-memory.

## Caching — `CacheModule`

`CacheModule.forRoot({ ttl, max })` provides `CacheService` (manual) and `CacheInterceptor` (auto-cache GET responses):

```ts
import {
  CacheModule,
  CacheService,
  CacheInterceptor,
  Cacheable,
  CacheKey,
  CacheTTL,
} from '@velajs/vela/cache';

@Module({ imports: [CacheModule.forRoot({ ttl: 60, max: 100 })] }) // ttl in SECONDS
class AppModule {}

@Controller('/reports')
class ReportsController {
  constructor(private readonly cache: CacheService) {}

  @Get('/summary')
  @UseInterceptors(CacheInterceptor)   // opt-in per route (or CacheModule.forRoot({ globalInterceptor: true }))
  @Cacheable()
  @CacheKey('reports:summary')
  @CacheTTL(30)
  summary() { return this.buildSummary(); }

  private buildSummary() { return { total: 0 }; }

  @Get('/manual')
  manual() {
    const value = this.cache.get('n');
    const hit = typeof value === 'number' ? value : 0;
    this.cache.set('n', hit + 1);      // set(key, value, ttl?)
    return { count: hit + 1 };
  }
}
```

`CacheModuleOptions`: `ttl` (seconds, default 5), `max` (default 100), `globalInterceptor?` (registers `CacheInterceptor` app-wide; structural), `store?` (synchronous only), `varyBy?` (trusted principal/tenant partition). Routes require `@Cacheable()`. Custom keys are suffixes beneath host/path/canonical query. Credentialed requests need an explicit trusted variation. `CacheService` stays synchronous with unknown raw reads and parser-inferred `getParsed`.

For asynchronous stores, use `ResponseCacheModule.forRoot({ namespace, store, scope, invalidation? })` and `@CacheResponse({ ttl, tags, key })`. This module installs its opt-in interceptor automatically. `scope(context)` runs after guards and returns `{ visibility: 'public' | 'private', partition }` from trusted identity/tenant data, or undefined to bypass. Guards authorize every hit. Never mix `@Cacheable` and `@CacheResponse` on one route.

Inject `ResponseCacheService` and obtain `cache.scope(trustedScope)` for async `get`, `getParsed`, `set`, `remember`, `invalidateKey`, `invalidateTags`, and `invalidateAll`. Tags and whole-scope invalidation reach routes and custom values in that partition only. Invalidate after a successful commit. Invalidation resolves `{ ok: true }` or `{ ok: false, reason }`, so cache failures do not report a committed write as failed. Tags require optional `CacheInvalidationStore`; `MemoryCacheInvalidationStore` is process-local, and `KVCacheInvalidationStore` in `@velajs/cloudflare` is eventually consistent.

The async path caches only bounded JSON snapshots, never responses, streams, cookie-setting output or authentication secrets. Generation stamps fence old fills, and absolute expiry prevents stale replay. `TieredCacheStore` promotes only known-expiry entries into destinations implementing `CacheEntryWriter`, preserving their absolute deadline. KV generations require a dedicated namespace without expiry/reset; successful KV invalidation is not a global read-after-write guarantee. See `docs/caching.md` in the repository for the complete contract.


## Application-owned structured logging

Optional tracing and metrics live in `@velajs/vela/observability`. Install
`observabilityAdapter({ telemetry })` with application-owned recorders; defaults
are inert and do not create exporters. `getRequestTelemetry(requestContext)`
provides explicit invocation-local state. `createHttpClientTelemetryObserver`
connects to `HttpModule.forRoot({ observer })`; `createExecutionTelemetryObserver`
is structurally usable by optional execution integrations. SDK setup and flushing
remain application-owned. See `docs/observability.md` for the complete contracts.

Import `LoggingModule.forRoot({ directive: 'warn,orders=debug', sinks: [...] })`
once per application and inject `APP_LOGGER` (`ApplicationLogger`).
`createLogger(category, fields)` returns a `LoggerService`-compatible child;
`withFields` snapshots extra context and `extend` changes the category.
`subscribe(LogSink)` receives immutable, bounded, redacted JSON-safe `LogRecord`
values and returns an unsubscribe function. No console patching is involved.
Legacy `Logger` and text `Writer` settings remain independent.

Use `loggerForScope(actualChildContainer, category, fields)` for automatic
`invocationId`, HTTP `requestId`, and async delivery tracking through the existing
execution lifetime. Passing the root does not establish request context. Scoped
loggers stop at lifetime closure. `flush()` waits for currently pending sink
work; delivery failures are contained and reported by logger diagnostics.

Default exception reports use APP_LOGGER when installed. Custom
`ExceptionHandler.report` remains a replacement, so installing logging does not
double-report custom errors. Default 4xx/silent suppression and client rendering
remain unchanged. Correlation conveys no identity authority.

Serialization skips getters/toJSON and bounds depth, width, nodes and strings.
Error causes are retained; accessor-backed stacks use `[Accessor]`. Add
application `redactKeys`; default key redaction cannot discover credentials in
free text. The own data marker `[Symbol.for('vela.secret')] === true` redacts
an entire secret wrapper. Do not log request/environment objects wholesale.
