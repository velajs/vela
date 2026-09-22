# Security configuration

Configure request limits, browser origins, caching, and verified identity at the
application boundary.

## HTTP parser limits

Every app limits bodies to 1 MiB, query strings to 8 KiB, query entries to
100, and bracket/dot nesting to depth 5 before user middleware runs. Configure
the unified policy at bootstrap:

```ts
const app = await VelaFactory.create(AppModule, {
  security: {
    body: {
      maxBytes: 1024 * 1024,
      streamingOverrides: [
        { path: '/uploads/*', methods: ['POST'], maxBytes: 10 * 1024 * 1024 },
      ],
    },
    query: { maxBytes: 8192, maxParameters: 100, maxDepth: 5 },
  },
});
```

Use `false` only for a narrow streaming override when
a trusted outer proxy enforces an equivalent bound. Production Node runtimes
(and edge runtimes without `process`) warn when global limits are disabled or
raised above the secure defaults, when a streaming limit is disabled, or when a
WebSocket gateway opts out of Origin isolation with `allowedOrigins: '*'`.

JSON bodies read by `@Body()` and `defineEndpoint` `json` groups must use
`application/json` or a `+json` media type such as `application/vnd.api+json`;
parameters like `charset` are allowed. Any other body returns 415, because
browsers send `text/plain` and form-encoded POSTs cross-site without a CORS
preflight. A request without a body still reaches the handler as `undefined`.
Routes registered directly on Hono can apply the same rule with
`readJsonBody(c)`.

`defineEndpoint` form contracts add bounded parsing after guards. Set
`body.contentType` to `multipart/form-data` or `application/x-www-form-urlencoded`
and optionally tighten `maxBytes`, `maxFields`, `maxFieldBytes`, `maxFiles`, and
`maxFileBytes`. Defaults are 1 MiB encoded bytes, 100 text entries, 64 KiB per text
entry (including its UTF-8 name), 10 files, and 1 MiB per file. Repeated entries
count individually. Endpoint limits supplement the application policy; raise a
route's outer limit too when accepting larger bodies. The encoded byte limit
runs before native parsing; part limits run before schema validation. Unknown
fields, duplicate scalar fields, and wrong text/file kinds return 400; a wrong
media type returns 415; size/count violations return 413. See
[form contracts](client/HTTP.md#form-bodies-and-uploads).

## Request execution order and parameters

HTTP requests run in this order:

1. framework body/query limits and route middleware;
2. global and route guards;
3. parameter extraction and pipes;
4. interceptors;
5. the controller handler.

Perform authentication and other authority-producing work in middleware or
guards, then read the
guard-populated request state with an ordinary `createParamDecorator`. Optional
identity decorators must return the real `undefined` value for anonymous
requests. Lazy decorators inject explicit functions: call the function before
checking its returned identity, rather than checking the function's truthiness.

Denied guards therefore run before JSON/form parsing and validation pipes. A guard
that intentionally verifies the raw body, such as `@SignedInvocation()`, may
still read it through the framework's bounded capture seam.

### Middleware route targets

Middleware bound with `consumer.apply(...).forRoutes(...)` resolves its targets
when routes are built. A controller target covers each of its routes and methods,
including the global prefix and URI version. Path targets use Hono route patterns
under the global prefix and also cover nested paths. `exclude()` patterns match
exactly.

Some routes are served outside the global prefix: `mountOpenApi()` documents
(`/openapi.json`, `/scalar`, `/docs`, `/redoc`), the `RpcModule` endpoint
(`/rpc`), Cloudflare WebSocket gateway upgrade paths, Studio mounted with
`absolute: true`, and routes added to the Hono app directly. Target them with
`absolute: true`, which matches the path as written:

```ts
consumer
  .apply(AuditMiddleware)
  .forRoutes({ path: '/rpc', method: HttpMethod.POST, absolute: true });
```

## Browser security

Import `SecurityModule` for exact-origin CORS, credentialed unsafe-method Origin
checks, and restrictive response headers:

```ts
@Module({
  imports: [
    SecurityModule.forRoot({
      allowedOrigins: ['https://app.example.com'],
      cors: {
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['content-type', 'authorization'],
      },
    }),
  ],
})
class AppModule {}
```

Wildcard origins are rejected. Cookie-authenticated POST/PUT/PATCH/DELETE
requests require a same-origin or allowlisted `Origin` by default. The module
also emits `nosniff`, no-referrer, frame denial, HSTS on HTTPS, and an API-safe
CSP; customize or explicitly disable individual headers when serving HTML.

## Response caching

Routes must opt in with `@Cacheable()`, even when `CacheInterceptor` is global.
Credential-bearing requests bypass caching unless `CacheModule.forRoot` provides
a stable `varyBy(request)` principal/tenant value. Vela hashes that value before
keying. `@CacheKey` is a suffix beneath host + canonical path/query, and
responses that set cookies are never stored.

For asynchronous stores and explicit scoped invalidation, use
[`ResponseCacheModule` and `@CacheResponse`](caching.md). Its scope resolver runs
after guards, private scopes require trusted identity/tenant dimensions, and
cache failures cannot turn committed writes into reported rollbacks.

## Signed URLs

Generic `signUrl` calls require `{ expiresIn, method, purpose }`, and
`verifySignedUrl` requires `{ method, purpose }`. Missing expiry is invalid.
The signature payload is method- and purpose-separated. Named HTTP routes and
Cloudflare storage provide fixed
purposes automatically.

## Client identity and authorization scope

Core does not trust `X-Forwarded-For` or `X-Real-IP`. `@Ip()` returns `null`
unless `VelaFactory.create({ getClientIp })` or one runtime adapter supplies a
trusted resolver. Authentication guards can publish a canonical principal and
verified tenant with `setTrustedRequestIdentity(request, identity)`. When that
guard runs before `ThrottlerGuard`, default throttling partitions by both values
before considering any fallback. Better Auth publishes this state automatically
and uses its verified `activeOrganizationId` when present.

Without trusted identity, throttling uses `getTracker(request, context)` and then
the runtime-attested client address; unknown callers share one fail-closed
`anonymous` bucket. Cloudflare uses only its platform connection signal. Custom
tracker callbacks remain security-sensitive and must never read forwarding
headers. Import/register authentication before `ThrottlerModule` so its global
guard establishes identity first.

HTTP and WebSocket `ExecutionContext` expose `getModuleId()` so authorization
can resolve policy in the declaring module bucket rather than by class name.

## WebSockets and Live

Browser upgrades default to same-origin, can run pre-allocation authorization,
validate room IDs, cap frames, and fail closed when connection hooks reject.
Identity expiry is the epoch-millisecond `expiresAtMs` field; malformed or
expired identities are rejected.

`maxFrameBytes` applies symmetrically to input and output. The default is
64 KiB; direct `WsClient` sends, dispatcher replies, and local/Redis broadcast
delivery close only the oversized recipient with code 1009 and never write the
frame. Custom transports should expose the connection's validated
`WsClient.maxFrameBytes` so the shared registry applies the same boundary.

Every parameterized `@WebSocketGateway({ path })` must set `roomParam` to
the one path parameter that owns the room. Bootstrap rejects missing,
non-existent, duplicate, or ambiguous parameters. Durable Object names include
both the gateway path and validated room, so callers must also pass the exact
gateway path to Cloudflare broadcast/live helpers.

## Admitted tenants and authentication payload

Authenticate before running `TenantGuard`, then apply authorization and throttling. Tenant
admission preserves `CurrentUser`, `CurrentSession`, and `CurrentAccessIdentity` payloads.
The core identity remains an immutable snapshot; use it (or `CurrentTenant`) for the admitted
tenant rather than assuming an identity-provider payload contains the selected tenant.

Custom authentication integrations can keep provider payload in
`createTrustedRequestIdentityStore<Payload>()`. The store accepts data only after
`setTrustedRequestIdentity(request, identity)` publishes verified authority. Its contents
disappear after clear, expiry, or any ordinary identity replacement, including replacement
with the same principal. Trusted tenant admission calls
`setTrustedRequestTenant(request, expectedIdentity, tenantId)` only after checking membership.
That operation requires the exact current live identity and cannot switch an already-bound tenant.
It preserves the authentication payload without changing principal, roles, claims, or expiry.

For an HTTP-backed custom dispatcher, call
`bindTrustedRequestContext(context, originalRequest)` before running policy guards. This
explicit association enables `getTrustedContextRequest(context)` and the authz identity
bridge; it neither authenticates nor copies authority. Authenticate and admit the tenant
once before concurrent resolver fields. Better Auth and Cloudflare Access guards on these
bound custom contexts read existing provider payload instead of authenticating again.
Queue and socket payloads never become HTTP authority through this mechanism.

## Non-browser cookie clients

`SecurityModule.forRoot({ originProtection: { allowMissingOrigin: true } })` permits an
absent Origin for credentialed non-browser requests. The default still rejects it. An
explicit empty, null, malformed or disallowed Origin is rejected even with the option,
and CORS preflights still require an allowed Origin.

## Secret values

`new Secret(value)` keeps its value in a JavaScript `#private` field and renders
`[Redacted]` through JSON, string conversion and inspection. Read the value explicitly
with `.reveal()` only where needed. This is a representation boundary, not encryption
or protection against code that can call `reveal()`. Existing signing APIs still accept
strings. Custom structured loggers can recognize the own data descriptor
`Symbol.for('vela.secret')` with value `true` without invoking serialization methods.
