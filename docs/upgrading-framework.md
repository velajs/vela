# Upgrading framework integrations

This guide collects the behavior changes and migration steps after the 1.24.0
baseline. The DI, execution, schema, transport and database sections cover the APIs
that require core 1.25.0: RPC and GraphQL 1.1.0 require this core version, and named
databases require CRUD 1.25.0 with compatible adapters. The module contract, HTTP
error and guard, Cloudflare adapter, realtime, feature surface, and CLI and testing
sections cover core 1.31.0 and the integrations released with it. The schema-first
routes section and the paragraphs marked *1.32.0* cover core 1.32.0 and the
integrations released with it (Cloudflare, CLI, CRUD, mail, storage, testing and
Studio). Update the core and affected integrations together; consult each package's
changelog for its version. Published dependency ranges alone do not keep them in
step: the 1.31.0 integrations declare `^1.31.0` peer ranges, which accept core 1.32.0
without a warning. Install core 1.32.0 with `@velajs/cli` 1.32.0, `@velajs/cloudflare`
1.32.0, `@velajs/crud` 1.32.0, `@velajs/mail` 1.32.0, `@velajs/storage` 1.31.1,
`@velajs/testing` 1.32.0 and `@velajs/studio` 1.32.0 (with `@velajs/studio-host`
1.24.0 and `@velajs/studio-ui` 1.25.0): `@velajs/crud` 1.31.0 calls the removed
`@ApiResponse(status, options)` form and fails at import, Studio and CLI 1.31.0 read
the removed `ModuleDescription.isGlobal`, and OpenAPI and `vela client generate`
document the POST routes of `@velajs/storage` 1.31.0 as 201 while they answer 200.
In the other direction, the integrations released with core 1.32.0, storage 1.31.1
included, declare `^1.32.0` core peer ranges, and `@velajs/testing` 1.32.0 would
silently not apply `overrideProvider()` or `useMocker` on core 1.31. Studio's
optional Cloudflare and CRUD peer ranges also become `^1.32.0`, and Cloudflare's
optional storage and testing peer ranges `^1.31.1` and `^1.32.0`. A prepared
version in this repository becomes installable only after publication to npm.

## Import paths

`@velajs/vela` exports each name from exactly one entry point. The root is the
application kit: the factory, modules and dependency injection, controllers and
their decorators, the request pipeline, HTTP exceptions, `ConfigModule` and
`Logger`. Integrations and runtime adapters import `Container`,
`MetadataRegistry`, discovery, entrypoint kinds, execution scopes,
`PipelineRunner`, route contributors and `invokeScheduledJob` from
`@velajs/vela/module-kit`. Optional features have their own subpaths: `/cache`,
`/dispatch`, `/events`, `/health`, `/http-client`, `/i18n`, `/live`, `/logging`,
`/observability`, `/openapi`, `/queue`, `/schedule`, `/schedule-node`, `/security`,
`/seeder`, `/streaming`, `/throttler`, `/validation`, `/websocket` and
`/websocket-node`. Core 1.31.0 removes `/storage`; file storage is `@velajs/storage`.
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

## Module contract

`defineModule` is the one module engine, and every first-party module follows the
same contract.

A module's instance key comes from its structural options only: the options that
shape its graph, such as a storage bucket's `name` or a GraphQL `path`. A module
without structural options has one instance per class. A second configuration under
the same key fails bootstrap under every diagnostics policy, instead of becoming
another instance or being dropped with a warning. Give each additional
configuration its own `key`:

```ts
// Before (1.30.0): two instances, keyed by their options.
@Module({ imports: [HttpModule.forRoot({ baseURL: 'https://billing.example.com' })] })
class BillingModule {}
@Module({ imports: [HttpModule.forRoot({ baseURL: 'https://catalog.example.com' })] })
class CatalogModule {}
```

```ts
// After: name each instance.
@Module({ imports: [HttpModule.forRoot({ key: 'billing', baseURL: 'https://billing.example.com' })] })
class BillingModule {}
@Module({ imports: [HttpModule.forRoot({ key: 'catalog', baseURL: 'https://catalog.example.com' })] })
class CatalogModule {}
```

The same applies to `ThrottlerModule`, `I18nModule`, `MailModule` (two mailers that
differ only in `from`, `transport` or `render`) and `CryptoModule`. `CacheModule`
allows one instance per application, whatever its `key`. `StorageModule`
keys by bucket `name`, `GraphqlModule` by `path` and `RpcClientModule` by `name`
and `binding`, so registering one of those again with other options fails too.
`AuthzModule`, `TenantModule`, `CloudflareAccessModule` and `FeatureFlagsModule`
key by `guard`, and `CedarModule` by `guard` and `undeclared`: a second
registration with the same `guard` and other options, such as a feature module's
own `AuthzModule` with other roles, fails bootstrap unless it has its own `key`.
For several `AuthzModule`, `TenantModule` or `CedarModule` registrations, keep
`guard: 'global'` on one and pass `guard: 'none'` on the others; the installed
guard resolves the registration the route's module sees.
`CrudModule.forFeature()` registrations that mount one path with different
definitions fail bootstrap; register one shared `defineCrudFeature(...)` value
wherever the path is mounted.

`forRootAsync` takes structural options next to its factory, which returns the
other options. A factory that returns a structural option no longer compiles and
fails bootstrap, and any other call-site option besides `key`, `lazy`, an extra
such as `isGlobal` and the factory wiring (`imports`, `inject`, `useFactory`,
`useClass`, `useExisting`) throws. In 1.30.0 such an option (for example `baseURL`
in `HttpModule.forRootAsync({ baseURL, useFactory })` or `roles` in
`AuthzModule.forRootAsync({ roles, useFactory })`) was merged under the factory's
result as a default; return it from the factory instead. Better
Auth's factory returns the module options instead of the auth instance, and
Storage's returns them instead of a bare driver or `{ driver, multipartGrantSecret }`;
Storage's `prefix`, `readonly` and `hooks` move into the factory result:

```ts
// Before (1.30.0)
BetterAuthModule.forRootAsync({
  inject: [ENV],
  useFactory: (env) => betterAuth({ secret: env.AUTH_SECRET, database }),
});
StorageModule.forRootAsync({
  name: 'files',
  prefix: 'uploads/',
  inject: [ENV],
  useFactory: (env) => ({ driver: r2Driver({ bucket: env.FILES }), multipartGrantSecret: env.SECRET }),
});
```

```ts
// After: `auth` and `driver` may be functions, built on first use.
BetterAuthModule.forRootAsync({
  inject: [ENV],
  useFactory: (env) => ({ auth: () => betterAuth({ secret: env.AUTH_SECRET, database }) }),
});
StorageModule.forRootAsync({
  name: 'files',
  inject: [ENV],
  useFactory: (env) => ({
    driver: () => r2Driver({ bucket: env.FILES }),
    prefix: 'uploads/',
    multipartGrantSecret: env.SECRET,
  }),
});
```

In the core modules, `forRootAsync` takes `ConfigModule`'s `load`, `ErrorsModule`'s
`catalogs` and `handler`, `LiveModule`'s `presence`, `ScheduleModule`'s `dispatch`,
`SeederModule`'s `seeders` and `WebSocketModule`'s `sync` next to its factory, and
`RpcClientModule.forRootAsync` takes `name` and `binding`.

A bare class import configures nothing. Importing a generated module class that
has no `@Module()` of its own, such as `imports: [CedarModule]`, fails bootstrap;
import `CedarModule.forRoot(...)`. `@Module` no longer accepts `isGlobal`: decorate
the class with `@Global()`, or pass the `isGlobal` extra to one `forRoot` call.
`ModuleMetadata.isGlobal` is renamed `global`. The `isGlobal` extra only makes an
instance's exports visible everywhere; options that install application-wide guards
are named `guard` (see [guards](#http-errors-request-parameters-and-guards)).

*1.32.0:* module descriptions use the same name. `ModuleDescription.isGlobal`
(`Container.getModuleDescriptions()` from `@velajs/vela/module-kit`) and the
internal `ModuleScope.isGlobal` are `global`, and `vela module graph --json` and the
`vela mcp serve` `module_graph` and `token_describe` results report `global`. The
Studio wire protocol moves to version 4, whose `app.modules` rows carry `global`:
upgrade `@velajs/studio`, `@velajs/studio-host` and `@velajs/studio-ui` together,
since a host or UI on protocol 3 refuses a protocol-4 application, and the reverse.

Renamed and removed APIs, with no aliases:

- `RpcClientModule.register`/`registerAsync` are `forRoot`/`forRootAsync`.
- `ConfigurableModuleBuilder` generates Nest's `register`/`registerAsync`; call
  `setClassMethodName('forRoot')` to keep `forRoot`.
- `defineConfigurableModule` (use `defineModule`), `defineDynamicModule` (return a
  `DynamicModule` literal), `moduleKey` (use `stableHash` or `referenceKey`),
  `moduleToken` (use `new InjectionToken`), `provideGlobal` (use the `global:` slot
  of `setup`, or `{ provide: APP_GUARD, useClass }`) and the plugin API
  (`definePlugin`, `composePlugins`, `PluginRegistry`; compose modules with
  `imports`).
- `mountOpenApi`'s `path` and `uiPath` (use `specPath`, and `swaggerPath`,
  `scalarPath` or `redocPath`), Storage's `http.defaultPolicy`, and the `userId`
  identity alias (`Identity.userId`, `ResolvedIdentity.userId`, and the field
  `identityFromUser` set): read `subject` with `issuer`.

Module authors declare structural options with a second type argument and a
`structural` list, `defineModule<Opts, 'name' | 'http'>({ structural: ['name', 'http'], defaults: { name: 'default' }, ... })`;
`setup` and `key` receive only those fields. See [module authoring](modules.md).

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
  Multipart now defaults to one file of 1 MiB and a body of
  `maxFiles × maxFileBytes` plus 1 MiB, where `@Endpoint` accepted 10 files within
  a 1 MiB body: a converted upload route that relied on the defaults answers 413
  for a second file, so declare `maxFiles` (and `maxBytes`) to keep the earlier
  limits. A route's own `maxBytes` replaces the application body limit for
  that route, so upload routes no longer need a `streamingOverrides` entry;
  remove such entries, which still take precedence. A default `maxBytes` never
  exceeds a `security.body.maxBytes` (or `bodyLimit`) the application sets:
  declare `maxBytes` on an upload route that must accept more. A route that
  declares a body reads it after guards and before the handler, even when no
  parameter reads it, so a `body: { json }` route answers 415 for other media
  types and 400 for malformed JSON also when only `@RawBody()` reads it. Read
  such a body again through `@RawBody()` or `c.req`: the route has consumed the
  stream of the platform `Request` that `@Req()` injects.
- Replace `format: 'binary' | 'stream' | 'response'` endpoint definitions with
  the same `format` and `contentType` route options.
- Request values a route contract or schema argument rejects answer the canonical
  validation body with `message: 'Validation failed'`, as `ValidationPipe` failures
  do, where `@Endpoint` input failures carried `'Endpoint input validation failed'`.
- Replace `@Serialize(dto)` and `SerializerInterceptor` with
  `@Get({ response: dto })`. The response is parsed as a whole, after
  interceptors: use `z.array(item)` where `@Serialize` parsed each array element.
  A `defineSerializer` result is a Standard Schema and serves as `response`
  directly; it no longer has a `.schema` property.
- `@ApiResponse(status, options)` becomes Nest's `@ApiResponse({ status,
  description, schema })`, and `schema` is a Standard Schema or `defineDto`
  descriptor; raw JSON Schema is rejected. Declare the success body with the
  route's `response` option instead.

Statuses follow Nest: a POST route answers 201, a route with `response: null`
or `@HttpCode(204)` answers 204, and every other route answers 200; OpenAPI and
generated clients document the same status. A handler returning `null` or
`undefined` no longer answers 204; it answers the route's status with an empty
body. Declare `response: null` (or `@HttpCode(204)`) where clients expect 204,
and `@HttpCode(200)` on POST routes that must keep 200. A handler that returns a
ready `Response` (`c.json()`, `new Response()`) sends that Response's own
status, so a POST handler returning `c.json(body)` still answers 200 while
OpenAPI and generated clients now document 201: declare `@HttpCode(200)` or
`status: 200` on it so the document matches what it sends.

Without `response` or `format`, a route still sends strings as text and other
values as JSON. The route parses its result through `response` after
interceptors. `@CacheResponse` stores the response the route sent — its status,
media type and body, after every interceptor and the schema — so a cache store
never holds fields the schema strips, and a hit replays that response without
running the handler or parsing again. Interceptors outside `CacheInterceptor`
receive the replayed `Response` on a hit; a value they return instead of a
`Response` is ignored, and a `Response` they return is sent. This has a security consequence: an entry now includes what those
interceptors did for the request that stored it, and they no longer redo it per
request. An interceptor outside the cache that shapes the response per viewer
(removing fields by role, localizing) has its output for the first viewer
replayed to every request in the same cache scope. Make the cache `scope`
partition by everything the handler or any interceptor varies the response on,
or leave such routes uncached. `shouldCache` receives the body the route sends,
JSON-decoded, instead of the handler's value, so it no longer sees fields the
`response` schema strips. A fallback an interceptor outside `CacheInterceptor`
sends when the call inside it throws or has not settled is not cached; a
fallback an interceptor inside it (a controller or method interceptor, or a
global one registered after `CacheModule`'s) returns for a failed handler is
that call's result, and is cached. Route entries carry a new address and format version, so entries an
earlier release stored with the handler's raw result miss once after the
upgrade, also while older isolates still write them. When you tighten a
`response` schema, change the cache `namespace` (or invalidate the affected
scopes) for it to apply to entries stored before their TTL expires.

`@Query()` without a schema returns repeated keys (`?tag=a&tag=b`) as arrays
instead of the first value, and keys a query schema declares as arrays in its
JSON Schema arrive as arrays even when sent once, beside fields JSON Schema
cannot express such as `z.coerce.date()`. A key the schema declares as a scalar
arrives as an array when it is repeated, so `@Query(schema)` and
`@Query(name, schema)` answer 400 for `?page=1&page=2` where the first value used
to pass: declare the field as an array, or send the key once. A
schema without a JSON Schema converter (a Valibot schema, a `parse()` parser)
receives an array only for a repeated key. A named
parameter without a schema follows its declared type: `string`, `number` and
`boolean` parameters still receive the first value, an array parameter without
a pipe always receives an array, and an `unknown` or union parameter, or an
array a pipe such as `ParseArrayPipe` splits, receives an array for a repeated
key. `string | undefined` and `string | null` are unions: declare such a
parameter optional (`role?: string`) to keep the first value. OpenAPI documents
the parameters that receive one value or repeated keys as such, and
`vela client generate` types them `string | Array<string>`. Declare a schema,
or `ParseArrayPipe`, for values that may be one or many.

`@Body()` with no schema validates a parameter class carrying a static schema
(a Standard Schema, a `defineDto` descriptor or a `parse()` parser, as
`ValidationPipe` reads it) even without a global pipe, so bodies such a class
rejects now answer 400; a named `@Body('item') item: Item` validates the `item` member. It
validates as the body is read, before any pipe, unless a `ValidationPipe` (or a
subclass) applies to the parameter; then that pipe validates it in pipe order,
as in Nest, and every `ValidationPipe` that applies validates. A validation
pipe of your own that is not a `ValidationPipe`, such as one parsing
`metatype.schema`, now runs on the value the class already validated, which
fails for schemas whose transforms do not accept their own output: make it
extend `ValidationPipe`, or remove it. A global `ValidationPipe` still validates
body parameters registered without a route reader. The class is read from the
parameter's reflected type: an `import type` or a union annotation such as
`Item | undefined` erases it to `Object`, and the body is then accepted
unvalidated, so import the class as a value and annotate with it alone.

A route validates every request group its `defineRoute` contract declares —
`params`, `query` and `body`, with the body's encoding and limits — after guards
and before the handler, whether or not a parameter reads it, as `@Endpoint` did.
`@Body()`, `@Query()` and `@Param()` read the validated values, and a
`ValidationPipe` does not validate them again. The application fails to start
when a `params` schema leaves out a path parameter the route serves, when a
named parameter reads a key its group's schema does not return, and when a
parameter declares its own schema for a declared group or is typed with a class
whose static schema is not the group's, which the route's schema replaces: type
such a parameter with `ContractBody`, `ContractQuery` or `ContractParams`. A
contract that declares a `body` schema without an encoding reads JSON within the
application's limit, counted after guards. The key checks need a
schema that lists its keys as JSON Schema without passing undeclared keys
through, as a Zod object does. For any other, such as a Valibot schema, a
`parse()` parser, a union or a transform that renames keys, a named parameter
that reads a key the request carries but the validated value lacks fails that
request with a 500 whose reported error names the key, as does a whole
`@Param()` whose validated params lack a path parameter the request carries.
OpenAPI documents a `params` or `query` schema JSON Schema cannot describe as an
object as the decorator options do (path parameters as strings, the query as
unsupported by `vela client generate`) instead of failing the document. The validation ships
with `@Body`, `@Query` and `@Param`: a Worker bundle that uses none of them
leaves it out, and a route declaring request groups or a form body then fails
to start with an error saying so.

Method decorators with `response` or `format` are `RouteMethodDecorator<Result>`
values that check the handler's result; they are no longer assignable to
`MethodDecorator`. Annotate wrapper helpers with `RouteMethodDecorator<T>` or
let TypeScript infer them. Decorators without those options remain
`MethodDecorator`s. A route serving a `defineRoute` contract rejects `@HttpCode`
at startup; declare `status` in the contract, which types its clients.

An `@Override`'d CRUD verb answers the verb's status (200 for restore, upsert,
import, batch restore and upsert, version rollback) unless it declares its own
`@HttpCode` or returns a ready `Response`, and OpenAPI documents that status. An
overridden `create`, `batchCreate` or `clone` that returns a value therefore
answers 201 instead of 200; add `@HttpCode(200)` to keep 200. OpenAPI documents 201 for the generated `batchCreate` and `clone`,
the status they already answered. The generated `upsert` answers 201 when it
creates the row and 200 when it updates one; OpenAPI documents only its 200.

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
- A Hono `HTTPException` with a 4xx status answers `{ error: { code, message } }`,
  unless it was built with its own `res`. From middleware or a raw Hono route this
  replaces its plain-text response; thrown from a controller handler, it now answers
  its 4xx instead of a redacted 500.
- A Hono `HTTPException` with another status below 500 and no `res`, such as
  `new HTTPException(302)` from raw Hono middleware, a raw Hono route or a Vela
  middleware, is reported and answers a redacted 500 instead of its own response.
  One built with its own `res` still sends it, but the raw Hono edge now reports it.
  Redirect with `c.redirect()` or a returned `Response`.
- An exception filter's plain result is sent with `getErrorStatus(error)`, the
  exception's status (`HttpException.getStatus()` or `VelaError.status`) when it is
  400–599, else 500, instead of 200. Return `{ status, body }` to choose the
  status. A filter that returns `undefined` leaves the error to the default
  renderer instead of sending 204.
- An RPC failure caused by an exception-owned 4xx body with `error.code` and
  `error.message`, such as a `CrudException` envelope, carries that code and
  message (`{ code: 'NOT_FOUND', message: <its message>, status: 404 }`) instead
  of the status's code and `'RPC request failed'` (`{ code: 'not_found', … }`).
  Update RPC clients that match error codes.
- A GraphQL field error from a branded `VelaError` or a 4xx Hono `HTTPException`
  answers the status's public code (`FORBIDDEN`, `NOT_FOUND`, …) instead of
  `INTERNAL_SERVER_ERROR`.
- The last-resort Hono `onError`, which receives errors thrown by raw Hono
  middleware and routes, now applies the application's `ExceptionHandler.render`
  hook. Exception filters run only where the edge has a pipeline: controller
  handlers, RPC procedures, GraphQL resolvers, Vela middleware, unmatched routes
  and request limits.

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

`@Sse()` streams what its handler returns: an iterable or async iterable of
`MessageEvent`, or a `Response`. Another result, such as a JSON object, no longer
compiles and fails the request with a redacted 500:

```ts
// Before (1.30.0): @Sse was a GET route, and the handler built the stream.
@Sse('/events')
events(@Req() c: Context) {
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: 'status', data: JSON.stringify({ ready: true }) });
  });
}
```

```ts
// After: yield events (or return streamSSE(c, ...) with @Ctx() c).
@Sse('/events')
async *events(): AsyncIterable<MessageEvent> {
  yield { type: 'status', data: { ready: true } };
}
```

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
key, calls `getHandlerName()`. `Reflector.getAll()` returns one value per target,
typed `Array<T | undefined>`, instead of a `[handler, class]` tuple.

Declarations on an ancestor class apply to the controllers that extend it, as in
Nest. Class metadata reads the controller's own, else the nearest ancestor's, in
every `Reflector` form, so `@Roles(['admin'])` on an abstract base controller
guards each controller that extends it. Class-level `@UseGuards`,
`@UseInterceptors`, `@UsePipes`, `@UseFilters` and `@UseMiddleware` on an
ancestor run for the subclass, ancestors first. On a method the controller
inherits unchanged, the ancestors' method metadata, method-level enhancers and
`SkipGuardPhases` apply; an override reads only its own. Opening markers are
inherited too: `@Public()`, `@OptionalAuth()`, `@TenantIgnored()`,
`@CedarPublic()` or `@SkipThrottle()` on a base controller now opens its subclasses'
routes. Remove a declaration from the base class, or override the method, where a
subclass must not inherit it. Unlike Nest, route decorators (`@Get()`, `@Post()`, …)
are still read from the controller class itself, so a method a base class routes
is not mounted on its subclasses: route the inherited method on the subclass, for
example `Get('list')(Sub.prototype, 'list', descriptor)`. *1.32.0:* such a route that
declares no options of its own takes those of the nearest ancestor's route for
the same verb and method (its `response`, `status` or `defineRoute` contract),
and reads the parameters the ancestor declares on the method.

Global guards run in phases: `authenticate`, `tenant`, `authorize`, `feature`.
Better Auth, Cloudflare Access, `TenantModule`, `AuthzModule`, `CedarModule` and
`FeatureFlagsModule` install their guard globally by default; `guard: 'none'`
opts out. Replace Better Auth's `isGlobal` with `guard` (`isGlobal: false`
becomes `guard: 'none'`) and Cedar's `globalGuard: false` with `guard: 'none'`. On
every module, `isGlobal` only makes exports global: `FeatureFlagsModule`'s
`isGlobal: true` no longer registers `FeatureFlagGuard`, which the module
registers by default. Remove `@UseGuards` for guards the modules now install (a
redundant `@UseGuards(FeatureFlagGuard)` evaluates the flag twice), or pass
`guard: 'none'` and keep a fully route-level pipeline. The installed guards
cover every application route, including modules that do not import
`TenantModule` or `CedarModule`. Cedar denies routes without
`@RequireResource()` or `@CedarPublic()`; set `undeclared: 'allow'` to keep
the previous behavior. Declare the policy of generated CRUD controllers with the
resource's `decorators` and `endpointDecorators`. Integration packages mark their own
controllers with `SkipGuardPhases` from `@velajs/vela/module-kit`. It skips the
global guards in the named phases whose class declares
`static readonly skippable = true` (`TenantGuard`, `PermissionGuard`, `RolesGuard`
and `CedarGuard`), whoever registers them: an application's own
`{ provide: APP_GUARD, useClass: TenantGuard }` is skipped there too, where 1.30.0
ran every global guard on the Better Auth handler, the storage controllers and the
GraphQL endpoint. Check tenant membership for storage actions in the storage
`http.authorize` callback. Other global guards still run there. An application
guard that extends an integration guard inherits `skippable`; declare
`static override readonly skippable = false` on it to keep it running there.
`SkipGuardPhases` applies only to controller routes; see
[guards on WebSocket, live-query and RPC entrypoints](#guards-on-websocket-live-query-and-rpc-entrypoints)
for the entrypoints where the installed guards also run.

An application's own global guard runs in the phase its class declares with
`static readonly phase`, else in `feature`; 1.30.0 ran every global guard in
registration order. Declare `static readonly phase = 'authenticate'` on a custom
global authentication guard, such as an `APP_GUARD` JWT guard, and `'tenant'` or
`'authorize'` on a custom global tenant or authorization guard. Without it, an
authentication guard runs after the installed `TenantGuard`, `PermissionGuard`,
`RolesGuard` and `CedarGuard` and after the RPC `authorize` policy, so they run
without the identity it publishes, and it runs in import order relative to
`ThrottlerGuard`. With the phase declared, import order no longer decides whether
authentication runs before throttling, and the RPC `authorize` policy, which runs
after global authentication and tenant guards, can read the trusted identity.

`ThrottlerGuard` publishes its decisions under the `RATE_LIMIT` request-context
key instead of the `rateLimit` Hono variable, one per throttler name: read
`requestContext.get(RATE_LIMIT)?.default` where you read `c.get('rateLimit')`.

With a global prefix, startup fails for a relative `forRoutes()` target that
reaches prefixed routes while its written path also matches a route registered
outside the prefix, such as an adapter's absolute `POST /rpc` under
`forRoutes(':resource')`. Cover that route in the same `forRoutes()` with an
absolute target (`{ path: '/rpc', absolute: true }`) or its controller, or leave it
out with an absolute `exclude()`. An absolute target or `exclude()` accounts only for
the outside routes it matches itself, so `{ path: '/rpc', absolute: true }` does not
cover an excluded `GET /health`: startup still fails until that route is covered or
excluded too. `globalPrefixOptions: { exclude }` serves chosen
controller routes without the prefix, as Nest's `setGlobalPrefix(prefix, { exclude })`
does.

### Guards on WebSocket, live-query and RPC entrypoints

Global guards also run outside controller routes: on WebSocket gateway messages,
on the check before each push to a socket (run with the gateway class), on the
reserved `$live` frames that subscribe to and unsubscribe from live queries and
send presence heartbeats (run with the framework's `LiveEngine` class) and on RPC
procedures. `SkipGuardPhases` applies only to controller routes. The guards the
integrations now install reach these entrypoints too, so with default options an
upgraded application sees:

- `CedarModule` rejects each gateway message without `@RequireResource()` or
  `@CedarPublic()` with an `exception` frame (`code: 'internal'`), drops pushes,
  never answers `$live` frames, and answers an undeclared RPC procedure with a 403
  failure frame. The Cedar guard 1.30.0 installed let undeclared handlers through.
- `TenantModule` fails gateway messages, pushes and `$live` frames the same way,
  because a socket context has no request to select the tenant from, and requires
  a tenant and an authenticated identity on RPC procedures, as on routes.
- `CloudflareAccessModule` fails every gateway message, push and `$live` frame,
  in `mode: 'optional'` too, and requires an Access identity on RPC procedures,
  as on routes.
- `AuthzModule` and `FeatureFlagsModule` let undeclared handlers through, but now
  enforce `@Roles()`, `@RequirePermission()` and `@FeatureFlag()` on gateway
  handlers and RPC procedures. A socket message has no request context to
  evaluate a flag for, so a `@FeatureFlag()` on a gateway rejects its messages
  even when the flag is on.

A guard failure on a `$live` frame or a push reaches only the error reporter,
which skips 4xx errors by default, so live queries stop updating and presence
rosters leave the socket out without a visible error. To keep gateways, live
queries and RPC working:

- Put `@CedarPublic()` or `@RequireResource()`, and `@TenantIgnored()` or
  `@TenantOptional()`, on gateway classes and RPC providers, or on their handlers
  and procedures. A marker on the gateway class, not on a handler, also admits the
  gateway's pushes.
- No marker reaches `$live` frames, including one on the `@LiveResolver()` class.
  Admit their tenant with `TenantModule`'s `resolve` option, and set
  `undeclared: 'allow'` on `CedarModule` or pass it `guard: 'none'`:

```ts
import { normalizeWebSocketUpgradeIdentity } from '@velajs/vela/websocket';
import { TenantModule } from '@velajs/tenant/vela';

TenantModule.forRoot({
  lookup,
  authorize,
  // Socket frames and pushes admit the tenant the upgrade verified.
  resolve: (context) => {
    if (context.getType() !== 'ws') return undefined;
    const identity = normalizeWebSocketUpgradeIdentity(context.switchToWs().getClient().data);
    return identity
      ? {
          tenantId: identity.tenantId,
          principal: { ...identity.principal, expiresAtMs: identity.expiresAtMs },
          source: 'websocket',
        }
      : undefined;
  },
});
```

- `CloudflareAccessModule` has no socket option. With gateways or live queries,
  pass `guard: 'none'`, authenticate sockets at upgrade with
  `CloudflareAccessUpgradeAuthenticator`, and apply `CloudflareAccessGuard` to HTTP
  controllers with `@UseGuards`. Global guards run before route guards, so apply
  the tenant and authorization guards there too: pass `guard: 'none'` to their
  modules and use `@UseGuards(CloudflareAccessGuard, TenantGuard, PermissionGuard)`.
- With `guard: 'none'`, a module installs no global guard, so gateways, live
  queries and RPC run only the guards you apply to them.

## Cloudflare adapter

The Cloudflare adapter wires the core `WebSocketModule` and `LiveModule` itself, so
one static module boots in the Worker, in each `VelaWebSocketDurableObject` and on
a node host:

```ts
// Before (1.30.0)
@Module({
  imports: [
    CloudflareWebSocketModule.forRoot(),
    LiveModule.forRootAsync({
      inject: [ENV],
      useFactory: (env) => ({
        driver: () => durableObjectLive({ namespace: env.ROOMS, gatewayPath: '/rooms/:room/ws' }),
        log: () => durableObjectCursorLog(),
      }),
    }),
  ],
  providers: [RoomsGateway, TodoLive],
})
class RoomModule {}
```

```ts
// After: WebSocketModule from @velajs/vela/websocket, LiveModule from @velajs/vela/live.
@Module({
  imports: [WebSocketModule.forRoot(), LiveModule.forRoot()],
  providers: [RoomsGateway, TodoLive],
})
class RoomModule {}
```

- `CloudflareWebSocketModule` is removed. Import `WebSocketModule.forRoot()` in the
  Worker as well: without it, the Worker mounts no upgrade route, and a
  binding-backed gateway's upgrades answer 404 (the adapter reports each such
  gateway through the diagnostics policy).
- `durableObjectLive()` takes the binding name, `durableObjectLive({ binding: 'ROOMS', gatewayPath })`,
  and is the Worker's default when one gateway names a `binding`; configure it only
  to choose among several. Drop `durableObjectCursorLog()`: the Durable Object
  supplies its SQLite cursor log, and `new DoCursorLog(sql, maxRows?)` takes the
  SQLite handle.
- A Worker that imports `LiveModule` but declares no binding-backed gateway no
  longer falls back to `localLive()`: invalidations reject. Declare the gateway, or
  configure `LiveModule.forRoot({ driver: () => localLive() })`.
- A missing or mistyped binding fails naming its Wrangler key
  (`ENV.ROOMS is not set: declare the Durable Object namespace binding 'ROOMS' under durable_objects.bindings …`);
  an upgrade reports it and answers the redacted JSON 500 instead of plain text.

The `middleware: (env) => handlers` option of `createCloudflareWorker` and
`createCloudflareApp` is removed. Apply request middleware from a module, where a
middleware class can inject `ENV`, and add Hono routes in the synchronous
`configure(app, env)` hook:

```ts
// Before (1.30.0)
export default createCloudflareWorker(AppModule, {
  middleware: (env) => [
    async (context, next) => {
      context.header('x-service', env.SERVICE_NAME);
      await next();
    },
  ],
});
```

```ts
// After
@Injectable()
class ServiceHeader implements NestMiddleware {
  constructor(@InjectEnv() private readonly env: VelaEnv) {}
  async use(context: VelaContext, next: () => Promise<void>) {
    context.header('x-service', this.env.SERVICE_NAME);
    await next();
  }
}

@Module({ providers: [ServiceHeader] })
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(ServiceHeader).forRoutes('*');
  }
}

export default createCloudflareWorker(AppModule, {
  configure(app, env) {
    app.getHonoApp().get('/version', (c) => c.text(env.SERVICE_VERSION));
  },
});
```

A custom runtime adapter wires its platform the same way, through the global
`WS_TRANSPORT` (`@velajs/vela/websocket`) and `LIVE_PLATFORM` (`@velajs/vela/live`)
tokens. See [Cloudflare integration](../packages/cloudflare/README.md).

*1.32.0:* define the application once with `defineCloudflareApp` when the Worker
entry also exports Durable Object, Workflow or service entrypoint classes built
from it; `createCloudflareWorker(AppModule, options)` is
`defineCloudflareApp(AppModule, options).worker`. A hand-written Durable Object
can become an `@Injectable()` host that injects the object's storage and the
application's providers:

```ts
// Before (1.31.0)
export class Counter extends DurableObject {
  async increment(by: number): Promise<number> {
    const value = ((await this.ctx.storage.get<number>('value')) ?? 0) + by;
    await this.ctx.storage.put('value', value);
    return value;
  }
}
export default createCloudflareWorker(AppModule);
```

```ts
// After
@Injectable()
export class CounterHost {
  constructor(@Inject(DO_STORAGE) private readonly storage: DurableObjectStorage) {}

  async increment(by: number): Promise<number> {
    const value = ((await this.storage.get<number>('value')) ?? 0) + by;
    await this.storage.put('value', value);
    return value;
  }
}

const app = defineCloudflareApp(AppModule);
export class Counter extends VelaDurableObject(app, CounterHost, { rpc: ['increment'] }) {}
export default app.worker;
```

Only the methods `rpc` lists are reachable over RPC, and a failed call rejects
with an `EntrypointError` whose status, code and details survive the RPC boundary
from `compatibility_date` 2026-04-21 (or the `enhanced_error_serialization`
flag); `vela deploy check` warns with `rpc-error-serialization` before that date.
Host invocations, like Workflow runs (`VelaWorkflow`), service entrypoint calls
(`VelaEntrypoint`) and `@OnEmail()`/`@OnTail()` handlers, run the guards,
interceptors and filters (and pipes on RPC arguments) declared on the host or
handler class and method; application-wide `APP_GUARD`, `APP_INTERCEPTOR`,
`APP_PIPE` and `APP_FILTER` components do not apply, so declare the guards those
entrypoints need on them.
`vela g durable-object` now writes such a host and class. See
[Durable Objects](durable-objects.md) and [entrypoints](entrypoints.md).

`VelaWebSocketDurableObject` boots through the same application context and also
accepts the app. When its application fails to start, a waiting caller receives a
redacted `EntrypointError` (`500 internal`) instead of the startup error, which the
object logs; read the object's logs for the cause.

## Realtime

Each live query, gateway push and presence roster is declared once.

A live query's wire name lives in its shared definition, and clients take a list
of definitions:

```ts
// Before (1.30.0)
export const todoList = defineLiveQuery({ args: TodoListArgs, result: TodoListResult });

@LiveResolver()
class TodoLive {
  constructor(private readonly todos: TodoService) {}

  @LiveQuery('todos.list', todoList, { tags: ['todos'] })
  list(args: { listId: string }) {
    return this.todos.byList(args.listId);
  }
}

const client = createLiveClient({ url, queries: { 'todos.list': todoList } });
```

```ts
// After
export const todoList = defineLiveQuery({
  name: 'todos.list',
  args: TodoListArgs,
  result: TodoListResult,
});

@LiveResolver()
class TodoLive {
  constructor(private readonly todos: TodoService) {}

  @LiveQuery(todoList, { tags: ['todos'] })
  list(args: { listId: string }) {
    return this.todos.byList(args.listId);
  }
}

const client = createLiveClient({ url, queries: [todoList] });
```

React and React Native apps export the list, `const queries = [todoList]`, pass
it to the client and type their hooks with
`createLiveHooks<InferLiveContract<typeof queries>>()`. `LiveQueryDefinition` and
`defineLiveQuery` take the name as their first type argument
(`LiveQueryDefinition<'todos.byId', { id: string }, Todo[]>`), and the
`LiveQuerySchemas` and `LiveQueryParsers` types become `LiveQueryDefinitions<Contract>`.
The engine validates every result with the definition's `result` schema, so a
resolver returns its rows as read.

`broadcastToRoom()` is removed from `@velajs/cloudflare`. Push to a gateway's rooms
from any provider with `Gateways` from `@velajs/vela/websocket`, which reads the
Durable Object binding, path and frame limit from the gateway's metadata:

```ts
// Before (1.30.0)
await broadcastToRoom(env.ROOMS, '/rooms/:room/ws', room, 'system', { text });
```

```ts
// After
interface ChatEvents {
  system: { text: string };
}

@Injectable()
export class Announcements {
  constructor(private readonly gateways: Gateways) {}

  announce(room: string, text: string) {
    return this.gateways.of<ChatEvents>(ChatGateway).to(room).emit('system', { text });
  }
}
```

A gateway's `@WebSocketServer()` reaches only that gateway's sockets, so two
gateways can share a room id; inject `WS_SERVER` into another provider to address
every gateway. A `WS_SERVER` test double receives a gateway's pushes only while
`WebSocketModule.forRoot()` is imported. A custom transport's `WsClient` sets
`path` to its gateway's route, a custom `RoomRegistry` skips sockets whose `path`
differs from `cmd.gatewayPath`, and every `redis()` instance is upgraded
together.

*1.32.0:* a gateway whose module sees two or more `WS_SERVER` providers fails
bootstrap, also when they all come from `WebSocketModule` instances it imports:
import one `WebSocketModule` instance in the gateway's module, or provide
`WS_SERVER` there. A gateway now handles the `@SubscribeMessage()` events an
ancestor class declares on methods it inherits unchanged, with the guards that
apply to them, as in Nest; override such a method without the decorator where a
gateway must not serve it.

`PresenceService.beat()`, `PresenceService.roster()` and `presenceTag()` take the
gateway path first, and a presence tag is `$presence:` plus a SHA-256 hex digest.
`LiveQueryContext.path` is required, so code that builds a context, such as a
resolver test, sets it; a `@LiveQuery` tags function receives `(args, context)`.
Replace `@Res()` and `stampCommitHeaders` on a mutation with
`@LiveInvalidates(tags)`, which invalidates after the handler succeeds and stamps
the commit headers. See [WebSockets](websockets.md) and
[live queries](live-queries.md).

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

*1.32.0:* `@velajs/mail` reports an unclaimed `@OnInboundEmail` handler failure on the
`'email'` edge of `ErrorReportContext` (with `kind: 'mail:inbound'`) instead of
`'queue'`: an `ExceptionHandler` that selects inbound mail failures by
`edge === 'queue'` matches `'email'` now. Cloudflare Durable Objects, Workflows,
Email Workers and Tail Workers report on `'durable-object'`, `'workflow'`, `'email'`
and `'tail'`: an `ExceptionHandler` whose `report()` or `context()` switches
exhaustively over `ErrorReportContext.edge` must handle these four edges.

Storage aborts and deadlines stop follow-up work without retrying abandoned writes.
An already-issued native write can still commit. Reconcile uncertain results at
the application boundary instead of assuming timeout means rollback. R2 range
responses report the returned range length.

See [queues](queues.md), [events](event-sourcing.md), [scheduling](scheduling.md)
and [storage](../packages/storage/README.md).

## Feature surfaces

Each feature has one module, configured with binding names instead of live
bindings, so one static module serves every environment:

```ts
// Before (1.30.0), in modules built from forRootAsync({ inject: [ENV], useFactory })
StorageModule.forRoot({ disks: [{ disk: 'uploads', bucket: env.UPLOADS }], defaultDisk: 'uploads' }); // @velajs/cloudflare
ResponseCacheModule.forRoot({ namespace: 'api-v1', scope, store: new KVCacheStore(env.CACHE) });
ThrottlerModule.forRoot({
  limit: 100,
  ttl: 60_000,
  storage: cloudflareRateLimitStore(env.API_LIMITER, { limit: 100, periodSeconds: 60 }),
});
```

```ts
// After, declared once at module scope
StorageModule.forRoot({ name: 'uploads', driver: r2Storage({ binding: 'UPLOADS' }) }); // @velajs/storage
CacheModule.forRoot({ namespace: 'api-v1', scope, store: kvCache({ binding: 'CACHE' }) });
ThrottlerModule.forRoot({
  throttlers: [{ limit: 100, ttl: 60_000 }],
  storage: rateLimitStore({ binding: 'API_LIMITER' }),
});
```

- **Bindings:** module options name a binding, `{ binding: 'CACHE' }`, which is
  read from each application's `ENV` when first used. The Workers factories
  `kv`, `r2`, `d1`, `queue`, `durableObject` and `rateLimit` come from
  `@velajs/cloudflare`; a missing binding fails naming its Wrangler key. Other
  options that need the environment take a function of `ENV`, which each
  application calls for itself.
- **Storage:** the Cloudflare `StorageModule` (with `StorageService`,
  `StorageManagerService`, `R2StorageDriver` and `STORAGE_OPTIONS`) and
  `@velajs/vela/storage` are removed. Register a `StorageModule.forRoot({ name, driver: r2Storage({ binding }) })`
  from `@velajs/storage`, with `r2Storage` from `@velajs/cloudflare/storage`, per
  former disk, and inject its `StorageService` with `@InjectStorage(name)`. A disk's
  `root` becomes the static `prefix`; its `{date}`, `{year}`, `{month}`, `{day}` and
  `{uuid}` tokens have no replacement, so build such keys in the application. The
  presign-proxy route `GET /storage/:disk` is gone, so URLs it issued stop working:
  serve downloads through `publicBaseUrl`, the authorized
  `http: { download: 'proxy' }` controller, or provider-signed URLs.
  `STORAGE_SIGNED_URL_PURPOSE` leaves `@velajs/vela/security`; pass your own
  `purpose` to `signUrl` and `verifySignedUrl`.
- **Cache:** the synchronous cache is removed and the response cache takes its
  names: `ResponseCacheModule` is `CacheModule`, `ResponseCacheService` is
  `CacheService`, `ResponseCacheInterceptor` is `CacheInterceptor`, and
  `RESPONSE_CACHE_OPTIONS` is `CACHE_MODULE_OPTIONS`. Replace `@Cacheable()`,
  `@CacheKey(key)` and `@CacheTTL(seconds)` with `@CacheResponse({ key, ttl })`,
  manual `CacheService` calls with `cache.scope(scope).get/set/invalidateKey`, and
  `varyBy` with a private scope chosen from the trusted identity in `scope(context)`.
  A Workers KV store is `store: kvCache({ binding })`, and generations
  `invalidation: kvCacheInvalidation({ binding })`. Store failures the cache absorbs
  are now reported to the application's error reporter (edge `'cache'`).
- **CORS:** `CorsModule` and `CORS_OPTIONS` are removed, and `CorsOptions` moves to
  `@velajs/vela`. Call `app.enableCors(options)` or pass the `cors` create option
  (`createCloudflareWorker(AppModule, { cors })` on Workers). CORS runs ahead of
  body limits, middleware and guards. A credentialed `'*'` origin or a `maxAge` that is
  not a non-negative integer throws, and framework CORS cannot be combined with `SecurityModule`'s
  exact-origin `cors` option (pass `cors: false` there).
- **Throttling:** `ThrottlerModule.forRoot({ limit, ttl })` becomes
  `forRoot({ throttlers: [{ limit, ttl }] })`, and `@Throttle({ limit, ttl })`
  becomes `@Throttle({ default: { limit, ttl } })`. `@SkipThrottle()` skips only the
  `'default'` throttler; `@SkipThrottle({ name: true })` skips a named one. Custom
  stores implement `increment(key, ttl, limit, throttlerName)`, and a custom
  `generateKey` is `(context, tracker, throttlerName)`. Default counter keys gain
  the throttler name, so counts in a shared store restart. Throttler names are
  letters, digits, `_` or `-`: a Nest-style name such as `'per.minute'` fails
  bootstrap. `rateLimitStore()`
  requires each binding's configured limit and period to equal its throttler's
  `limit` and `ttl`, which must be 10 or 60 seconds; a throttler it cannot serve
  fails bootstrap.
- **Studio:** the per-feature modules (`StudioCrudModule`, `StudioLiveModule`,
  `StudioQueueModule` and the others) become panels in
  `StudioModule.forRoot({ plugins: [crudPanel(), livePanel({ rooms }), …] })`.
  `managedModels` and `runAsIdentity` move to `crudPanel()`,
  `StudioLiveModule.forRoot({ source })` becomes `livePanel({ source })`, and
  `StudioCloudflareTimeTravelModule.forRoot({ namespace })` becomes
  `cloudflareTimeTravelPanel({ binding })`. `StudioAppHolder.capture(app, routePathOptions)`
  takes the application's `RoutePathOptions` (`app.getRoutePathOptions()`) instead
  of the global prefix string.
- **Throttling (1.32.0):** the default in-memory `ThrottlerStorage` keeps each
  counter for its own `ttl` and tracks at most `maxKeys` open windows (default
  50,000). When they are all open, a request with a new key answers 429 until the
  earliest window ends, instead of the store forgetting counters. Raise the bound
  with `storage: () => new ThrottlerStorage({ maxKeys })`, keep in-memory windows
  short, or count long ones in a shared store.
- **Studio (1.32.0):** `StudioModule.forRoot({ plugins })` and `forRootAsync` fail
  when a plugin provides `ENV`, `APP_LOGGER`, `ROOT_MODULE`, `Container`,
  `DiscoveryService` or `EntrypointRegistry`; provide them in the application.
  Studio reads these tokens application-wide, as `app.get()` does, and an
  application with Studio fails to boot when a `@Global()` module exports a
  `Container` other than the application's. `StudioDispatchRegistry` no longer
  takes a `DiscoveryService` in its constructor.
- **CRUD (1.32.0):** `CrudModule.forFeature()` reads repeated slashes as one when
  it checks for duplicate paths, so two different features registered under
  `'/notes'` and `'//notes'` fail bootstrap instead of both mounting. Mount each
  path once, or import one shared `defineCrudFeature(...)` definition.

See [caching](caching.md), [security](security.md) for CORS and throttling,
[storage](../packages/storage/README.md) and [Studio](../packages/studio/README.md).

## CLI and testing

`@velajs/cli` needs no `vela.config` in a Workers project: every command reads
Wrangler's `main`, loads the `createCloudflareWorker(AppModule)` entry and builds
the application its descriptor describes, with the Wrangler `vars` as `ENV`. A
`vela.config` still takes precedence; delete it when it only named the Worker's
root module. Zero-configuration loading needs the `@velajs/cloudflare` release
that attaches the Worker descriptor. The commands that build the application
accept `--env`.

- `vela deploy check` no longer requires its flags. Without `--config` it reads
  the Wrangler file in the working directory, without `--env` it checks the
  top-level configuration, and without `--entrypoints` it builds the application
  and computes the snapshot. Keep passing `--entrypoints` to check a saved
  snapshot without importing application code.
- While a command loads and runs the application, the application's console
  output goes to stderr, so stdout carries only the command's output, such as a
  `--json` document or the MCP stdio channel.
- `resolveConfig()` falls back to the Wrangler file (`source: 'wrangler'`) instead
  of failing, and `loadConfig(cwd, config?, options?)` returns
  `{ config, path, source, importModule, dispose }`.
- Projects from `vela new` have no `vela.config.ts`, regenerate binding types in
  their `dev` and `typecheck` scripts, and test the Worker with
  `createTestingWorker()` from `@velajs/cloudflare/testing`, which needs
  `@velajs/testing` as a dev dependency.

`createTestingWorker(AppModule, { env, overrides })` builds the module as the
Worker does inside the Workers Vitest pool, and its `fetch()`, `queue()` and
`scheduled()` drive the Worker's handlers. The testing builder adds Nest's
`overrideModule(Module).useModule(Replacement)` and `useMocker(factory)`, and
`Test.createTestingModule(metadata, options)` accepts every `VelaFactory.create`
option. See [tooling](tooling.md) and [testing](testing.md).

*1.32.0:*

- `vela cf sync --write` keeps cron triggers no `@Cron` job declares, which a
  Worker entry's own `scheduled` handler may serve, and a comparison reports them
  without failing; pass `--prune` to remove them as before.
- With a `wrangler.toml`, `vela add d1|kv|r2|queue` creates and registers the
  resource, prints the binding table to add under `Manual steps required`, and
  exits 2 instead of 0. Scripts that call it should treat 2 as "done, apart from
  the printed steps" (1 still means failure).
- `vela g durable-object` writes an `@Injectable()` host and a
  `VelaDurableObject` class built from the Worker entry's app instead of a
  `DurableObject` subclass, and `vela cf sync` binds a gateway binding that no
  class serves only to a `VelaWebSocketDurableObject` class.
- A module class that implements `NestModule` is built, and its `configure()`
  called, after the whole graph is registered and, in `@velajs/testing` 1.32.0,
  after provider overrides and `useMocker` apply. That testing release requires
  core 1.32.0: on core 1.31 its overrides and `useMocker` would not apply.

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
