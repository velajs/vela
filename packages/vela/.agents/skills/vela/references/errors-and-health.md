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

The base `HttpException(response, statusCode)` takes the **response first, status second** (note the order). Methods: `getStatus()` → number, `getResponse()` → normalized object.

Unfiltered exceptions render the same way from handlers, middleware, and raw Hono middleware. A string response becomes `{ error: { code, message } }`, with `code` taken from the status (`not_found`, `not_acceptable`, …; an unmapped 4xx is `bad_request`). A 5xx string response is a server fault: the client gets only the status title (for example `{ error: { code: 'internal', message: 'Internal Server Error' } }`), never your text. Object responses ship verbatim from controller handlers and Vela middleware, and from raw Hono middleware below 500; a 5xx object response thrown by raw Hono middleware is redacted to its status title the same way.

## Exception filters

`@Catch(...ErrorTypes)` + an `ExceptionFilter` intercepts matching errors. Zero args = catch-all. Apply with `@UseFilters` (controller/method) or globally with a `{ provide: APP_FILTER, useClass: X }` provider:

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

A throttler without `name` is `'default'`; `@SkipThrottle()` skips `'default'` only, as in Nest. A route's `limit` and `ttl` for a name override its controller's field by field, as in Nest v5 (`{ limit }` on a route keeps the controller's `ttl`); both must be positive integers. `@Throttle()` naming an undeclared throttler fails bootstrap. Headers: `X-RateLimit-Limit`, `-Remaining`, `-Reset` and `Retry-After` for `'default'`, suffixed `-<name>` for the others (`X-RateLimit-Limit-short`); the first throttler exceeded answers 429 (`TooManyRequestsException`). `ThrottlerModuleOptions`: `throttlers` (non-empty, unique names, positive integer `ttl`/`limit`), `storage?` (a `ThrottlerStore` or `(env) => ThrottlerStore`; default per-application memory), `getTracker(request, context)` (fallback after trusted identity), `generateKey(context, tracker, throttlerName)`. Custom stores implement `ThrottlerStore` (`increment(key, ttl, limit, throttlerName)`, `reset(key)`, optional `fixedLimits`). On Workers, `storage: rateLimitStore({ binding: 'API_LIMITER' })` (or `{ binding: { short: 'BURST', long: 'API' } }`) from `@velajs/cloudflare` uses Workers Rate Limiting bindings: each binding's `simple.limit`/`period` must equal its throttler's `limit`/`ttl` (10 or 60 s), and since the platform enforces them, a `@Throttle()` override that changes them fails bootstrap; one binding serves only throttlers sharing a `limit`/`ttl`. Its counters are per location and eventually consistent (approximate limits); for strict ones implement a `ThrottlerStore` counting in a Durable Object.

## Caching — `CacheModule`

`CacheModule` is the one cache module, asynchronous end to end. `namespace` and a trusted `scope(context)` resolver are required; `store` defaults to a per-application `MemoryCacheStore` (`max` entries, default 1000):

```ts
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
}
```

`CacheModuleOptions`: `namespace`, `scope`, `store?` (a `CacheStore`, sync or async, or `(env) => CacheStore`), `invalidation?` (a `CacheInvalidationStore` or `(env) => …`), `ttl?`, `max?`, `maxBytes?`, `shouldCache?`, `onError?`. On Workers use `store: kvCache({ binding: 'CACHE' })` and `invalidation: kvCacheInvalidation({ binding: 'CACHE_GENERATIONS' })` from `@velajs/cloudflare`: each reads its namespace from the application's `ENV` when used. Configure one `CacheModule` per application (`forRoot` or `forRootAsync`); it installs its interceptor automatically, and scopes return `{ visibility: 'public' | 'private', partition }` from trusted identity/tenant data. Guards authorize every hit; public scopes bypass credentialed requests.

Inject `CacheService` and obtain `cache.scope(trustedScope)` for async `get`, `getParsed`, `set`, `remember`, `invalidateKey`, `invalidateTags`, and `invalidateAll`. Tags and whole-scope invalidation reach routes and custom values in that partition only. Invalidate after a successful commit. Invalidation resolves `{ ok: true }` or `{ ok: false, reason }`, so cache failures do not report a committed write as failed. Tags require a `CacheInvalidationStore`; `MemoryCacheInvalidationStore` is process-local, and the KV one is eventually consistent.

Only bounded JSON snapshots are cached, never responses, streams, cookie-setting output or authentication secrets. Generation stamps fence old fills, and absolute expiry prevents stale replay. `TieredCacheStore` promotes only known-expiry entries into destinations implementing `CacheEntryWriter`, preserving their absolute deadline. KV generations require a dedicated namespace without expiry/reset; successful KV invalidation is not a global read-after-write guarantee. See `docs/caching.md` in the repository for the complete contract.


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
