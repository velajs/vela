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

`@Serialize` still requires `SerializerInterceptor` and applies its schema to each
array element. Standard Schema output validation now runs instead of allowing
unfiltered values through; malformed metadata and output-contract failures raise
server errors. Use `defineSerializer` to project domain objects through public
methods, including objects with `#private` state. It does not hydrate classes or
read private fields. Review response schemas if clients depended on extra fields
that should have been filtered.

See [schema contracts](types.md), [serialization](serialization.md) and
[typed CRUD services](crud/services.md).

## HTTP errors, request parameters and guards

Every HTTP failure renders through `renderHttpError`. Clients see these changes:

- Validation failures from `ValidationPipe` and `@Body(schema)` answer
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
exception overrides `toResponse()` to return `{ status, body }`. Pass structured
client data on a 4xx with `new BadRequestException(message, { details })`.
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

Global guards run in phases: `authenticate`, `tenant`, `authorize`, `feature`.
Better Auth, Cloudflare Access, `TenantModule`, `AuthzModule` and `CedarModule`
install their guard globally by default; `guard: 'none'` opts out. Replace
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

`ThrottlerGuard` publishes its decision under the `RATE_LIMIT` request-context
key instead of the `rateLimit` Hono variable.

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
