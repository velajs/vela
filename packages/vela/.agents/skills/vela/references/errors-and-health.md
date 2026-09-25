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

Nest v5 named throttlers. `ThrottlerModule.forRoot({ throttlers: [{ name?, ttl, limit }, ...], storage? })` registers a global rate-limit guard (`APP_GUARD`) — importing it throttles all routes, counting every request once per throttler, each in its own bucket:

```ts
import { ThrottlerModule, Throttle, SkipThrottle } from '@velajs/vela/throttler';

@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [
        { name: 'short', ttl: 1_000, limit: 3 },    // ttl in MILLISECONDS
        { name: 'long', ttl: 60_000, limit: 100 },
      ],
    }),
  ],
})
class AppModule {}

@Controller('/api')
class ApiController {
  @Get('/tight')
  @Throttle({ long: { limit: 10 } })        // override one named throttler (ttl/limit optional)
  tight() { return { ok: true }; }

  @Get('/burst-ok')
  @SkipThrottle({ short: true })           // skip one named throttler
  burst() { return { ok: true }; }
}
```

A throttler without `name` is `'default'`; `@SkipThrottle()` skips `'default'` only, as in Nest. A route's `limit` and `ttl` for a name override its controller's field by field, as in Nest v5 (`{ limit }` on a route keeps the controller's `ttl`); both must be positive integers. `@Throttle()` naming an undeclared throttler fails bootstrap, including one a controller inherits from an ancestor class. Headers: `X-RateLimit-Limit`, `-Remaining`, `-Reset` and `Retry-After` for `'default'`, suffixed `-<name>` for the others (`X-RateLimit-Limit-short`); the first throttler exceeded answers 429 (`TooManyRequestsException`). The guard publishes one `{ limit, remaining?, reset }` per throttler name under the `RATE_LIMIT` request-context key (`requestContext.get(RATE_LIMIT)?.default`). `ThrottlerGuard` runs in the `feature` guard phase, after authentication, so it partitions by the trusted identity whatever the import order. `ThrottlerModuleOptions`: `throttlers` (non-empty, unique names, positive integer `ttl`/`limit`), `storage?` (a `ThrottlerStore` or `(env) => ThrottlerStore`; default per-application memory, `ThrottlerStorage`, which keeps each counter for its whole `ttl` and tracks at most `maxKeys` open windows, default 50,000, one per route × throttler × client: when all are open a new key gets 429 until one ends, so size it with `storage: () => new ThrottlerStorage({ maxKeys })`), `getTracker(request, context)` (fallback after trusted identity), `generateKey(context, tracker, throttlerName)`. Custom stores implement `ThrottlerStore` (`increment(key, ttl, limit, throttlerName)`, `reset(key)`, optional `fixedLimits`, optional `validate(throttlers)` called with the declared throttlers at bootstrap). On Workers, `storage: rateLimitStore({ binding: 'API_LIMITER' })` (or `{ binding: { short: 'BURST', long: 'API' } }`) from `@velajs/cloudflare` uses Workers Rate Limiting bindings: each binding's `simple.limit`/`period` must equal its throttler's `limit`/`ttl` (10 or 60 s), and since the platform enforces them, a `@Throttle()` override that changes them fails bootstrap; one binding serves only throttlers sharing a `limit`/`ttl`, and the store fails bootstrap for another period, mixed values on one binding or a throttler its map leaves out. Its counters are per location and eventually consistent (approximate limits); for strict ones implement a `ThrottlerStore` counting in a Durable Object.

## Caching — `CacheModule`

`CacheModule` is the one cache module, asynchronous end to end. `namespace` and a trusted `scope(context)` resolver are required; `store` defaults to a per-application `MemoryCacheStore` (`max` entries, default 1000):

```ts
import { Body, Controller, Get, Module, Post } from '@velajs/vela';
import { CacheModule, CacheResponse, CacheService, MemoryCacheInvalidationStore } from '@velajs/vela/cache';

@Module({
  imports: [
    CacheModule.forRoot({
      namespace: 'reports-v1',
      scope: (context) => trustedScope(context),        // runs after guards; undefined bypasses
      invalidation: () => new MemoryCacheInvalidationStore(), // needed for tags; a function builds one per app
      ttl: 30,                                          // seconds, default 30
    }),
  ],
})
class AppModule {}

@Controller('/reports')
class ReportsController {
  constructor(private readonly cache: CacheService) {}

  @Get('/summary')
  @CacheResponse({ ttl: 30, tags: ['reports'], key: 'summary' }) // opt-in; undecorated routes never cache
  summary() { return this.buildSummary(); }

  @Post('/')
  async create(@Body() body: unknown) {
    const created = await this.save(body);
    await this.cache.scope(trustedScope()).invalidateTags(['reports']); // after commit
    return created;
  }

  private buildSummary() { return { total: 0 }; }
  private async save(body: unknown) { return body; }
}
```

`CacheModuleOptions`: `namespace`, `scope`, `store?` (a `CacheStore`, sync or async, or `(env) => CacheStore`), `invalidation?` (a `CacheInvalidationStore` or `(env) => …`), `ttl?`, `max?`, `maxBytes?`, `shouldCache?`, `onError?`. On Workers use `store: kvCache({ binding: 'CACHE' })` and `invalidation: kvCacheInvalidation({ binding: 'CACHE_GENERATIONS' })` from `@velajs/cloudflare`: each reads its namespace from the application's `ENV` when used. Configure one `CacheModule` per application (`forRoot` or `forRootAsync`); it installs its interceptor automatically, and scopes return `{ visibility: 'public' | 'private', partition }` from trusted identity/tenant data. Guards authorize every hit; public scopes bypass credentialed requests.

Inject `CacheService` and obtain `cache.scope(trustedScope)` for async `get`, `getParsed`, `set`, `remember`, `invalidateKey`, `invalidateTags`, and `invalidateAll`. Tags and whole-scope invalidation reach routes and custom values in that partition only. Invalidate after a successful commit. Invalidation resolves `{ ok: true }` or `{ ok: false, reason }`, so cache failures do not report a committed write as failed. Tags require a `CacheInvalidationStore`; `MemoryCacheInvalidationStore` is process-local, and the KV one is eventually consistent.

A route entry is the bounded JSON or text response the route sent (after interceptors and its `response` schema), replayed on a hit without running the handler; interceptors outside the cache receive the replayed `Response`, and what they did for the request that stored it is replayed to every request in the scope, so partition the scope by everything any interceptor or the handler varies the response on (role, locale, viewer). `shouldCache` receives the sent body, JSON-decoded. A fallback an interceptor outside `CacheInterceptor` sends when the call inside it fails or is still pending (error recovery, timeout default) is never cached; a fallback an interceptor inside it (controller, method, or a global one registered after `CacheModule`'s) returns for a failed handler is that call's result and is cached. Handler-returned `Response`s, streams, cookie-setting output and authentication secrets are never cached. Generation stamps fence old fills, and absolute expiry prevents stale replay. `TieredCacheStore` promotes only known-expiry entries into destinations implementing `CacheEntryWriter`, preserving their absolute deadline. KV generations require a dedicated namespace without expiry/reset; successful KV invalidation is not a global read-after-write guarantee. See `docs/caching.md` in the repository for the complete contract.


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
