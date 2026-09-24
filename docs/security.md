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

JSON bodies read by `@Body()` must use `application/json` or a `+json` media
type such as `application/vnd.api+json`; parameters like `charset` are allowed.
Any other body returns 415, because browsers send `text/plain` and form-encoded
POSTs cross-site without a CORS preflight. A request without a body still
reaches the handler as `undefined`. Routes registered directly on Hono can apply
the same rule with `readJsonBody(c)`.

A route opts into a form body per route, with bounded parsing after guards:
`@Post({ body: { multipart: limits } })` or `body: { form: limits }` (a
`defineRoute` contract takes `multipart:` or `form:`). Such a route accepts only
that media type. Limits are `maxBytes`, `maxFields`, `maxFieldBytes` and, for
multipart, `maxFiles` and `maxFileBytes`. URL-encoded defaults are 1 MiB
encoded bytes, 100 text entries and 64 KiB per text entry (including its UTF-8
name); multipart defaults to one file of 1 MiB, the same text limits, and a
body of `maxFiles × maxFileBytes` plus 1 MiB. Repeated entries count
individually. The route's `maxBytes` replaces the application's body limit for
that route (a `streamingOverrides` entry still takes precedence), so the
framework boundary and the route agree. The body is read counting the bytes
received and cancelled at the limit; every part is measured before schema
validation. Size/count violations return 413; unknown fields, duplicate scalar
fields, and wrong text/file kinds return 400; a wrong media type returns 415.
`body: { json: { maxBytes } }` bounds a JSON route the same way. See
[form bodies](client/HTTP.md#form-bodies-and-uploads).

## Request execution order and parameters

HTTP requests run in this order:

1. framework body/query limits and route middleware;
2. global guards by phase, then controller and method guards;
3. parameter extraction and pipes;
4. interceptors;
5. the controller handler.

Global guards run in fixed phases whatever order modules register them in:
`authenticate` → `tenant` → `authorize` → `feature`. A guard declares its phase
with `static readonly phase`; a guard without one runs in `feature`, and guards
keep registration order within a phase. Better Auth and Cloudflare Access
authenticate, `TenantModule` admits the tenant, `AuthzModule` and `CedarModule`
authorize, and throttling and feature flags run last. Each module installs its
guard globally by default and accepts `guard: 'none'` to leave it to
`@UseGuards`. Keep one pipeline's phases either all global or all route-level:
global guards run before route guards, so a global authorization guard would
otherwise run before a route-level authentication guard.

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
when routes are built. A controller target runs the middleware exactly when Hono
dispatches the request to one of the controller's own handlers, with that
handler's method, under any global prefix, URI version or parent app that mounts
the Vela app. It is the most precise target, so bind authentication to the
controller when you can. Path targets resolve under the global prefix and also
cover nested paths. `exclude()` patterns match exactly. A path target that
already starts with the global prefix fails the build, because it would never
match. A request matches a method-scoped target only for that method, or HEAD
for a GET target, as Hono routes it; the method token `ALL` is not a wildcard.

Path targets use a small grammar that Vela matches itself, segment by segment,
in time linear in the length of the request path. Targets add no routes to the
Hono app, so they never change which of Hono's routers the app uses. Even within
the grammar, Hono's routers do not all read a pattern the same way:

- The RegExpRouter's trailing `*` stops at a line terminator Hono decodes into
  the path (`%0A`, `%0D`, `%E2%80%A8`, `%E2%80%A9`); its other routers match it.
- The LinearRouter, which `hono/quick` uses, serves `:name` on an empty
  segment: a parent on it serves `/app//settings` with the route
  `/app/:org/settings`. Its other routers need a non-empty segment.
- The PatternRouter reads `:name.pdf` as the parameter `:name` followed by the
  text `.pdf`; its other routers read the whole segment as the parameter.

Vela reads each form so that no router serves a route without the middleware
its targets name. `forRoutes()` targets take the broader reading and fail
closed: `:name` also matches an empty segment. `exclude()` targets take the
strict one: `:name` matches one non-empty segment, so an empty segment never
skips the middleware. In both, a trailing wildcard covers every path beneath its
parent, decoded line terminators included, since the routes beneath it serve
those paths on every router. A `:name` whose name is not an identifier fails the
build. The grammar:

- A literal segment matches the same text in the decoded path, case-sensitively.
  `v1.0` and `a+b` are text, not regular expressions.
- `:name`, where `name` is an identifier, matches one segment, including the
  line terminators Hono decodes into the path. It matches an empty segment only
  in `forRoutes()`.
- The last segment may be `*` or Nest's `{*name}`, which match the parent path
  and every path beneath it: `cats/*` matches `/cats`, `/cats/` and
  `/cats/1/toys`. It may also be Nest's `*name`, which matches one or more
  characters beneath the parent but not the parent itself:
  `exclude('users/*id')` still runs the middleware on `/users`.
- A trailing `(.*)` reads as `{*name}` in `forRoutes()`, as Nest 11 rewrites
  it, so `forRoutes('cats/(.*)')` also covers `/cats` and a lone
  `forRoutes('(.*)')` matches every request. In `exclude()` it reads as
  `*name`, so `exclude('cats/(.*)')` still runs the middleware on `/cats`.
- A trailing `/` is a segment of its own, so `exclude('cats/')` skips `/cats/`
  but not `/cats`. `forRoutes('cats/')` covers the same paths as
  `forRoutes('cats')`.
- `'*'`, `'/*'` and `'{*splat}'` match every request and never get the prefix,
  as does a lone `'(.*)'` in `forRoutes()`.

Any other syntax fails the build with its cause, instead of matching whatever
one of Hono's routers makes of it:

- `{regex}` constraints, such as `:id{[0-9]+}` or `:action{login|register}`.
  Hono's TrieRouter anchors only the first and last alternative of a top-level
  `|`, so `exclude('auth/:action{login|register}')` would also have skipped
  `/auth/login-as/42`, and constraints that span segments backtrack.
- An optional `?`, such as `:id?`. List each path instead.
- A wildcard before the last segment, such as `files/*/raw`, `*/*`,
  `files/*path/download` or `cats/{*splat}/toys`.
- `*` or `:` inside a segment, such as `us*`, `ab*cd` or `abc:name`. Hono's
  routers disagree on whether `abc:name` is text or a parameter.
- A parameter name that is not an identifier, such as `:name.pdf`, `:from-to`
  or `:x@1`. Use a whole `:name` segment, list the paths, or target the
  controller.
- Parentheses or braces other than a trailing `(.*)` or `{*name}`, such as
  `:id(\d+)`, `(a|b)` or `users{/:id}`.
- An empty segment, such as `a//b`.

When constraint-level precision matters, target the controller, or list each
literal path.

When a parent app mounts the Vela app with `parent.route(base, app)`, path
targets match the request path beneath that base. Vela reads the base pattern
of the route Hono matched for the running middleware, fills in its `:param`
values as Hono matched them, and checks that the result spells the start of the
request path, segment by segment. A base with a trailing slash, such as `/m/`
or `/:tenant/`, puts the app's root at the base itself, as Hono joins routes
under it. If the base does not spell the start of the path, because Hono decoded
a percent-encoded parameter value (`/a%3Ab`) or the request stops at `/m`
under a `/m/` base, the request fails closed: the middleware runs, and its
`exclude()` path targets are ignored for that request.

A base parameter whose `{regex}` constraint can match a `/`, such as
`/:org{.+}`, `/:org{.+?}` or `/:org{(?:[a-z]+/)?[a-z]+}`, also fails closed on
every request. Hono can give the running middleware and the route it runs for
different values for it: under `/:org{.+}` the middleware reads `acme/admin`
for `/acme/admin` while the route reads `acme`. Vela probes the constraint with
strings such as `/`, `a/a` and `0/0`, and also fails closed when a filled-in
value does not spell one path segment. Hono's TrieRouter goes further for a
base whose parameter must span a `/`, such as `/:org{[a-z]+/[a-z]+}`: it serves
the Vela app's routes without running any of its `'*'` middleware, so body
limits, global and consumer middleware would all be skipped. A controller
route served that way answers 500 with the error
`Vela middleware chain did not run — unsupported mount`, reported like any
other server error. Mount the Vela app under bases whose parameters match one
path segment.

Some routes are served outside the global prefix: controller routes that
`globalPrefixOptions.exclude` leaves unprefixed, the `OpenApiModule` document
(`path`, `/openapi.json` by default), `mountOpenApi()` documents
(`/openapi.json`, `/scalar`, `/docs`, `/redoc`), the `RpcModule` endpoint
(`/rpc`), Cloudflare WebSocket gateway upgrade paths, Studio mounted with
`absolute: true`, and routes added to the Hono app directly. Target them with
`absolute: true`, which matches the path as written:

```ts
consumer
  .apply(AuditMiddleware)
  .forRoutes({ path: '/rpc', method: HttpMethod.POST, absolute: true });
```

Once every controller and route contributor has registered its routes, each
relative path target is checked against them: a target reaches a route through a
concrete path, shaped like either of them, that the target and the route both
match. A `{regex}`-constrained route parameter counts as one segment there,
whatever its constraint, so `forRoutes('users/:id')` reaches
`users/:id{[0-9a-f-]{36}}` and `forRoutes('images/:file')` reaches
`images/:file{.+\.png}`. These sample paths only drive startup checks, never a
request's decision.
A target that reaches no route under the global prefix but matches a route
served outside it, such as `forRoutes('rpc')` for the `RpcModule` endpoint,
fails the build and names the `{ path, absolute: true }` form to use. So does a
`forRoutes()` target that reaches prefixed routes while its written path also
matches a route served outside the prefix, such as `forRoutes('admin/*')` with
`admin/report` excluded from the prefix, unless the same middleware covers that
route with an absolute target or its controller, or leaves it out with an
absolute `exclude()`.
A `forRoutes()` target that reaches no registered route at all is reported
through the container's diagnostics policy (`'log'` warns, `'throw'` fails
bootstrap), since the route may still be added to the Hono app later; target
such a route with `absolute: true` and the path it is served on. The report
suggests the resolved path, global prefix included, such as
`{ path: '/api/users/:id', absolute: true }`, so following it never moves the
middleware off the path the target named.

## Error responses

Every HTTP failure renders through one function, `renderHttpError`, after
exception filters and the application's `ExceptionHandler.render` hook:
controller handlers, Vela middleware, the last-resort Hono `onError`, unmatched
routes (a JSON 404), request limits (413 and 400), RPC and GraphQL. Errors are
reported before they are rendered, and redaction holds on every edge:

- A string `HttpException` renders `{ error: { code, message, details? } }`.
  Only a 4xx echoes its message and `details`; a 5xx sends only the status title.
- An exception may own its response through `toResponse()`. `HttpException`
  built with an object returns it verbatim (a health check's deliberate 503),
  and `@velajs/crud` returns its envelope. Errors thrown by raw Hono middleware
  reach only `onError`, which redacts a 5xx owned body to its status title; RPC
  frames do the same.
- Branded `VelaError`s render their code, message and data unless the code is
  internal; any other error is a redacted 500.
- A Hono `HTTPException` below 500 renders its message in that body; one built
  with its own `res`, such as an auth challenge, keeps that response and its
  headers. From 500 it is redacted like any server fault.
- Framework rejections (unmatched routes, oversized bodies, query limits) are
  not reported. As in Nest, global exception filters receive them
  (`NotFoundException`, `PayloadTooLargeException`, `BadRequestException`), and
  a filter's plain result keeps their status.

An exception filter's plain result takes the exception's status rather than
200, and a filter that returns `undefined` leaves the error to the renderer.

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

Generic `signUrl` calls (from `@velajs/vela/security`) require
`{ expiresIn, method, purpose }`, and `verifySignedUrl` requires
`{ method, purpose }`. Missing expiry is invalid.
The signature payload is method- and purpose-separated. Named HTTP routes and
Cloudflare storage provide fixed
purposes automatically.

## Client identity and authorization scope

Core does not trust `X-Forwarded-For` or `X-Real-IP`. `@Ip()` returns `null`
unless `VelaFactory.create({ getClientIp })` or one runtime adapter supplies a
trusted resolver. Authentication guards can publish a canonical principal and
verified tenant with `setTrustedRequestIdentity(request, identity)`. Global
authentication runs in the `authenticate` phase, before the `feature`-phase
`ThrottlerGuard`, so default throttling partitions by both values before
considering any fallback, whatever the import order. Better Auth publishes this
state automatically and uses its verified `activeOrganizationId` when present.
Services read it through `REQUEST_CONTEXT` with the `TRUSTED_REQUEST_IDENTITY`
key, a read-only view: writing it throws, so `setTrustedRequestIdentity` stays the
only way to publish identity. The throttling decision is available under
`RATE_LIMIT`.

Without trusted identity, throttling uses `getTracker(request, context)` and then
the runtime-attested client address; unknown callers share one fail-closed
`anonymous` bucket. Cloudflare uses only its platform connection signal. Custom
tracker callbacks remain security-sensitive and must never read forwarding
headers. A custom global authentication guard declares
`static readonly phase = 'authenticate'` so it establishes identity first.

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

Global guards authenticate before `TenantGuard` runs in the `tenant` phase, then authorize
and throttle. The guards `TenantModule` and `CedarModule` install cover every application
route: a route in a module that does not import them is admitted or authorized through the
installing module, and `isGlobal` changes nothing. A route without `@RequireResource()` or
`@CedarPublic()` is denied unless `undeclared: 'allow'` is set. A route-level `TenantGuard`
or `CedarGuard` in a module that cannot see its module denies. Opt a route out of one phase
with its marker: `@Public(true)`, `@TenantIgnored()` or `@CedarPublic()`.

An integration package's own controller, which applications cannot annotate, declares the
phases it enforces itself with `SkipGuardPhases([...])` from `@velajs/vela/module-kit`:
the global guards integrations install in those phases (`tenant`, `authorize`) do not run
for its routes. Only a guard that declares `static readonly skippable = true` is skipped,
as `TenantGuard`, `PermissionGuard`, `RolesGuard` and `CedarGuard` do; other global guards
run in every phase on these routes, as do authentication, feature and route guards.
`skippable` belongs to the guard class, whoever registers it: an integration guard the
application registers itself is skipped, and so is an application guard that extends one,
unless the subclass declares `static override readonly skippable = false`.

The Better Auth handler and the storage controllers skip both phases; the GraphQL endpoint
skips `authorize`, because resolvers authorize each field. Generated CRUD controllers are
application routes: declare their Cedar policy with the resource's `decorators` and
`endpointDecorators`. The RPC `authorize` policy runs in the `authorize` phase, after
global authentication and tenant admission. A custom global guard provided by a factory
runs in the phase its built instance declares. Tenant admission preserves `CurrentUser`,
`CurrentSession`, and `CurrentAccessIdentity` payloads. The core identity remains an
immutable snapshot; use it (or `CurrentTenant`) for the admitted tenant rather than
assuming an identity-provider payload contains the selected tenant.

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
