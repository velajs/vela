# Security migration (1.21)

Vela 1.21 intentionally tightens request, cache, capability, identity, and
WebSocket boundaries. These changes are breaking where an older default was
unsafe or ambiguous.

The packages use a staged publish order because Live Protocol 1.1 and Vela 1.21
change security-sensitive wire contracts. Follow
[COORDINATED_RELEASE.md](COORDINATED_RELEASE.md); consumer release scripts
also verify their exact upstream versions are public before publishing.

## HTTP parser limits

Every app now limits bodies to 1 MiB, query strings to 8 KiB, query entries to
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

`bodyLimit` remains as a legacy alias, but cannot be combined with
`security.body.maxBytes`. Use `false` only for a narrow streaming override when
a trusted outer proxy enforces an equivalent bound. Production Node runtimes
(and edge runtimes without `process`) warn when global limits are disabled or
raised above the secure defaults, when a streaming limit is disabled, or when a
WebSocket gateway opts out of Origin isolation with `allowedOrigins: '*'`.

## Request execution order and parameters

HTTP requests now run in this order:

1. framework body/query limits and route middleware;
2. global and route guards;
3. parameter extraction and pipes;
4. interceptors;
5. the controller handler.

Parameter decorators no longer execute before guards. Move authentication and
other authority-producing work into middleware or guards, then read the
guard-populated request state with an ordinary `createParamDecorator`. Optional
identity decorators must return the real `undefined` value for anonymous
requests. Lazy decorators inject explicit functions: call the function before
checking its returned identity, rather than checking the function's truthiness.

Denied guards therefore run before JSON parsing and validation pipes. A guard
that intentionally verifies the raw body, such as `@SignedInvocation()`, may
still read it through the framework's bounded capture seam.

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
keying. `@CacheKey` is now a suffix beneath host + canonical path/query, and
responses that set cookies are never stored.

## Signed URLs

Generic `signUrl` calls now require `{ expiresIn, method, purpose }`, and
`verifySignedUrl` requires `{ method, purpose }`. Missing expiry is invalid.
The v2 signature payload is method- and purpose-separated, so regenerate every
v1 URL during deployment. Named HTTP routes and Cloudflare storage provide fixed
purposes automatically.

## Client identity and authorization scope

Core no longer trusts `X-Forwarded-For` or `X-Real-IP`. `@Ip()` returns `null`
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

HTTP and WebSocket `ExecutionContext` now expose `getModuleId()` so authorization
can resolve policy in the declaring module bucket rather than by class name.

## WebSockets and Live

Browser upgrades default to same-origin, can run pre-allocation authorization,
validate room IDs, cap frames, and fail closed when connection hooks reject.
Identity expiry is the epoch-millisecond `expiresAtMs` field; malformed or
expired identities are rejected.

`maxFrameBytes` now applies symmetrically to input and output. The default is
64 KiB; direct `WsClient` sends, dispatcher replies, and local/Redis broadcast
delivery close only the oversized recipient with code 1009 and never write the
frame. Custom transports should expose the connection's validated
`WsClient.maxFrameBytes` so the shared registry applies the same boundary.

Every parameterized `@WebSocketGateway({ path })` must now set `roomParam` to
the one path parameter that owns the room. Bootstrap rejects missing,
non-existent, duplicate, or ambiguous parameters. Durable Object names include
both the gateway path and validated room, so callers must also pass the exact
gateway path to Cloudflare broadcast/live helpers.
