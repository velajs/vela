# Upgrading framework integrations

This guide covers the DI, execution, schema, transport and database APIs that
require core 1.25.0. RPC and GraphQL 1.1.0 require this core version, and named
databases require CRUD 1.25.0 with compatible adapters. Update the core and affected
integrations together using their published dependency ranges; consult each
package's changelog for its version. A prepared version in this repository becomes
installable only after publication to npm.

## Import paths

`@velajs/vela` exports each name from exactly one entry point. The root is the
application kit: the factory, modules and dependency injection, controllers and
their decorators, the request pipeline, HTTP exceptions, `ConfigModule` and
`Logger`. Integrations and runtime adapters import `Container`,
`MetadataRegistry`, discovery, entrypoint kinds, execution scopes,
`PipelineRunner`, route contributors and `invokeScheduledJob` from
`@velajs/vela/module-kit`. Optional features have their own subpaths: `/cache`,
`/throttler`, `/schedule`, `/events`, `/health`, `/logging`, `/http-client`,
`/openapi`, `/security`, `/dispatch`, `/validation` and `/websocket`.
`@velajs/vela/internal` keeps only bootstrap plumbing. `@velajs/cloudflare` no
longer re-exports the WebSocket gateway API; import it from
`@velajs/vela/websocket`. The `@velajs/vela` changelog lists every moved name
with its new import path.

## Dependency injection and module ownership

A provider token registered in two modules now has a separate cached instance for
each registration. An exported alias resolves its target from its declaring module,
and aliases preserve the target's lifetime. If an application previously depended
on unrelated modules sharing a same-token instance, export one intentional shared
registration and import it where needed.

Custom discovery and transport integrations should preserve each entrypoint's
`moduleId` and use `resolveEntrypoint` or owner-aware asynchronous resolution.
Ownerless entries remain supported only when their registration is unambiguous.
Mounting the same controller class through ambiguous module instances now fails
explicitly instead of choosing the first owner. Container internals use `#private`
fields; use public provider snapshots for diagnostics.

See [DI ownership](dependency-injection.md) and [module authoring](modules.md).

## Invocation and cleanup

Await application and fixture disposal. Constructed singleton dependencies belong
to the application, while request dependencies belong to their invocation.
Explicit `useValue` objects and request seeds remain caller-owned. The container
waits for pending constructions and performs cleanup in reverse creation order.

Custom adapters should use `runInEntrypointScope` or explicitly finish their
managed scope on success and failure. Register work that needs scoped providers
through `ExecutionLifetime.waitUntil` or `defer`; arbitrary detached promises are
not tracked. Streaming adapters must retain the scope until the stream settles.
Do not reuse a closed invocation even though a bare Container remains reusable
after awaited disposal for 1.x compatibility.

HTTP middleware, guards and handlers share the normalized request identity. Use
framework request-context accessors instead of caching an earlier raw request for
authentication or tenant lookup. Non-HTTP work must establish its own trusted
identity; validated job or event data is not an authentication credential.

See [execution scopes](execution-scopes.md), [security](security.md) and
[testing](../packages/testing/README.md).

## Validation and serialization

Async schema refinements and transformations are awaited at supported dispatch
boundaries. Handlers receive the input schema's parsed output and return the
output schema's input; final output transformation produces the wire result.
Keep these types distinct when a schema transforms values. Use `parseSchemaAsync`
or a DTO's `parseAsync` for asynchronous validation outside dispatch.

Generated CRUD endpoints validate request bodies in the engine. Independent
headless engine calls still require raw input: do not parse a transforming schema
first and submit its transformed result for another parse. There is no global
validation receipt: `ValidationPipe.consumeValidated` has been removed.

See [schema contracts](types.md), [serialization](serialization.md) and
[typed CRUD services](crud/services.md).

## Schema-first routes

Routes declare their contract on the method decorator. `@Endpoint`,
`defineEndpoint`, `@Serialize`, `SerializerInterceptor` and `SERIALIZE_METADATA`
are removed:

- Replace `@Endpoint(defineEndpoint({ input, output, status }))` with route
  options and schema arguments: `@Post({ response: Output, status })` and
  `@Body(Json)`, `@Query(Query)`, `@Param('id', schema)`, `@Headers('x', schema)`
  instead of one `input` object with `json`, `query`, `param` and `header`
  groups. The handler takes ordinary parameters. To share the contract with a
  browser client, declare it with `defineRoute({ method, path, params, query,
  body, response, status })` from `@velajs/vela/contract` and serve it with
  `@Post(contract)` or `@Get('/:id', contract)`.
- Replace `body: { contentType: 'multipart/form-data', ...limits }` with
  `body: { multipart: limits }`, `application/x-www-form-urlencoded` with
  `body: { form: limits }` and `application/json` with `body: { json: { maxBytes } }`.
  Multipart now defaults to one file and a body of `maxFiles × maxFileBytes` plus
  1 MiB, and a route's own `maxBytes` replaces the application body limit for
  that route, so upload routes no longer need a `streamingOverrides` entry;
  remove such entries, which still take precedence. A default `maxBytes` never
  exceeds a `security.body.maxBytes` (or `bodyLimit`) the application sets:
  declare `maxBytes` on an upload route that must accept more. A route that
  declares a body reads it after guards and before the handler, even when no
  parameter reads it, so a `body: { json }` route answers 415 for other media
  types and 400 for malformed JSON also when only `@RawBody()` reads it.
- Replace `format: 'binary' | 'stream' | 'response'` endpoint definitions with
  the same `format` and `contentType` route options.
- Replace `@Serialize(dto)` and `SerializerInterceptor` with
  `@Get({ response: dto })`. The response is parsed as a whole, after
  interceptors: use `z.array(item)` where `@Serialize` parsed each array element.
  A `defineSerializer` result is a Standard Schema and serves as `response`
  directly; it no longer has a `.schema` property.
- `@ApiResponse(status, options)` becomes Nest's `@ApiResponse({ status,
  description, schema })`, and `schema` is a Standard Schema or `defineDto`
  descriptor; raw JSON Schema is rejected. Declare the success body with the
  route's `response` option instead.

Statuses follow Nest: POST answers 201, `response: null` or `@HttpCode(204)`
answers 204, and every other method answers 200 — whatever the handler returns.
A handler returning `null` or `undefined` no longer answers 204; it answers the
route's status with an empty body. Declare `response: null` (or `@HttpCode(204)`)
where clients expect 204, and `@HttpCode(200)` on POST routes that must keep 200.

Without `response` or `format`, a route still sends strings as text and other
values as JSON. The route parses its result through `response` after
interceptors. `@CacheResponse` stores the response the route sent — its status,
media type and body, after every interceptor and the schema — so a cache store
never holds fields the schema strips, and a hit replays that response without
running the handler or parsing again. Interceptors outside `CacheInterceptor`
receive the replayed `Response` on a hit, and a value they return instead is
ignored. Route entries carry a new address and format version, so entries an
earlier release stored with the handler's raw result miss once after the
upgrade, also while older isolates still write them. When you tighten a
`response` schema, change the cache `namespace` (or invalidate the affected
scopes) for it to apply to entries stored before their TTL expires.

`@Query()` without a schema returns repeated keys (`?tag=a&tag=b`) as arrays
instead of the first value, and keys a query schema declares as arrays arrive as
arrays even when sent once; a repeated scalar fails its schema. A named
parameter without a schema follows its declared type: `string`, `number` and
`boolean` parameters still receive the first value, an array parameter without
a pipe always receives an array, and an `unknown` or union parameter, or an
array a pipe such as `ParseArrayPipe` splits, receives an array for a repeated
key. `string | undefined` and `string | null` are unions: declare such a
parameter optional (`role?: string`) to keep the first value. OpenAPI documents
the parameters that receive one value or repeated keys as such, and
`vela client generate` types them `string | Array<string>`. Declare a schema,
or `ParseArrayPipe`, for values that may be one or many.

`@Body()` with no schema validates a parameter class carrying a static Standard
Schema even without a global pipe, so bodies such a class rejects now answer
400; a named `@Body('item') item: Item` validates the `item` member. It
validates as the body is read, before any pipe, unless a `ValidationPipe` (or a
subclass) applies to the parameter; then that pipe validates it in pipe order,
as in Nest, and every `ValidationPipe` that applies validates. A validation
pipe of your own that is not a `ValidationPipe`, such as one parsing
`metatype.schema`, now runs on the value the class already validated, which
fails for schemas whose transforms do not accept their own output: make it
extend `ValidationPipe`, or remove it. A global `ValidationPipe` still validates
body parameters registered without a route reader.

A route validates every request group its `defineRoute` contract declares —
`params`, `query` and `body`, with the body's encoding and limits — after guards
and before the handler, whether or not a parameter reads it, as `@Endpoint` did.
`@Body()`, `@Query()` and `@Param()` read the validated values, and a
`ValidationPipe` does not validate them again. The application fails to start
when a `params` schema leaves out a path parameter the route serves, when a
named parameter reads a key its group's schema does not declare, and when a
parameter declares its own schema for a declared group.

Method decorators with `response` or `format` are `RouteMethodDecorator<Result>`
values that check the handler's result; they are no longer assignable to
`MethodDecorator`. Annotate wrapper helpers with `RouteMethodDecorator<T>` or
let TypeScript infer them. Decorators without those options remain
`MethodDecorator`s. A route serving a `defineRoute` contract rejects `@HttpCode`
at startup; declare `status` in the contract, which types its clients.

An `@Override`'d CRUD verb answers the verb's status (200 for restore, upsert,
import, batch restore and upsert, version rollback) unless it declares its own
`@HttpCode`, and OpenAPI documents that status.

## HTTP errors, request parameters and guards

Every HTTP failure renders through `renderHttpError`. Clients see these changes:

- Validation failures from `ValidationPipe`, `@Body(schema)` and route contracts
  answer
  `{ error: { code: 'bad_request', message: 'Validation failed', details: { issues } } }`
  instead of `{ statusCode, message, errors }`.
- Unmatched routes answer a JSON 404, `{ error: { code: 'not_found', message: 'Not Found' } }`,
  and oversized bodies a JSON 413 (`payload_too_large`), instead of Hono's plain text.
  Global exception filters receive these rejections, as in Nest, so a catch-all filter that
  wraps every error also shapes the 404; they are still not reported.
- A Hono `HTTPException` below 500 answers `{ error: { code, message } }` instead of its
  plain-text response, unless it was built with its own `res`.
- An exception filter's plain result is sent with the exception's status
  (`getErrorStatus`: `HttpException.getStatus()`, `VelaError.status`, else 500)
  instead of 200. Return `{ status, body }` to choose the status. A filter that
  returns `undefined` leaves the error to the default renderer instead of sending 204.

`HttpException.getRawResponse()` is removed. Exceptions own their wire shape
through `toResponse()`: an object response still renders verbatim, and a custom
exception extends `HttpException` and overrides `toResponse()` to return
`{ status, body }`. Only exceptions the `HttpException` constructor built own a
response; another thrown object with a `toResponse()` renders as an unknown
error (a reported, redacted 500). Error edges answer only 400–599: an
`HttpException` constructed with another status, such as 302, is reported and
renders as a redacted 500. Pass structured client data on a 4xx with
`new BadRequestException(message, { details })`.
Integrations that map errors to another transport call `renderHttpError(error)`.

`@Req()` injects the platform `Request`; inject the Hono context with the new
`@Ctx()` (or `@Res()`). Replace `@Req() c: Context` with `@Ctx() c: Context`, or
with `@Req() request: Request` when the handler only read `c.req.raw`.

`ExecutionContext.getHandler()` returns the handler method, as in Nest, and the
new `getHandlerName()` returns its name. Custom execution contexts implement both
and record the handler with `MetadataRegistry.addHandlerMethod(handler, type, name)`.
Pass `context.getHandler()` and `context.getClass()` to the `Reflector`, or keep
passing the context. `[context.getHandler(), context.getClass()]` reads the
method that class routes, so one controller's metadata on an inherited method
never applies to a sibling controller. Alone, `context.getHandler()` throws when
several controllers route the function with different metadata for the key; list
the class with it or pass the context there. When one wrapper function replaces
several methods of a controller with different metadata, the list form throws
too, so pass the context. Code that used the handler name, such as a throttling
key, calls `getHandlerName()`.

Declarations on an ancestor class apply to the controllers that extend it, as in
Nest. Class metadata reads the controller's own, else the nearest ancestor's, in
every `Reflector` form, so `@Roles(['admin'])` on an abstract base controller
guards each controller that extends it. Class-level `@UseGuards`,
`@UseInterceptors`, `@UsePipes`, `@UseFilters` and `@UseMiddleware` on an
ancestor run for the subclass, ancestors first. On a method the controller
inherits unchanged, the ancestors' method metadata, method-level enhancers and
`SkipGuardPhases` apply, and a route that declares no options of its own takes
those of the nearest ancestor's route for the same verb and method (its
`response`, `status` or `defineRoute` contract); an override reads only its own. Opening
markers are inherited too: `@Public()`, `@TenantIgnored()`, `@CedarPublic()` or
`@SkipThrottle()` on a base controller now opens its subclasses' routes. Remove a
declaration from the base class, or override the method, where a subclass must
not inherit it.

Global guards run in phases: `authenticate`, `tenant`, `authorize`, `feature`.
Better Auth, Cloudflare Access, `TenantModule`, `AuthzModule`, `CedarModule` and
`FeatureFlagsModule` install their guard globally by default; `guard: 'none'`
opts out. Replace
Better Auth's `isGlobal` with `guard` and Cedar's `globalGuard: false` with
`guard: 'none'`. Remove `@UseGuards` for guards the modules now install, or pass
`guard: 'none'` and keep a fully route-level pipeline. The installed guards
cover every application route, including modules that do not import
`TenantModule` or `CedarModule`. Cedar denies routes without
`@RequireResource()` or `@CedarPublic()`; set `undeclared: 'allow'` to keep
the previous behavior. Declare the policy of generated CRUD controllers with the
resource's `decorators` and `endpointDecorators`. Integration packages mark their own
controllers with `SkipGuardPhases` from `@velajs/vela/module-kit`, which skips only the
guards integrations install (`static readonly skippable = true`); other global guards
still run there. An application guard that extends an integration guard inherits
`skippable`; declare `static override readonly skippable = false` on it to keep it
running there. Import order no longer decides whether authentication runs before
throttling. The RPC `authorize` policy runs after global authentication and tenant
guards, so it can read the trusted identity.

`ThrottlerGuard` publishes its decisions under the `RATE_LIMIT` request-context
key instead of the `rateLimit` Hono variable, one per throttler name: read
`requestContext.get(RATE_LIMIT)?.default` where you read `c.get('rateLimit')`.

## Queues, events, schedules and storage

Configure the queue driver once with `QueueModule.forRoot({ driver })` and register
each queue with `QueueModule.registerQueue({ name, binding? })` in the module that
uses it; inject clients with `@InjectQueue(name)`. On Workers use
`cloudflareQueues()` from `@velajs/cloudflare/queues`. Use a queue driver factory
when module declarations are reused across applications: `driver: () => inline()`.
A bound driver instance cannot be rebound to another application. Typed queue jobs carry original schema input and validate at producer
and consumer boundaries; keep transforms deterministic. Delivery handlers must
still tolerate redelivery.

Once event listeners are consumed before invocation, including recursive dispatch.
Node schedules validate their syntax before timers start. Specify the cron dialect
and timezone when sharing schedules across runtimes. Scheduled shutdown waits for
owned work; handlers must finish or cooperate with cancellation. A custom runtime
that fires scheduled jobs should call `invokeScheduledJob(container, entry,
invocation)`, so its jobs get the same scope, single `ScheduleInvocation`
argument, signed dispatch and error reporting as Node and Workers. A caller that
fires jobs on demand passes the runtime's `SCHEDULE_INVOCATION_SEED`, when one is
registered, as `invokeScheduledJob`'s `seed`. `@Cron` and `@Interval` are typed
method decorators: annotate a handler's parameter as `CronInvocation` or
`IntervalInvocation`; a handler that still declares the native
`(controller, env, ctx)` arguments no longer compiles.

`dispatchQueueJob` delivers through `QueueModule`'s dispatch policy when the
application imports `QueueModule.forRoot()`: the job's queue must be registered
and signed dispatch re-enters the signed route. It rejects a job no processor
handles; pass `{ unhandled: 'ignore' }` to resolve with `handled: 0` instead.
`addBulk` entries are typed one by one and keep the `{ job, data, options }`
shape of `add()`.

Storage aborts and deadlines stop follow-up work without retrying abandoned writes.
An already-issued native write can still commit. Reconcile uncertain results at
the application boundary instead of assuming timeout means rollback. R2 range
responses report the returned range length.

See [queues](queues.md), [events](event-sourcing.md), [scheduling](scheduling.md)
and [storage](../packages/storage/README.md).

## Feature surfaces

Each feature has one module, configured with names instead of live bindings:

- **Bindings:** module options name a binding, `{ binding: 'CACHE' }`, which is
  read from each application's `ENV` when first used. The Workers factories
  `kv`, `r2`, `d1`, `queue`, `durableObject` and `rateLimit` come from
  `@velajs/cloudflare`; a missing binding fails naming its Wrangler key.
- **Storage:** the Cloudflare `StorageModule` and `@velajs/vela/storage` are
  removed. Register `StorageModule.forRoot({ name, driver: r2Storage({ binding }) })`
  from `@velajs/storage`, with `r2Storage` from `@velajs/cloudflare/storage`, per
  former disk. The presign-proxy route `GET /storage/:disk` is gone.
- **Cache:** the synchronous cache is removed and the response cache takes its
  names: `ResponseCacheModule` is `CacheModule`, `ResponseCacheService` is
  `CacheService`. Replace `@Cacheable()` with `@CacheResponse({ key, ttl })`, and
  a Workers KV store with `store: kvCache({ binding })`.
- **CORS:** `CorsModule` is removed. Call `app.enableCors(options)` or pass the
  `cors` create option (`createCloudflareWorker(AppModule, { cors })` on Workers).
- **Throttling:** `ThrottlerModule.forRoot({ limit, ttl })` becomes
  `forRoot({ throttlers: [{ limit, ttl }] })`, and `@Throttle({ limit })` becomes
  `@Throttle({ default: { limit } })`. `cloudflareRateLimitStore(binding, …)` becomes
  `storage: rateLimitStore({ binding: 'API_LIMITER' })`.
- **Studio:** the per-feature modules (`StudioCrudModule`, `StudioLiveModule`,
  `StudioQueueModule` and the others) become panels in
  `StudioModule.forRoot({ plugins: [crudPanel(), livePanel({ rooms }), …] })`.
  `managedModels` and `runAsIdentity` move to `crudPanel()`, and
  `StudioCloudflareTimeTravelModule.forRoot({ namespace })` becomes
  `cloudflareTimeTravelPanel({ binding })`.

See [caching](caching.md), [security](security.md) for CORS and throttling,
[storage](../packages/storage/README.md) and [Studio](../packages/studio/README.md).

## Optional transports and multiple databases

RPC and GraphQL remain separate, opt-in packages. RPC supplies typed HTTP/Fetcher
procedures. GraphQL supplies executable schemas and single JSON POST queries and
mutations. Socket RPC, GraphQL subscriptions, batching, uploads and incremental
responses are outside these adapters' current contracts. Configure explicit
authentication, authorization and domain limits when mounting either transport.

Existing single-database CRUD configuration keeps its meaning. Named databases
add explicit registration and resource routing, database-qualified resource tokens,
and separate migration histories. Keep transaction operations sequential and within
one database/application owner and tenant. Foreign, expired or fabricated scopes
are rejected. Cross-database atomicity and D1 callback transactions are unsupported;
versioned resources reject explicit transaction composition until their stores can
participate in the same scope. Post-commit audit/event delivery remains best effort.

Studio snapshots support named resources. Named-database change replay rejects an
unqualified change source before writing. Do not treat a legacy change log as
database-qualified history.

See [RPC](../packages/rpc/README.md), [GraphQL](../packages/graphql/README.md) and
[multiple databases](multi-database.md), including its runnable two-D1 example.
