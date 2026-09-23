# Upgrading framework integrations

This guide covers the DI, execution, schema, transport and database APIs that
require core 1.25.0. RPC and GraphQL 1.1.0 require this core version, and named
databases require CRUD 1.25.0 with compatible adapters. Update the core and affected
integrations together using their published dependency ranges; consult each
package's changelog for its version. A prepared version in this repository becomes
installable only after publication to npm.

## HTTP error bodies

The first core release after 1.28.0 renders every HTTP failure that the framework
produces as `{ error: { code, message, details? } }`, through one path that the
application's `ExceptionHandler.render` hook can customize. See
[HTTP errors](errors.md). The wire format changes for clients:

| Failure | Before | Now |
| --- | --- | --- |
| Endpoint input, `ValidationPipe` validation (400) | `{ statusCode, message, errors }` | `{ error: { code: 'bad_request', message: 'Validation failed', details } }` |
| `ZodValidationPipe` invalid input | 500 | 400 with the same body as other validation failures |
| `HttpException` thrown in middleware | `{ statusCode, message }` | `{ error: { code, message } }` |
| Body over `security.body.maxBytes` (413) | Plain text `Payload Too Large` | `{ error: { code: 'payload_too_large', message: 'Request body exceeds the configured limit' } }` |
| No route matched (404) | Plain text `404 Not Found` | `{ error: { code: 'not_found', message: 'Route not found' } }` |

Query-limit failures keep their 400 body, and an `HttpException` constructed with
an object is still sent verbatim. Request-limit failures and unmatched routes now
reach the render hook; as before, they are not reported and skip exception
filters. Middleware exceptions still go through global filters and the render
hook; only their default body changed. A vela `HttpException` that escapes to the
last-resort handler keeps its status instead of becoming a redacted 500, and a
Hono `HTTPException` below 500 thrown by a controller keeps its own response, as
it already did in middleware. The default body no longer calls `getResponse()`,
so an exception subclass that overrides it to reshape middleware errors should
use a render hook or an object response instead.

To migrate, read validation issues from `error.details` (each issue keeps
`message`, `path`, and `code`) instead of `errors`, and error text from
`error.message`. Filters that read the issue list from an exception use
`exception.getDetails()`; `getResponse()` now carries it as `details`. Tests that
asserted plain-text 404 or 413 bodies should parse JSON. Apps that translate or
reshape errors can do so for every failure in one `render` hook with
`toHttpErrorBody(error, { context })`.

## Endpoint context parameters

`@Endpoint` methods may declare context parameters after the validated input:
`createParamDecorator` and `createLazyParamDecorator` decorators such as
`@CurrentUser()`, plus `@Req()`, `@Res()`, `@Ip()`, and `@Cookie()`. Replace a
request-scoped controller that only existed to read identity through
`REQUEST_CONTEXT` with a context decorator. Decorators that read data owned by the
endpoint input (`@Param()`, `@Query()`, `@Headers()`, `@Body()`, `@RawBody()`)
still fail at startup. See [context parameters](client/HTTP.md#context-parameters).

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
first and submit its transformed result for another parse. The deprecated
`ValidationPipe.consumeValidated` method returns false and no longer supplies a
global validation receipt.

`@Serialize` still requires `SerializerInterceptor` and applies its schema to each
array element. Standard Schema output validation now runs instead of allowing
unfiltered values through; malformed metadata and output-contract failures raise
server errors. Use `defineSerializer` to project domain objects through public
methods, including objects with `#private` state. It does not hydrate classes or
read private fields. Review response schemas if clients depended on extra fields
that should have been filtered.

See [schema contracts](types.md), [serialization](serialization.md) and
[typed CRUD services](crud/services.md).

## Queues, events, schedules and storage

Use a queue driver factory when module declarations are reused across applications:
`driver: () => inline()`. A bound driver instance cannot be rebound to another
application. Typed queue jobs carry original schema input and validate at producer
and consumer boundaries; keep transforms deterministic. Delivery handlers must
still tolerate redelivery.

Once event listeners are consumed before invocation, including recursive dispatch.
Node schedules validate their syntax before timers start. Specify the cron dialect
and timezone when sharing schedules across runtimes. Scheduled shutdown waits for
owned work; handlers must finish or cooperate with cancellation.

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
