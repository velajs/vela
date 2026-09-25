# Upgrading framework integrations

This guide collects the behavior changes and migration steps after the 1.24.0
baseline. The DI, execution, schema, transport and database sections cover the APIs
that require core 1.25.0: RPC and GraphQL 1.1.0 require this core version, and named
databases require CRUD 1.25.0 with compatible adapters. The module contract, HTTP
error and guard, Cloudflare adapter, realtime, feature surface, and CLI and testing
sections cover core 1.31.0 and the integrations released with it. Update the core
and affected integrations together using their published dependency ranges; consult
each package's changelog for its version. A prepared version in this repository
becomes installable only after publication to npm.

## Import paths

`@velajs/vela` exports each name from exactly one entry point. The root is the
application kit: the factory, modules and dependency injection, controllers and
their decorators, the request pipeline, HTTP exceptions, `ConfigModule` and
`Logger`. Integrations and runtime adapters import `Container`,
`MetadataRegistry`, discovery, entrypoint kinds, execution scopes,
`PipelineRunner`, route contributors and `invokeScheduledJob` from
`@velajs/vela/module-kit`. Optional features have their own subpaths: `/cache`,
`/throttler`, `/schedule`, `/events`, `/health`, `/logging`, `/http-client`,
`/openapi`, `/security`, `/dispatch`, `/validation`, `/queue`, `/live` and
`/websocket`. Core 1.31.0 removes `/storage`; file storage is `@velajs/storage`.
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
`useClass`, `useExisting`) throws. Better
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
  instead of `{ statusCode, message, errors }`; `@Endpoint` input failures answer the
  same body with the message `'Endpoint input validation failed'`.
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
inherits unchanged, the ancestors' method metadata, method-level enhancers,
`@Serialize` and `SkipGuardPhases` apply; an override reads only its own. Opening
markers are inherited too: `@Public()`, `@OptionalAuth()`, `@TenantIgnored()`,
`@CedarPublic()` or `@SkipThrottle()` on a base controller now opens its subclasses'
routes. Remove a declaration from the base class, or override the method, where a
subclass must not inherit it. Unlike Nest, route decorators (`@Get()`, `@Post()`, …)
are still read from the controller class itself, so a method a base class routes
is not mounted on its subclasses: route the inherited method on the subclass, for
example `Get('list')(Sub.prototype, 'list', descriptor)`.

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
`{ provide: APP_GUARD, useClass: TenantGuard }` is skipped there too. Other global
guards still run there. An application guard that extends an integration guard
inherits `skippable`; declare `static override readonly skippable = false` on it to
keep it running there. Import order no longer decides whether authentication runs
before throttling. The RPC `authorize` policy runs after global authentication and
tenant guards, so it can read the trusted identity.

`ThrottlerGuard` publishes its decisions under the `RATE_LIMIT` request-context
key instead of the `rateLimit` Hono variable, one per throttler name: read
`requestContext.get(RATE_LIMIT)?.default` where you read `c.get('rateLimit')`.

With a global prefix, startup fails for a relative `forRoutes()` target that
reaches prefixed routes while its written path also matches a route registered
outside the prefix, such as an adapter's absolute `POST /rpc` under
`forRoutes(':resource')`. Cover that route in the same `forRoutes()` with an
absolute target (`{ path: '/rpc', absolute: true }`) or its controller, or leave it
out with an absolute `exclude()`. `globalPrefixOptions: { exclude }` serves chosen
controller routes without the prefix, as Nest's `setGlobalPrefix(prefix, { exclude })`
does.

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
  the throttler name, so counts in a shared store restart. `rateLimitStore()`
  requires each binding's configured limit and period to equal its throttler's
  `limit` and `ttl`, which must be 10 or 60 seconds; a throttler it cannot serve
  fails bootstrap.
- **Studio:** the per-feature modules (`StudioCrudModule`, `StudioLiveModule`,
  `StudioQueueModule` and the others) become panels in
  `StudioModule.forRoot({ plugins: [crudPanel(), livePanel({ rooms }), …] })`.
  `managedModels` and `runAsIdentity` move to `crudPanel()`,
  `StudioLiveModule.forRoot({ source })` becomes `livePanel({ source })`, and
  `StudioCloudflareTimeTravelModule.forRoot({ namespace })` becomes
  `cloudflareTimeTravelPanel({ binding })`.

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
