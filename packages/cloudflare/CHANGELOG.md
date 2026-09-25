# Changelog

## 1.32.0

### Minor Changes

- 0dccc7f: Durable Objects are Vela entrypoints. `defineCloudflareApp(AppModule, options)` defines one application: its `worker` is the Worker's default export, and the Durable Object classes defined from it share its root module and options. `VelaDurableObject(app, Host, { rpc })` from `@velajs/cloudflare/durable-objects` returns a Durable Object class whose JS-RPC methods are the host methods `rpc` names:
  
  ```ts
  const app = defineCloudflareApp(AppModule);
  export class Counter extends VelaDurableObject(app, CounterHost, { rpc: ['increment'] }) {}
  export default app.worker;
  // await env.COUNTER.getByName('orders').increment(1)
  ```
  
  - Each instance boots one application context with `VelaFactory.createApplicationContext`, in its constructor under `blockConcurrencyWhile`. The host, an `@Injectable()`, is added to the root module's providers. The context injects the object's `ENV` and the new `DO_STATE`, `DO_STORAGE` and `DO_ID` tokens, and the app's runtime adapters configure its container (`configureContainer`) as they do the Worker's. Their other hooks (`onBootstrap`, `onRoutesBuilt`, `invocationTransport`, `getClientIp`, `requestMiddleware`) do not run in the object, which serves no HTTP routes. `VelaDurableObject(AppModule, Host, { rpc })` takes a bare root instead. A class uses the app when it is defined, so declare it in the module that defines the app: in the Worker entry, or beside an app defined in a module of its own that the entry imports.
  - The RPC surface is explicit: exactly the host methods `rpc` names are RPC methods, and a `DurableObjectNamespace<Counter>` stub exposes exactly their signatures. No other method is reachable over RPC, even from plain JavaScript naming it on a stub: not an unlisted public method, a TypeScript `private` or `protected` helper, a lifecycle hook or the container's `dispose()` hook. Without `rpc`, the object serves only its event handlers. `rpc` is typed to the host's public methods (`DurableObjectRpcMethod<Host>`); when the class is defined, a name that is not a prototype method of the host (an accessor, or an instance field such as an arrow function), a hook (`onModuleInit`, ..., `dispose`, `collectEntrypoints`), an event handler, or `ctx`, `env`, `connect`, `dup`, `id`, `name` or `then` (which the class or its stubs own) throws, and so does a host whose prototype defines `then()`, since every instance would be a thenable and resolving it would hang. A host's `fetch`, `alarm`, `webSocketMessage`, `webSocketClose` and `webSocketError` become the object's handlers.
  - Each RPC call and event runs in its own execution scope, so request-scoped providers are built per call, through the host's scoped guards, pipes (RPC arguments only), interceptors and filters. A `fetch()` response with a streamed body keeps its scope open, as the HTTP edge does, until the body is read, fails or is cancelled, under the object's `waitUntil`. Application-wide `APP_GUARD`, `APP_INTERCEPTOR`, `APP_PIPE` and `APP_FILTER` components do not apply; failures still reach the application's `ExceptionHandler`. `ExecutionContext.getType()` is `'rpc'`, `'cf:do:fetch'`, `'cf:do:alarm'` or `'cf:do:websocket'`, and `getPayload()` is the arguments.
  - Failures are reported first. An RPC call rejects only with an `EntrypointError` (`EntrypointError`, `isEntrypointError()` and `EntrypointErrorInit` are exported from `@velajs/cloudflare`; service entrypoints share it). It carries what HTTP sends for the error, with server bodies redacted: its `status`, `code` and `message`, and its `details` below 500. A 4xx `HttpException` keeps its code, message and details, a branded `VelaError` keeps its code and message at any status, as over HTTP, and an unknown error becomes `500 internal`. Unlike HTTP, a branded `VelaError` with a 5xx status loses its details, and a 4xx `HttpException` constructed with an object response, which HTTP sends as it is, keeps only its status (code `error`, message `Entrypoint request failed`) unless that object is a canonical `{ error: { code, message, details } }` body. No stack frame, cause or other property of the original error crosses the RPC boundary. `isEntrypointError()` recognizes the plain `Error` workerd delivers to the caller. workerd keeps those properties across RPC only from `compatibility_date` 2026-04-21 or with the `enhanced_error_serialization` flag; on an older date the caller receives an `Error` whose message is `EntrypointError: <message>`, without its status, code or details. An `EntrypointError` a host rethrows, such as another object's failure, keeps its code, message and details for a client fault and only its status for a server fault, and a failure outside the pipeline is reported and becomes `500 internal`. `fetch()` renders the JSON error body; alarms and WebSocket events rethrow for the platform. A context that fails to start resets the object, and waiting callers receive only a redacted `500`.
  - The Worker descriptor lists the Durable Object classes defined from the app (`durableObjects`), and each class carries a `CloudflareDurableObjectDescriptor` under the static `CLOUDFLARE_DURABLE_OBJECT` key, so tools know what each exported class serves. `isCloudflareApp()` recognizes an app definition.
  - `createCloudflareWorker(AppModule, options)` is `defineCloudflareApp(AppModule, options).worker`.
  - `CloudflareApp` types an app definition. `@velajs/cloudflare/durable-objects` exports `DurableObjectRoot`, `VelaDurableObjectOptions`, `VelaDurableObjectClass`, `DurableObjectRpc`, `DurableObjectRpcMethod`, and `DurableObjectExecutionContext`, the `ExecutionContext` that guards, interceptors and filters receive around an invocation, whose `getType()` values are `DurableObjectInvocationKind`.
  - The host code lives in `@velajs/cloudflare/durable-objects`, and the Workflow, service entrypoint, email and tail code in their own subpaths: the minimal `createCloudflareWorker()` Worker (one controller, bundled by Wrangler with `--minify`) bundles none of it. It measures 163,895 bytes raw and 55,713 bytes gzipped in this release, against 155,636 and 52,363 for 1.31.0 (mostly the core's route contracts and application context, then the app definition and the Worker's optional `email` and `tail` handlers), within its unchanged ceiling.
  
  **Behavior change:** `VelaWebSocketDurableObject(root)` boots through the same application context as `VelaDurableObject`, and also accepts the app from `defineCloudflareApp`, whose runtime adapters then configure its container (`configureContainer`). Its context injects `DO_STATE`, `DO_STORAGE` and `DO_ID`. When its application fails to start, a waiting caller receives a redacted `EntrypointError` (`500 internal`) instead of the startup error, which the object logs. An application that does not import `WebSocketModule` now fails after its lifecycle hooks ran, and its context is disposed.
- 8f3d0a6: Workflows, service entrypoints, email and tail are Vela entrypoints. Their classes are defined from the app of `defineCloudflareApp(AppModule, options)`, like Durable Objects, and run in the Worker's own application for the event's environment: the one the Worker's `fetch`, `queue` and `scheduled` handlers use, with its singletons, runtime adapters and `ENV`. Their hosts are added to the root module's providers. Application-wide `APP_GUARD`, `APP_INTERCEPTOR`, `APP_PIPE` and `APP_FILTER` components do not apply to Workflow runs, service entrypoint calls, or email and tail handlers, as for Durable Objects: their callers are the platform and other Workers, not HTTP requests. Declare guards on the host or handler class or method.
  
  ```ts
  const app = defineCloudflareApp(AppModule);
  export class SignupWorkflow extends VelaWorkflow(app, SignupHost) {}
  export class Billing extends VelaEntrypoint(app, BillingHost, { rpc: ['charge'] }) {}
  export default app.worker;
  ```
  
  - **Workflows.** `VelaWorkflow(app, Host)` from the new `@velajs/cloudflare/workflows` subpath returns a `WorkflowEntrypoint` class whose `run(event, step)` calls the `run` method of `Host`, an `@Injectable()`. The engine's `event` and `step` pass through untouched, so `step.do`, `step.sleep` and `step.waitForEvent` keep their retry and replay semantics. Each run executes in its own execution scope (request-scoped providers per run) through the host's scoped guards, interceptors and filters, with `ExecutionContext.getType()` `'cf:workflow'` and `getPayload()` the event. A failure is reported (`edge: 'workflow'`) and rethrown as it is, so the engine honors `NonRetryableError`; a scoped filter that catches it settles the run with what it returns. The engine's own interruptions, an `Error` whose message starts with `Aborting engine:` that a step rejects with when the instance is paused, restarted or terminated, pass through as they are: they are not reported and no filter sees them, so a paused instance stays paused and can resume. The class type takes the params from the host's `run(event)`, so `wrangler types` types the binding (`Workflow<Readonly<SignupParams>>`), and `WorkflowParams<T>` reads them from a Workflow class or host. `workflow<Params>({ binding })`, a new binding reference of the root entry, creates and reads instances by binding name.
  - **Service entrypoints.** `VelaEntrypoint(app, Host, { rpc })` from the new `@velajs/cloudflare/entrypoints` subpath returns a `WorkerEntrypoint` class whose JS-RPC methods are exactly the host methods `rpc` names, typed on a `Service<typeof Billing>` binding; nothing else is reachable over RPC. `ctx`, `env`, `dup`, `then`, the lifecycle hooks and the `WorkerEntrypoint` handlers (`fetch`, `connect`, `email`, `queue`, `scheduled`, `tail`, `tailStream`, `test`, `trace`) are rejected when the class is defined. Each call runs in its own execution scope through the host's scoped guards, pipes (the arguments), interceptors and filters (`getType()` `'rpc'`), with the caller's `ctx.props` injectable as the request-scoped `ENTRYPOINT_PROPS` token (`{}` when the caller attached none). Failures are reported (`edge: 'rpc'`) and reject only with an `EntrypointError`; a call to an application that fails to start rejects with a redacted `500`.
  - **Email and tail.** `@OnEmail({ to? })` from the new `@velajs/cloudflare/email` subpath and `@OnTail()` from the new `@velajs/cloudflare/tail` subpath make provider methods Email Workers and Tail Workers handlers (entrypoint kinds `cf:email` and `cf:tail`); importing them gives the Worker (`app.worker`, `createCloudflareWorker()`) its `email` and `tail` handlers. An email goes to the handlers whose `to` lists its envelope recipient, compared without regard to case, else to those without `to`; each receives the native `ForwardableEmailMessage` in its own execution scope through its scoped guards, interceptors and filters. A message no handler accepts is rejected with `setReject(UNCLAIMED_EMAIL_REASON)` instead of dropped, and handler failures are reported (`edge: 'email'`) and rethrown unless a scoped filter handles them. Every `@OnTail()` handler receives every `TraceItem[]` batch; its failures are reported (`edge: 'tail'`) and never thrown into the platform's loop. When the application fails to start, the `tail` handler logs the error to the console and resolves, and the next batch retries.
  - **Hosts.** A host whose prototype defines `then()`, as a method or an accessor, is rejected when a Workflow or service entrypoint class is defined from it, as for a Durable Object: every instance would be a thenable, and resolving the host would hang.
  - **Descriptors.** The Worker descriptor and the app list the Workflow and service entrypoint classes defined from the app (`workflows`, `entrypoints`), and each class carries a `CloudflareWorkflowDescriptor` or `CloudflareEntrypointDescriptor` under the new static `CLOUDFLARE_WORKFLOW` or `CLOUDFLARE_ENTRYPOINT` key. The descriptor's `createApplication(env)` includes their hosts. A Workflow or service entrypoint class defined after the app started building its Worker application throws.
  - **Testing.** `createTestingWorker()` drives `email(message)` and `tail(events)`. `emailMessage({ from, to, subject?, text?, headers?, raw? })` builds a `ForwardableEmailMessage` that records `setReject()`, `forward()` and `reply()` (`rejectReason`, `forwards`, `replies`), and `traceItem(overrides?)` builds a `TraceItem`.
  - `CloudflareApplication.getContainer()` returns the application's container, for dispatch seams that take it with `entrypoints`.
  - Types: `@velajs/cloudflare/workflows` exports `VelaWorkflowClass`, `WorkflowHost`, `WorkflowOutput`, `WorkflowParams` and `WorkflowExecutionContext`; `@velajs/cloudflare/entrypoints` exports `EntrypointRpc`, `EntrypointRpcMethod`, `VelaEntrypointClass`, `VelaEntrypointOptions` and `EntrypointRpcExecutionContext`; `@velajs/cloudflare/email` exports `OnEmailOptions`, `OnEmailDecorator` and `EmailExecutionContext`; `@velajs/cloudflare/tail` exports `OnTailDecorator` and `TailExecutionContext`; and `@velajs/cloudflare/testing` exports `TestingEmailMessage` and `TestingEmailInit`. Each `*ExecutionContext` is the `ExecutionContext` that guards, interceptors and filters receive around that kind of invocation.
  - The new subpaths stay out of the minimal `createCloudflareWorker()` Worker.

### Patch Changes

- Updated dependencies [9dea818]
- Updated dependencies [524e422]
- Updated dependencies [a7d0912]
- Updated dependencies [04e7ac5]
- Updated dependencies [ff98301]
- Updated dependencies [38ab1e5]
- Updated dependencies [ef18e04]
- Updated dependencies [38ab1e5]
- Updated dependencies [586be4f]
- Updated dependencies [9c1bd0b]
- Updated dependencies [e412fc8]
- Updated dependencies [bcdf5e3]
- Updated dependencies [d5a8c60]
  - @velajs/vela@1.32.0
  - @velajs/storage@1.32.0
  - @velajs/testing@1.32.0
  - @velajs/feature-flags@1.31.0

## 1.31.0

### Minor Changes

- 5f19b37: The Cloudflare adapter wires the core `WebSocketModule` and `LiveModule` itself, so an application imports the same modules on every runtime and one static `AppModule` boots in a Worker, in each `VelaWebSocketDurableObject` and on a node host. `cloudflareAdapter` registers the platform as the global `WS_TRANSPORT` and `LIVE_PLATFORM` tokens before modules load; it never replaces a module's providers.
  
  - In the Worker, `WebSocketModule` serves an upgrade route for each gateway that names a `binding`. The route authenticates the upgrade before the Durable Object id is derived, reconciles it with the request's trusted identity, and forwards it to the gateway + room Durable Object as before. A gateway's `@WebSocketServer()` has no sockets in the Worker, so pushes from there throw with guidance to push with `Gateways` from `@velajs/vela/websocket`.
  - Inside the Durable Object, the server gateways inject broadcasts to that object's hibernatable sockets. `LiveModule` delivers locally, and its cursor log is a `DoCursorLog` in the object's SQLite storage when the class is SQLite-backed (`new_sqlite_classes`), in memory otherwise (`new_classes`).
  - `LiveModule` in the Worker defaults to `durableObjectLive()`: an invalidation goes to the room Durable Object of the application's single binding-backed gateway, and the namespace is read from `ENV` when an invalidation first needs it. The gateways come from their decorators, so an invalidation sent from `onModuleInit` or `onApplicationBootstrap` reaches the room as well. The first invalidation fails with an ambiguity error only when several binding-backed gateways could hold the subscriptions. `durableObjectLive({ binding, gatewayPath, defaultRoom })` chooses; every option is optional. A Worker configured with `localLive()` still warns once.
  - `createCloudflareWorker(AppModule, { configure(app, env) {} })` finishes each application's HTTP surface, such as extra Hono routes, once per environment. It runs after the application is built and before any event, including concurrent cold events, reaches it. A throw fails that construction, and the next event retries. It must be synchronous and do no I/O; a `configure` that returns a promise fails construction.
  - A minimal `createCloudflareWorker()` Worker no longer bundles the core WebSocket upgrade routes, the gateway dispatcher or the live protocol. It still carries the adapter's own wiring: the Worker transport that forwards upgrades to a room's Durable Object, the default `durableObjectLive()` driver and the check for gateways without `WebSocketModule`. The adapter reads the Cloudflare-attested `cf-connecting-ip` header directly, which also keeps Hono's WebSocket upgrade helper out. With the rest of this release, including the single HTTP error renderer, gateway scoping and framework CORS, a minimal `createCloudflareWorker()` Worker measures 155,636 bytes raw and 52,363 bytes gzipped, against 159,520 and 53,539 for 1.30.0.
  
  **Behavior change:** `CloudflareWebSocketModule` is removed. Import `WebSocketModule.forRoot()` from `@velajs/vela/websocket` in the Worker and the Durable Object alike. Without it, the Worker mounts no upgrade route, so a binding-backed gateway's upgrades answer 404 instead of reaching its Durable Object; the adapter reports each such gateway through the diagnostics policy, a warning by default. The `WsGatewayRoute` type and `CloudflareApplication.scanInstances()` and `getWsGatewayRoutes()` are removed with it: the upgrade routes come from `WebSocketModule`.
  
  **Behavior change:** `durableObjectLive()` takes the binding name, not the namespace object: replace `durableObjectLive({ namespace: env.ROOMS, gatewayPath })` with `durableObjectLive({ binding: 'ROOMS', gatewayPath })`, or drop the `driver` option to use the default. `LiveModule` no longer needs `forRootAsync({ inject: [ENV] })` for the driver. A Worker that imports `LiveModule` but declares no binding-backed gateway no longer falls back to `localLive()`: each invalidation rejects with "no @WebSocketGateway names a binding". A write through `@Crud({ live })`, or one that calls `LiveInvalidation.invalidate()` itself, commits and then returns that error; a `@LiveInvalidates` handler answers with its result, without commit headers, and reports the error through the application's error reporter (`edge: 'live'`). Declare the gateway, or configure `LiveModule.forRoot({ driver: () => localLive() })` explicitly. `durableObjectCursorLog()` is removed; drop the `log` option, since the adapter supplies the SQLite log inside the Durable Object. `new DoCursorLog(sql, maxRows?)` takes the SQLite handle.
  
  **Behavior change:** the `middleware: (env) => handlers` option of `createCloudflareWorker` and `createCloudflareApp` is removed. Apply request middleware from a module with `configure(consumer)`; a consumer middleware class resolves through dependency injection, so it can inject `ENV` with `@InjectEnv()`. Use `configure(app, env)` for routes added to the Hono app. The `CloudflareAppOptions` type holds the options both entries share.
- 1011653: Bindings are referenced by name and resolved from each application's `ENV` when used. `@velajs/vela/module-kit` adds the seam: `BindingRef` (`{ binding: 'CACHE' }`), `BindingKind` (what a binding is and the configuration key that declares it), `resolveBinding(env, ref, kind)`, `defineBinding(kind)` for lower-camel binding factories, the `EnvFactory<T>` type for option values an application builds from its own `ENV`, and `readEnv(container)` for module providers. A missing binding fails with `ENV.CACHE is not set: declare the KV namespace binding 'CACHE' under kv_namespaces …`; a binding of another kind fails naming the same key.
  
  `@velajs/cloudflare` exports the Workers binding factories built on it: `kv`, `r2`, `d1`, `queue`, `durableObject` and `rateLimit`. `kv({ binding: 'CACHE' })` reads no environment when declared; calling it with an application's `ENV` returns the typed native binding. The Cloudflare Queues driver and the Worker's gateway room objects (WebSocket upgrade forwarding, `Gateways` pushes, `durableObjectLive()` invalidations and `LiveInspector` reads) resolve their bindings through the same seam.
  
  **Behavior change:** a send to a registered queue whose producer binding is missing or is not a producer rejects with `Queue 'email' cannot send: ENV.EMAIL_QUEUE is not set: …` (or `… is not a binding of type queue producer …`) instead of the previous wording. A WebSocket upgrade, `Gateways` push, `durableObjectLive()` invalidation or `LiveInspector` read whose gateway's Durable Object binding is missing or is not a namespace fails with `ENV.ROOMS is not set: declare the Durable Object namespace binding 'ROOMS' under durable_objects.bindings …` (or `… is not a binding of type Durable Object namespace …`); an upgrade reports that error through the application's error handler and answers with the redacted 500 body. Upgrades previously answered a plain-text 500 (`Durable Object binding 'ROOMS' is not configured`).
- 2c92243: `createCloudflareWorker()` attaches a descriptor under the symbol key `CLOUDFLARE_WORKER` (`Symbol.for('vela.cloudflare.worker')`) to the Worker it returns: `{ rootModule, options, createOptions(env), createApplication(env) }`. It is enumerable, so an entry that adds handlers with `{ ...worker, email }` keeps it; the platform reads only string-keyed handlers. `createOptions(env)` includes `env`, and `createApplication(env)` builds the application without the Worker handlers or the `configure(app, env)` hook, which receives the Workers application. Tools build the same application as the Worker from it without a platform event; `@velajs/cli` uses it to load a project without `vela.config`. The Worker is typed as the exported `CloudflareWorker` interface, and `CloudflareWorkerDescriptor` describes the descriptor.
  
  The new `@velajs/cloudflare/testing` subpath runs inside the Workers Vitest pool. `createTestingWorker(AppModule, { env?, overrides?, ...workerOptions })` builds the module as `createCloudflareWorker(AppModule, workerOptions)` does, its adapters and then its `configure(app, env)` hook, through `@velajs/testing` (now an optional peer dependency), with `overrides` receiving the testing builder (`overrideProvider`, `overrideModule().useModule()`, `useMocker`). `worker.module` is the compiled `TestingModule`; its `fetch()` and `http` client send the Worker's environment as `c.env`. The returned worker's `fetch()`, `queue(queue, messages)` and `scheduled(cron)` drive the Worker handlers with `cloudflare:test`'s `createMessageBatch`, `getQueueResult` and `createScheduledController`: `queue()` reports the acknowledgements and whether the handler rejected, and `scheduled()` rejects a cron no `@Cron` job declares. `queueJob(queue, job, data)` builds the envelope `QueueClient.add()` sends, and `close()` cancels unread response bodies before waiting for background work. The subpath is not part of any Worker bundle.
- dfe925c: CORS is configured as in Nest. `app.enableCors(options?)` on `VelaApplication` and the `cors` create option (`VelaFactory.create(AppModule, { cors: true | CorsOptions })`) serve Hono's `cors` middleware ahead of body limits, routing and guards, so preflights are answered before any guard runs and refusals stay readable cross-origin. `enableCors` takes effect on the next request with no rebuild; a later call replaces the options. A credentialed `'*'` origin and a `maxAge` that is not a non-negative integer are rejected. `CorsOptions` is exported from `@velajs/vela`. On Workers, `createCloudflareWorker(AppModule, { cors })` and `createCloudflareApp(AppModule, { env, cors })` take the same option, and `CloudflareApplication.enableCors()` works inside `configure(app, env)`. Every application now carries Hono's `cors` middleware, and one pass-through middleware when CORS is off.
  
  **Behavior change:** `CorsModule` and `CORS_OPTIONS` are removed from `@velajs/vela/security`, and `CorsOptions` moves from `@velajs/vela/security` to `@velajs/vela`. Replace `imports: [CorsModule.forRoot(options)]` with `app.enableCors(options)` or the `cors` create option; the options keep their shape (`origin`, `allowMethods`, `allowHeaders`, `exposeHeaders`, `credentials`, `maxAge`). Options `CorsModule` passed through unchecked now throw when CORS is enabled: `credentials: true` with a `'*'` origin (browsers refuse it) and a `maxAge` that is not a non-negative integer. CORS now runs ahead of the body and query limits and every global middleware instead of among the global middleware, so their refusals carry the CORS headers. Without `allowMethods`, a preflight now allows Nest's defaults (GET, HEAD, PUT, PATCH, POST, DELETE); `CorsModule` sent no `Access-Control-Allow-Methods` then, so browsers refused cross-origin PUT, PATCH and DELETE. `SecurityModule`'s exact-origin `cors` option is unchanged, but it can no longer be combined with framework CORS: while it is on (it is unless `cors: false`), the `cors` create option fails bootstrap and `app.enableCors()` throws, because that middleware would answer every preflight before `SecurityModule`'s method and header checks.
- fd11d20: Push to a gateway's rooms from anywhere with `Gateways`, injectable from `@velajs/vela/websocket` wherever `WebSocketModule` is imported: `gateways.of<ChatEvents>(ChatGateway).to(room).emit('message', data)`. The explicit event map (event name → payload) types each push; `to(room)` and `in(room)` chain rooms. The target comes from the gateway's `@WebSocketGateway` metadata (`path`, `binding`, `roomParam`), and each push is bounded by that gateway's `maxFrameBytes` before anything is resolved or sent. `emit()` without a room and `except()` throw with guidance, and a class without `@WebSocketGateway` is rejected. The handle types are `GatewayServer<Events>` and `GatewayBroadcastOperator<Events>`.
  
  - A push reaches only that gateway's sockets on every runtime, so two gateways may use the same room id (such as an organization id) without one gateway's pushes reaching the other's sockets. `BroadcastCommand` gains an optional `gatewayPath`, which `Gateways` sets on every push and synchronized commands validate; `WsClient` gains an optional `path`, the gateway route the socket connected through (`NodeWsClient` and the Cloudflare client set it). The in-memory and Durable Object room registries deliver a command that names a gateway path only to sockets whose `path` matches, so a socket without one receives no gateway push or broadcast.
  - A gateway's `@WebSocketServer()` is that gateway's own server, scoped the same way: on node, Bun and Deno its broadcasts, including a global `emit()`, carry the gateway path and reach only the sockets connected through that gateway, where they previously reached every gateway's sockets in the named rooms. This holds for `@Inject(WS_SERVER)` in a gateway's constructor and for a constructor inherited from a base class (each gateway gets its own server), and `afterInit(server)` receives the server that injected handle pushes through: pushes through either reach the same sockets, but they are not the same object. Each broadcast is bounded by the gateway's own `maxFrameBytes`. `WebSocketModule` connects each gateway's server while the application starts, before any lifecycle hook runs, from the `WS_SERVER` the gateway's module sees when it sees exactly one, including one provided by an async `useFactory`. When it sees none, or only the servers of several `WebSocketModule` instances it imports, a `WebSocketModule` instance's own server serves the gateway; a module that sees another module's `WS_SERVER` beside those fails bootstrap with an error naming each module that provides one. A test double provided as `WS_SERVER` in the gateway's module, or through `overrideProvider(WS_SERVER)` in a testing module, receives the gateway's pushes as long as `WebSocketModule.forRoot()` stays imported: a `WS_SERVER` without `WebSocketModule` connects nothing. `WS_SERVER` injected outside a gateway still addresses every gateway's sockets. `WsServer` gains an optional `forGateway(gatewayPath, maxFrameBytes)`, which `WsServerImpl` implements (and its constructor takes an optional `gatewayPath`); a transport server without it is shared by every gateway as before. On Cloudflare each Durable Object holds one gateway's room, so behavior there is unchanged.
  - Presence rosters belong to one gateway room: heartbeats in a room of one gateway no longer appear in, or refresh, the `$presence.roster` of another gateway's room with the same id. `LiveQueryContext` gains `path`, the route path of the gateway the connection subscribed through, and a `@LiveQuery` tags function receives it as `(args, context)`. A `coalesceBy` partition is keyed by that path too, next to the query and its canonical args, so a resolver that answers per gateway never shares one run between subscribers of two gateways. `PresenceService.beat(gatewayPath, room, clientId, meta?)`, `PresenceService.roster(gatewayPath, room)` and `presenceTag(gatewayPath, room)` take the gateway path first; `inspectRooms()` still reports each room once, with the members of every gateway that uses its id. A roster's tag, `presenceTag(gatewayPath, room)`, is `$presence:` and the SHA-256 hex digest of the JSON `[gatewayPath, room]`, so every valid room id (up to 512 bytes) fits the 256-byte bound of an invalidation tag on any gateway path; room ids longer than 246 bytes previously failed the roster subscription. A heartbeat or departure whose roster invalidation the live driver fails to dispatch is reported through the application's error reporter instead of becoming an unhandled rejection.
  - A custom `RoomRegistry` passed to `WebSocketModule.forRoot({ registry })` must skip sockets whose `path` differs from `cmd.gatewayPath` in `deliverLocal`, as the built-in registries do; one that ignores the field delivers every gateway push and broadcast to all gateways' sockets in the named rooms. With `redis()`, upgrade every instance together: instances on an earlier release ignore `gatewayPath` and deliver to every gateway's sockets in the room.
  - Without a platform transport that delivers pushes, a push goes through the module's sync driver: in-process hosts (node, Bun, Deno) deliver it to the gateway's sockets in this process, and `redis()` fans it out to the gateway's sockets on every instance.
  - A platform transport delivers pushes elsewhere with the new optional `WebSocketTransport.deliver(delivery)`, which receives one `GatewayDelivery` (`{ gatewayPath, binding?, room, command }`) per gateway room; a gateway without `roomParam` has one room, its path. A push delivered to several gateway rooms settles every delivery first; when some fail it rejects with an `AggregateError` whose message names the failed rooms (`2 of 3 ChatGateway room pushes failed: "b", "c"`; past ten rooms, the first ten and how many more) and whose `errors` hold one error per failed room with the transport's error as its `cause`, while a push delivered to one room rejects with the transport's own error. A transport that delivers pushes but builds no server gives gateways a `@WebSocketServer()` that keeps no sockets and refuses each push with guidance to `Gateways`. A transport that forwards upgrades (`forwardUpgrade`) but implements neither `deliver` nor `createServer` keeps a gateway with a `binding` out of this process's reach under the `local()` sync driver: a push to it, through `Gateways` or through its `@WebSocketServer()`, rejects with guidance instead of resolving without reaching anyone. A cross-instance sync driver such as `redis()` may reach the isolate that holds its sockets, so both push paths then hand it the command.
  - On Cloudflare, a push from the Worker is a `broadcast` RPC to the gateway + room Durable Object, whose namespace is read by the gateway's `binding` from `ENV` when the push needs it. Inside a Durable Object, a push to its own room goes to its sockets, and a push to another room goes to that room's object instead of reaching no one. Pushing to a gateway without a `binding` fails with guidance.
  - The `Gateways` service and the refusing server live in the core WebSocket entry, which a minimal `createCloudflareWorker()` Worker does not load, and upgrades, pushes and live invalidations share one gateway-room resolver.
  
  **Behavior change:** a gateway's `@WebSocketServer()` no longer reaches other gateways' sockets, and it is no longer the `WS_SERVER` instance itself; a gateway that must address every gateway's sockets injects `WS_SERVER` into another provider. `WebSocketModule` connects a gateway's server: in an application or testing module without it, a `WS_SERVER` provided next to the gateway, or overridden with `overrideProvider(WS_SERVER)`, no longer reaches the gateway, whose pushes throw with guidance. Import `WebSocketModule.forRoot()`; a test double then serves the gateway when it is provided as `WS_SERVER` in the gateway's module or overridden in the testing module next to that import. A custom transport's `WsClient` must set `path` to its gateway's route: a socket without one receives no `Gateways` push and no broadcast from a gateway's `@WebSocketServer()`. `LiveQueryContext.path` is required, so code that builds a context, such as a resolver unit test, sets it; `PreparedLiveQuery.tags(context)` takes the subscribing connection's context. `PresenceService` methods and `presenceTag` take the gateway path first, and a presence tag is `$presence:` and a SHA-256 hex digest instead of the room id. `broadcastToRoom(namespace, gatewayPath, room, event, data, options?)` and its `BroadcastNamespace` type are removed from `@velajs/cloudflare`. Inject `Gateways` and call `gateways.of(Gateway).to(room).emit(event, data)`; the gateway's metadata supplies the namespace, path and frame limit.
- fd11d20: Add `@LiveInvalidates(tags, { room? })` to `@velajs/vela/live`. It runs as an interceptor on a handler: after the handler succeeds it invalidates the tags, static or derived from the result and the execution context (`(result, context) => tags`, where `[]` skips the invalidation), and stamps `Vela-Commit-Cursor` / `Vela-Commit-Epoch` on the handler's HTTP response through `switchToHttp().getResponse()`, or on a `Response` the handler returns. A mutation no longer needs `@Res()` and `stampCommitHeaders` to expose its commit. A handler that throws invalidates nothing. The interceptor resolves `LiveInvalidation` from the module that declares the controller before the handler runs, so a module that cannot reach `LiveModule` fails without committing the write. The tags callback's result type must match the handler's. An invalidation that fails after the handler has committed its write (a tags or room callback that throws, a live driver that cannot reach the room) does not fail the request: it is reported through the application's error reporter (`edge: 'live'`, `source` the handler's `Class.method`, note `invalidation failed after the handler succeeded`), and the request answers with the handler's result without commit headers, so the client drops its optimistic layer and subscribers catch up at the next invalidation of those tags. A failed response would invite a retry that repeats the committed write, which cannot repair the invalidation; keep write handlers idempotent, or accept an idempotency key, for clients that retry a request whose response they never received.
  
  Add `LiveInspector`, provided and exported by `LiveModule`: `inspect(rooms)` returns the subscription and presence rows of the named rooms (there is no global room list), read where their subscriptions live. A runtime adapter reads a room through the new optional `LivePlatform.inspect(room)`; without it, the application's engine answers. On Cloudflare the Worker calls the room Durable Object's `inspectLive` RPC through the gateway binding its live driver delivers to. When several named rooms live in one object, each subscription is reported once and each room's members once. The `LiveInspection` type is unchanged. Studio's `livePanel({ rooms })` reads through it.
  
  On Cloudflare, a gateway without `roomParam` keeps every socket in one room Durable Object, named by its path. Worker invalidations for such a gateway now go to that object whatever room they name, as upgrades and `Gateways` pushes do, instead of an object named by the room (`'default'` when none is named) that holds no sockets; `LiveInspector` reads follow the same rule. `liveInvalidateToRoom(namespace, gatewayPath, room, tags)` applies the same rule: for a gateway path without parameters it reaches the object named by the path. The Worker's live driver now validates the commit stamp a Durable Object returns before it reaches response headers.
- d51dbb3: `ThrottlerModule` takes Nest v5 named throttlers: `ThrottlerModule.forRoot({ throttlers: [{ name, ttl, limit }, ...], storage? })`. The global guard counts every request once per throttler, each in its own bucket (the key carries the throttler name), and answers 429 at the first one exceeded; later throttlers are not counted for that request. A throttler without `name` is `'default'`. Headers follow Nest: `X-RateLimit-Limit`, `-Remaining`, `-Reset` and `Retry-After` for `'default'`, suffixed `-<name>` for the others. The guard publishes its decisions under the `RATE_LIMIT` request-context key from `@velajs/vela/throttler`, one `RateLimitInfo` (`{ limit, remaining?, reset }`) per throttler name. `storage` also takes a function of the application's `ENV`, called once per application. Throttlers are validated when the application boots: at least one, unique names made of letters, digits, `_` or `-` (a Nest-style name such as `'per.minute'` fails), positive integer `ttl` (milliseconds) and `limit`. A store can check them too: `ThrottlerStore` gains an optional `validate(throttlers)`, called with the declared throttlers at bootstrap, so a store that cannot serve one fails the application instead of every request. The tracker is unchanged: the verified identity when one is published, else `getTracker` or the client IP.
  
  `@velajs/cloudflare` adds `rateLimitStore({ binding })`, the `ThrottlerModule` storage over Workers Rate Limiting bindings resolved by name from each application's `ENV`: one binding for every throttler, or `{ binding: { burst: 'BURST_LIMITER', sustained: 'API_LIMITER' } }` per named throttler. Each binding's configured limit and period must equal its throttler's `limit` and `ttl` (10 or 60 seconds). The store declares `fixedLimits`, so a `@Throttle()` override that changes a throttler it serves fails the application at bootstrap instead of being silently ignored by the platform. One binding serves only throttlers that share a `limit` and `ttl`. The store checks the declared throttlers at bootstrap, before any binding is charged: a throttler whose `ttl` is not 10 or 60 seconds, throttlers with different values on one binding (the error names the per-throttler form), a throttler the per-name map leaves out, and a map entry naming no declared throttler each fail the application. Workers Rate Limiting counters are kept per Cloudflare location and are eventually consistent, so its limits are approximate, and `X-RateLimit-Reset` and `Retry-After` report the configured period rather than a measured reset.
  
  **Behavior change:** `ThrottlerModule.forRoot({ limit, ttl })` is replaced by `forRoot({ throttlers: [{ limit, ttl }] })`. `@Throttle({ limit, ttl })` becomes `@Throttle({ default: { limit, ttl } })` (both fields optional, each a positive integer, checked when the decorator is applied), and `@SkipThrottle()` skips only the `'default'` throttler; use `@SkipThrottle({ name: true })` for a named one. As in Nest v5, `limit` and `ttl` override separately: a route's `@Throttle({ default: { limit } })` keeps its controller's `ttl`. A `@Throttle()` on a route or controller naming an undeclared throttler fails bootstrap. `ThrottlerStore.increment(key, ttl)` is now `increment(key, ttl, limit, throttlerName)`, `ThrottlerStorageRecord.enforcedLimit` is replaced by the store's `fixedLimits` flag, and `generateKey(tracker, { className, handlerName })` is now `generateKey(context, tracker, throttlerName)`. `THROTTLE_METADATA` and `SKIP_THROTTLE_METADATA` hold the whole decorator records.
  
  **Behavior change:** `ThrottlerGuard` no longer sets the untyped `rateLimit` Hono variable. Its decisions are under the `RATE_LIMIT` request-context key, a record keyed by throttler name (`Readonly<Record<string, RateLimitInfo>>`): replace `c.get('rateLimit')` with `requestContext.get(RATE_LIMIT)?.default`. The default counter key gains the throttler name, `throttler:<Class>:<handler>:<name>:<tracker>` instead of `throttler:<Class>:<handler>:<tracker>`, so counts in a shared store restart after upgrading.
  
  **Behavior change:** `cloudflareRateLimitStore(binding, { limit, periodSeconds })` and its `CloudflareRateLimitBinding` and `CloudflareRateLimitStoreOptions` types are removed. Use `storage: rateLimitStore({ binding: 'API_LIMITER' })` with a throttler whose `ttl` and `limit` match the binding.
- 4a06057: `CacheModule` from `@velajs/vela/cache` is the one cache module, asynchronous end to end and built on `defineModule` (`forRoot` and `forRootAsync`). `namespace` and the trusted `scope` resolver stay mandatory. `store` is optional: without it each application gets its own `MemoryCacheStore` of `max` entries (default 1000). `store` and `invalidation` also take a function of the application's `ENV`, called once per application, so a static registration serves every environment. `@CacheResponse({ ttl, tags, key })` caches GET routes and the injected `CacheService` serves `scope(trustedScope)` reads and post-commit invalidation over the same store. `CacheStore` is one interface whose methods may return values or promises, so memory, tiered and KV stores all fit it.
  
  `@velajs/cloudflare` adds `kvCache({ binding })` and `kvCacheInvalidation({ binding })`: `CacheModule.forRoot({ namespace, scope, store: kvCache({ binding: 'CACHE' }), invalidation: kvCacheInvalidation({ binding: 'CACHE_GENERATIONS' }) })` reads each namespace from the application's `ENV` when an operation needs it, and names `kv_namespaces` when it is missing. `ErrorReportContext.edge` gains `'cache'`. `KVCacheStore` and `KVCacheInvalidationStore` accept a namespace or a function returning one.
  
  **Behavior change:** the synchronous cache is removed: the former `CacheModule` (`ttl`, `max`, `isGlobal` registering its interceptor, `varyBy`, synchronous `store`), its `CacheService` (`get`/`set`/`del`/`clear`), `CacheInterceptor`, `@Cacheable()`, `@CacheKey()`, `@CacheTTL()`, `CACHE_MANAGER` and the `CACHEABLE_METADATA`, `CACHE_KEY_METADATA` and `CACHE_TTL_METADATA` keys. Replace `@Cacheable()` + `@CacheKey(key)` + `@CacheTTL(seconds)` with `@CacheResponse({ key, ttl })`, and manual `CacheService` calls with `cache.scope(scope).get/set/invalidateKey`. Credentialed routes that relied on `varyBy` select a private scope from trusted identity in `scope(context)` instead.
  
  **Behavior change:** the asynchronous response cache takes the single names: `ResponseCacheModule` is `CacheModule`, `ResponseCacheService` is `CacheService`, `ResponseCacheInterceptor` is `CacheInterceptor`, `RESPONSE_CACHE_OPTIONS` is `CACHE_MODULE_OPTIONS`, and the types `ResponseCacheOptions`, `ResponseCacheScope`, `ResponseCacheEntryOptions` and `ScopedResponseCache` are `CacheModuleOptions`, `CacheScope`, `CacheEntryOptions` and `ScopedCache`. `AsyncCacheStore` and `AnyCacheStore` are replaced by `CacheStore`. Stored entries keep their keys, so existing KV caches stay valid. Configuring two `CacheModule`s in one application fails bootstrap, as two response-cache modules did.
  
  **Behavior change:** a store, generation or scope failure the cache absorbs as a miss or a false outcome is now reported to the application's error reporter (edge `'cache'`, the operation as `source`): it is logged by default, or passed to the `ExceptionHandler`'s `report`. `onError` still receives it afterwards. A missing or misnamed KV binding is therefore visible on its first use instead of disabling the cache silently; match it in the handler's `dontReport` to mute it.
- 1bfc1c1: `StorageModule` from `@velajs/storage` is the one storage module. Its `driver` may be a function of the application's `ENV`, called on the first storage operation of each application, so one static `StorageModule.forRoot` serves every environment without reading a binding at boot. On Cloudflare Workers, `r2Storage({ binding: 'UPLOADS' })` from the new `@velajs/cloudflare/storage` subpath is its native R2 driver: the bucket is resolved by name from `ENV` and validated, and a missing binding fails the operation naming `r2_buckets`. `@velajs/storage` is an optional peer of `@velajs/cloudflare`, needed only by that subpath.
  
  **Behavior change:** the Cloudflare `StorageModule` is removed, with `StorageService`, `StorageManagerService`, `StorageController`, `R2StorageDriver`, `STORAGE_OPTIONS` and the `StorageModuleOptions`, `DiskConfig` and `PresignedUrlConfig` types from `@velajs/cloudflare`. Register a `StorageModule.forRoot({ name, driver: r2Storage({ binding }) })` from `@velajs/storage` per former disk and inject its `StorageService` (`@InjectStorage(name)` for a named bucket). A disk's `root` becomes the bucket's `prefix`, which is static: the `{date}`, `{year}`, `{month}`, `{day}` and `{uuid}` tokens have no replacement, so build such keys in the application. Its HMAC presign-proxy route (`GET /storage/:disk`) is gone and URLs it issued stop working: serve downloads through `publicBaseUrl`, the authorized `http: { download: 'proxy' }` controller, or provider-signed URLs from the S3 or R2 HTTP/hybrid drivers.
  
  **Behavior change:** the `@velajs/vela/storage` subpath is removed with the second `StorageDriver` contract, `expandPathTemplate` and `joinStoragePath` it held for that module, and `STORAGE_SIGNED_URL_PURPOSE` leaves `@velajs/vela/security`. Use `@velajs/storage`'s driver contract and key helpers (`joinKey`, `normalizePrefix`, `sanitizeKey`); `signUrl` and `verifySignedUrl` stay on `@velajs/vela/security` with an application-chosen `purpose`.
- f267c2f: Routes compose like Nest's `setGlobalPrefix(prefix, { exclude })` and URI versioning:
  
  - `VelaFactory.create(AppModule, { globalPrefix: '/api', globalPrefixOptions: { exclude: ['health', { path: 'webhooks/:id', method: 'POST' }] } })` serves matching controller routes without the prefix. Targets use the middleware route grammar and match the controller path plus the route path. A relative middleware target resolves under the prefix, so startup fails when one also matches an excluded route that no absolute or controller target of the same middleware covers or excludes. `RouteManager.setGlobalPrefix(prefix, { exclude })` takes the same options, and `createCloudflareWorker`/`createCloudflareApp` pass them through.
  - `VERSION_NEUTRAL` serves a controller or route without a version segment; combine it with numbers (`@Version([2, VERSION_NEUTRAL])`) to serve both.
  - `versioning: { prefix }` sets the text before the version number (default `'v'`; `false` serves `/1/...`).
  - `app.getRoutePathOptions()` returns this composition; pass it to `createOpenApiDocument(AppModule, app.getRoutePathOptions())` so documents match the served paths. The CLI's OpenAPI and client commands and Studio's OpenAPI view use it, and route contributors receive it as `routePathOptions`.
  
  **Behavior change:** With a global prefix, startup fails for any relative `forRoutes()` target that reaches prefixed routes while its written path also matches a route registered outside the prefix, not only a route `exclude` serves unprefixed. An adapter's absolute route counts too: under `globalPrefix: '/api'`, `forRoutes(':resource')` also matches the `RpcModule` endpoint `POST /rpc`, so startup fails. Previously the build failed only when such a target reached no prefixed route at all. Cover the outside route in the same `forRoutes()` with an absolute target (`{ path: '/rpc', absolute: true }`) or its controller, or leave it out with an absolute `exclude()`. An absolute target or exclude accounts only for the outside routes it matches itself: with both `RpcModule` and an excluded `health` route, `forRoutes(':resource', { path: '/rpc', absolute: true })` still fails startup for `GET /health` until that route is covered or excluded too.

### Patch Changes

- Updated dependencies [0b8c649]
- Updated dependencies [1011653]
- Updated dependencies [088f4d4]
- Updated dependencies [f267c2f]
- Updated dependencies [dfe925c]
- Updated dependencies [b227d22]
- Updated dependencies [fd11d20]
- Updated dependencies [748e4f8]
- Updated dependencies [096e259]
- Updated dependencies [3fc6f2b]
- Updated dependencies [fd11d20]
- Updated dependencies [3418c55]
- Updated dependencies [fd11d20]
- Updated dependencies [d51dbb3]
- Updated dependencies [f267c2f]
- Updated dependencies [4a06057]
- Updated dependencies [f267c2f]
- Updated dependencies [1bfc1c1]
- Updated dependencies [f267c2f]
- Updated dependencies [f267c2f]
- Updated dependencies [1ef55ac]
- Updated dependencies [b227d22]
- Updated dependencies [05bbfdf]
- Updated dependencies [3fc6f2b]
- Updated dependencies [2c92243]
- Updated dependencies [f267c2f]
- Updated dependencies [b227d22]
- Updated dependencies [2c92243]
  - @velajs/vela@1.31.0
  - @velajs/feature-flags@1.31.0
  - @velajs/storage@1.31.0
  - @velajs/testing@1.31.0

## 1.30.0

### Minor Changes

- 44023fc: `@velajs/cloudflare` exports only the Cloudflare adapter and its platform pieces, so each framework API has one import path. It requires `@velajs/vela` with the tiered entry points and imports its seams from `@velajs/vela/module-kit`, `@velajs/vela/schedule` and the other feature subpaths.
  
  The package now publishes one JavaScript module per source file instead of shared chunks, so a bundler drops the features a Worker never imports. A shared chunk kept every decorated class it held, so a Worker that only calls `createCloudflareWorker()` shipped the storage module with the signed-URL crypto its controller uses, the KV and feature-flag drivers and the Durable Object host; it no longer does, which takes 6,975 bytes gzipped off that minimal Worker. Entry points, exports and type declarations are unchanged.
  
  **Behavior change:** the WebSocket gateway API is no longer re-exported from `@velajs/cloudflare`. Import it from `@velajs/vela/websocket`:
  
  | Old import | New import | Names |
  |---|---|---|
  | `@velajs/cloudflare` | `@velajs/vela/websocket` | `ConnectedSocket`, `MessageBody`, `OnGatewayConnection`, `OnGatewayDisconnect`, `OnGatewayInit`, `SubscribeMessage`, `UpgradeAuthenticator`, `WebSocketGateway`, `WebSocketServer`, `WebSocketUpgradeAuthenticationContext`, `WebSocketUpgradeIdentity`, `WsClient`, `WsException`, `WsMessage`, `WsResponse`, `WsServer` |

### Patch Changes

- Updated dependencies [4d0342b]
- Updated dependencies [4467619]
- Updated dependencies [7372d90]
- Updated dependencies [c101033]
- Updated dependencies [4d0342b]
  - @velajs/feature-flags@1.30.0
  - @velajs/vela@1.30.0

## 1.29.0

### Minor Changes

- 416650e: Cron triggers run core `@Cron()` jobs through `invokeScheduledJob`, the same primitive as the Node executor: the adapter runs every `@Cron` job whose expression is exactly the trigger string, in a fresh invocation scope, and the trigger settles after every matching job and its `EXECUTION_LIFETIME` work settle. Closing the application aborts the invocation signal of running jobs and waits for them.
  
  Add `CLOUDFLARE_SCHEDULED_EVENT`, a request-scoped token seeded into each job's invocation scope. Its `CloudflareScheduledEvent` value carries the trigger's `cron`, `scheduledTime` and a `noRetry()` already bound to the native controller. The token provides itself as request-scoped in every container, so a class that injects it is request-scoped wherever the module graph boots, including a `VelaWebSocketDurableObject`, `vela` CLI commands and `Test.createTestingModule()`, and is constructed per invocation instead of at bootstrap; resolving it outside a scheduled invocation throws. `ScheduledEvent` (the input of `scheduled()`) now also accepts the controller's optional `noRetry`.
  
  Signed `ScheduleModule` dispatch now works on Workers: the adapter's invocation transport re-enters the signed route, so its global guards run.
  
  The adapter reports schedule declarations a cron trigger cannot honor through the diagnostics policy: a `@Cron` without a dialect whose weekday field has digits or whose day fields are both restricted, `dialect: 'unix'`, `timeZone: 'local'`, `@Interval` jobs, which never run on Workers, and `@UseGuards`, `@UseInterceptors` or `@UseFilters` declared for a cron job. The default `'log'` mode warns once per declaration and never fails the first event; `'throw'` fails bootstrap. `vela deploy check` rejects the cron declarations and `@Interval` jobs before deployment (`ambiguous-cron-dialect`, `incompatible-cron-options`, `unsupported-interval`).
  
  The adapter provides `SCHEDULE_INVOCATION_SEED`: a cron job fired outside a trigger, such as by Studio's run-now, receives a synthetic `CLOUDFLARE_SCHEDULED_EVENT` whose `cron` is the job's expression, whose `scheduledTime` is the invocation's, and whose `noRetry()` does nothing.
  
  **Behavior change:** `@Scheduled` and `parseScheduledMetadata` are removed, along with the `ScheduledMetadata`, `ScheduledController`, `ScheduledContext` and `ScheduledHandler` types and the `cf:scheduled` and `cf:vela-cron` entrypoint kinds. Replace `@Scheduled(expr)` with `@Cron(expr, { dialect: 'cloudflare' })` from `@velajs/vela`. Cron jobs appear only as `schedule:cron` entrypoints.
  
  **Behavior change:** scheduled handlers receive only a `ScheduleInvocation` (`kind`, `expression` equal to the trigger string, `scheduledTime`, `signal`), identical to Node, instead of `(controller, env, ctx)`. Inject `ENV` for bindings, `CLOUDFLARE_SCHEDULED_EVENT` for `noRetry()`, and `EXECUTION_LIFETIME` for `waitUntil()`.
  
  **Behavior change:** scheduled jobs no longer run interceptors or filters declared with `@UseInterceptors` or `@UseFilters`, matching the Node executor. A job that declares `@UseGuards` on its class, method or module, whose guards the adapter used to run on each trigger, is now refused instead of running unguarded: the trigger fails, the job is never constructed, and the refusal is reported through the exception reporter (guards do not run for directly dispatched scheduled jobs — use `ScheduleModule.forRoot({ dispatch: { kind: 'signed', ... } })` or remove the guard). Other jobs on the same trigger still run. Queue consumers keep their guards, interceptors and filters. Use signed `ScheduleModule` dispatch to run a job through a route's request pipeline, or remove the guard.
  
  **Behavior change:** a `@Cron` job that declares `@UseGuards`, `@UseInterceptors` or `@UseFilters` on its class, method or module is reported through the diagnostics policy, because those components never run for scheduled jobs: the default `'log'` mode warns once and `'throw'` fails bootstrap. Move them to a signed `ScheduleModule` dispatch route.
- a3e2b38: The Cloudflare runtime seeds the native environment as the framework `ENV`, in the Worker and in every `VelaWebSocketDurableObject`, and types it with the environment `wrangler types` generates: the package augments `VelaEnv` with `Cloudflare.Env`, so `@InjectEnv() env: VelaEnv`, `inject: [ENV]` factories and `registerAs` factories see your bindings, variables and secrets typed. Run `wrangler types` (for example with `--include-runtime=false` alongside `@cloudflare/workers-types`) so `Cloudflare.Env` declares them. The per-environment application cache and the environment identity assertion are unchanged.
  
  `createCloudflareWorker` and `createCloudflareApp` accept `adapters: RuntimeAdapter[]`, composed after the Cloudflare adapter for each application, so a Worker entry can stay `export default createCloudflareWorker(AppModule, { adapters: [...] })` without a hand-written per-environment cache.
  
  **Behavior change:** the `envToken` option is removed from `createCloudflareWorker`, `createCloudflareApp`, `cloudflareAdapter`, `VelaWebSocketDurableObject` and `buildDoRuntime`, with no alias. Delete the application's environment `InjectionToken` and inject `ENV` from `@velajs/vela` instead: `createCloudflareWorker(AppModule)`, `VelaWebSocketDurableObject(AppModule)`, `cloudflareAdapter({ env })`. `CloudflareApplication` and `CloudflareRoot` are no longer generic; their environment type is `VelaEnv`.
  
  **Behavior change:** the `@Env()` parameter decorator is removed. Inject the environment with `@InjectEnv()` in a constructor, or read a binding in a factory with `inject: [ENV]`.
  
  **Behavior change:** ENV now carries every binding, variable and secret of the Worker, so framework readers pick up values such as `URL_SIGNING_SECRET` (URL and invocation signing) and `VELA_STUDIO_TOKEN` (Studio) automatically once they are set as variables or secrets. Values come from outside the program: validate each value your code reads before relying on it.
- 2ae8505: Add the `@velajs/cloudflare/queues` subpath with `cloudflareQueues()`, the Cloudflare Queues driver for `QueueModule`. Configure it once with `QueueModule.forRoot({ driver: cloudflareQueues() })` and register each queue where it is used with `QueueModule.registerQueue({ name: 'email', binding: 'EMAIL_QUEUE' })`. Each application gets its own driver, which reads the registered binding from that application's `ENV` when a job is added, checks that it has `send()`, and awaits the native send. `QueueClient.addBulk` uses `sendBatch`, split into calls of at most 100 messages and an estimated 256 KB; a job estimated over 128 KB is rejected before anything is sent, and a partial failure rejects with a `QueueBatchError` listing the accepted job ids.
  
  Native delivery needs no mapping: the Worker's `queue()` handler gives batches that no `@QueueConsumer` claims to `QueueModule`, which routes every job by its logical `queue`, so several registered queues can share one physical queue. Every job goes through the module's dispatch policy, so signed dispatch re-enters the signed route and runs its global guards. A message that is not a job envelope, belongs to an unregistered queue, or fails stays unacknowledged, so Cloudflare retries it and then dead-letters it. `registerQueue({ name, consumer })` pins the queue to that physical queue: its jobs are accepted only from it, and it carries only the queues pinned to it. Bootstrap rejects a physical queue claimed by both `@QueueConsumer` and a pinned registration. A raw `@QueueConsumer` owns its physical queue and must not carry jobs of queues registered with `QueueModule`, which `cloudflareQueues()` delivers: when it receives such job envelopes, which reach their `@Processor` only if the raw handler dispatches them itself, the adapter warns once per physical and logical queue unless diagnostics are silent; the raw consumer still receives and settles the batch.
  
  **Behavior change:** `cloudflareQueueDriver(bindings, { consumers, producerBindings })` and the `@velajs/cloudflare/queue` subpath are removed, together with the `CloudflareQueueBindings` and `CloudflareQueueDriverOptions` types. Replace `driver: cloudflareQueueDriver({ email: env.EMAIL_QUEUE }, { producerBindings: { email: 'EMAIL_QUEUE' } })` with `driver: cloudflareQueues()` plus `QueueModule.registerQueue({ name: 'email', binding: 'EMAIL_QUEUE' })`, and replace a `consumers: { 'email-production': 'email' }` mapping with `QueueModule.registerQueue({ name: 'email', consumer: 'email-production' })`, or with a plain `registerQueue({ name: 'email' })` when the physical queue needs no pin.
  
  **Behavior change:** `consumeQueueBatch` moves to `@velajs/cloudflare/queues`. It accepts every job envelope by default instead of requiring the job's queue to equal the batch's physical queue; its `queue` option is replaced by `queues`, the list of logical queues to accept.
  
  **Behavior change:** the driver publishes one `cf:queue:module` entrypoint per application with `{ consumers }` (the pinned physical queues) instead of one `{ queueName, logicalQueue }` entrypoint per mapping, and the `cf:queue:producer` entrypoint kind is removed: registered queues are published as `queue:registration` entrypoints by `QueueModule`.
  
  **Behavior change:** a failure on the native `QueueModule` path is reported once to the exception handler instead of once by its processor and again, with the whole batch rejection, by the adapter; a message that is not a job envelope or belongs to an unregistered queue is still reported once, individually.
- 8a3016c: **Behavior change:** Workers and Durable Objects are built from static roots only. `createCloudflareWorker`, `createCloudflareApp` and `VelaWebSocketDurableObject` take a module class or a `DynamicModule` declared at module scope; `CloudflareRoot` is now `Type | DynamicModule`. The `{ create(env) }` and async `{ create: async (env) => ... }` roots are removed, with no alias, together with the per-(root, environment) resolution cache. Read bindings where each application is built instead: `Module.forRootAsync({ inject: [ENV], useFactory: (env) => ({ ... }) })`, `useFactory` providers that inject `ENV`, or `@InjectEnv()` constructors. These run for each application, so nothing built from one environment is shared with another, and constructing another application or Durable Object instance declares no new classes in the isolate. The per-environment application cache of `createCloudflareWorker` is unchanged.
  
  WebSocket upgrade routes authenticate with the gateway's `authenticator`, resolved once per application from the module that declares the gateway, and read an `(env) => origins` allowlist from the Worker's `ENV`. Authentication still completes before the Durable Object id is derived, and client-supplied `x-vela-*` headers are still stripped first. `UpgradeAuthenticator`, `WebSocketUpgradeIdentity` and `WebSocketUpgradeAuthenticationContext` are re-exported from the package root.
  
  `WsGatewayRoute` gains an optional `moduleId`: the module that declares the gateway, from which its authenticator resolves.
- 864735d: **Behavior change:** a WebSocket Durable Object now refuses to start when its module registers the core `WebSocketModule` instead of `CloudflareWebSocketModule`. The core module's `WS_SERVER` broadcasts through its own sync driver, which never reaches the Durable Object's sockets, so `@WebSocketServer()` pushes were silently lost. Import `CloudflareWebSocketModule.forRoot()` in modules a `VelaWebSocketDurableObject` bootstraps.
  
  The Worker adapter now warns once per isolate when `LiveModule` runs the default `localLive()` driver in the Worker, whose invalidations never reach subscriptions held by the Durable Object. Pass `driver: () => durableObjectLive({ namespace, gatewayPath })`. The warning respects the `'silent'` diagnostics mode.

### Patch Changes

- a01273b: A queue batch that no consumer claims now rejects with guidance: the error names the physical queue, points to `@QueueConsumer(name)` or `QueueModule.forRoot({ driver: cloudflareQueues() })` with a `QueueModule.registerQueue()` for each queue the batch carries, and states that the unacknowledged batch is retried and then dead-lettered by Cloudflare.
- e4f2008: A Durable Object WebSocket whose `handleConnection` hook broadcasts to its room, for example `server.emit('system', { text: 'joined' })`, is now admitted. The broadcast reached the still-pending socket and rejected it, so every such upgrade failed with "Unable to persist authorized WebSocket state". Broadcasts now skip a socket while its connection hook runs and deliver to the room's active sockets; a pending socket that is not being admitted is still closed with 1008. When a socket is rejected while its hook runs, the error now says so.
- Updated dependencies [07d1713]
- Updated dependencies [db18d3a]
- Updated dependencies [07d1713]
- Updated dependencies [4071cb7]
- Updated dependencies [bacaacd]
- Updated dependencies [a814199]
- Updated dependencies [1838474]
- Updated dependencies [8a3016c]
- Updated dependencies [d803a49]
- Updated dependencies [b235935]
- Updated dependencies [08a81c8]
- Updated dependencies [5b5b81d]
- Updated dependencies [7daf4fc]
- Updated dependencies [35e8e0d]
- Updated dependencies [4420501]
- Updated dependencies [ff44b6a]
- Updated dependencies [6d4f0c0]
- Updated dependencies [e3bda2a]
- Updated dependencies [bd7e3c9]
- Updated dependencies [2b74880]
- Updated dependencies [5ba8635]
- Updated dependencies [db0c834]
- Updated dependencies [d6f6a65]
- Updated dependencies [8a3016c]
- Updated dependencies [d5a3ec8]
- Updated dependencies [0f7e8e7]
- Updated dependencies [41ec70d]
- Updated dependencies [b265297]
- Updated dependencies [bdfff47]
- Updated dependencies [28c7d07]
- Updated dependencies [8a3016c]
- Updated dependencies [44efdde]
  - @velajs/vela@1.29.0
  - @velajs/feature-flags@1.29.0

## 1.28.0

### Minor Changes

- Continue the module-based Workers APIs on the 1.x release line. Vela permits breaking changes in minor releases and does not retain compatibility layers. Upgrade the framework and integrations together for native queue dispatch, cron scheduling, RPC modules and asynchronous roots; see docs/module-workers.md.

### Patch Changes

- Updated dependencies
  - @velajs/feature-flags@1.28.0
  - @velajs/vela@1.28.0

## 3.0.0

### Major Changes

- Publish module-based Workers on the unused 3.x stable release line. Earlier experimental 2.0.0 registry versions are immutable and do not contain this release. Upgrade the framework and integrations together; see docs/module-workers.md for queue bootstrap, native delivery, RPC modules and async root migration details.

### Patch Changes

- Updated dependencies
  - @velajs/feature-flags@3.0.0
  - @velajs/vela@3.0.0

## 2.0.0

### Major Changes

- b99d71a: Compose native Worker applications through modules. QueueModule now initializes transport configuration at bootstrap and publishes driver-owned native routes, removing application-written consumer bridges. Duplicate queue ownership fails at startup. Cloudflare rejects deliveries without a consumer instead of silently accepting them; existing native decorators and envelopes remain supported.
  
  Cloudflare roots accept dynamic modules and asynchronous factories. RPC server modules and injectable named clients reuse the existing schema-validated dispatcher. Deployment checks validate module queue mappings, producer declarations and RPC service bindings. A four-worker example and exact-archive runtime proof cover composition, native delivery and scheduling.

### Patch Changes

- Updated dependencies [a2d2692]
- Updated dependencies [b99d71a]
  - @velajs/feature-flags@2.0.0
  - @velajs/vela@2.0.0

## 1.24.0

### Minor Changes

- efdf854: Add opt-in asynchronous response caching with explicit trusted partitions, bounded JSON replay, and generic scoped generation-based invalidation. Preserve the synchronous CacheService API and provide an independent optional KV invalidation adapter with documented eventual-consistency limits. Preserve absolute expiry during tier backfill and KV physical retention, and fence fills that race with visible invalidation.

### Patch Changes

- Updated dependencies [efdf854]
- Updated dependencies [4a6f5df]
  - @velajs/vela@1.26.0
  - @velajs/feature-flags@1.22.1

## 1.23.0

### Minor Changes

- a95951a: Add explicit Unix/Cloudflare cron dialects, UTC selection and validated schedule metadata for deployment introspection. Fix Sunday-ending ranges and numeric coercion, reject invalid timer delays, and provide native scheduled handler types while preserving exact Workers trigger matching and Node local-time defaults.
- 6b7cf23: Add Standard Schema job definitions with inferred producer input and validated processor output. Preserve original wire input across transport, await all processor outcomes, and offer opt-in strict unmatched routing. Add awaited Cloudflare producer and per-message consumer bridge helpers that validate envelopes, use native attempts, and preserve explicit ack/retry semantics.

  Preserve processor module ownership through discovery and dispatch, resolve scoped components asynchronously, and finish managed invocation work before settling delivery.
- 5205e58: Validate WebSocket correlation envelopes and hibernation attachments, preserve live baselines after refused sends, and add bounded connection-local send admission and incoming work. Existing void send APIs and unversioned 1.x attachments remain supported.

  Drop frames still waiting on Node connection setup after overload or close. Use browser-valid private close codes and reconnect after client-side send admission failures.

### Patch Changes

- 26fe8bf: Resolve queue and scheduled handlers and their pipeline components asynchronously
  in the owning module's child scope. Seed execution context ownership, defer
  handler construction until guards pass, track native waitUntil work through
  provider disposal, and await every matching handler before returning failures.

  Read validated WebSocket entrypoint metadata for upgrade routes so scoped gateways
  do not require a bootstrap instance; retain legacy forwarding metadata scanning.
- Updated dependencies [c6a43a6]
- Updated dependencies [bbe62d4]
- Updated dependencies [a6ef933]
- Updated dependencies [dae3654]
- Updated dependencies [77cca9e]
- Updated dependencies [b9f75f5]
- Updated dependencies [df47ea8]
- Updated dependencies [af019bf]
- Updated dependencies [6df1059]
- Updated dependencies [bdd90a1]
- Updated dependencies [8a3923f]
- Updated dependencies [c7d108b]
- Updated dependencies [1c7f635]
- Updated dependencies [636ffbc]
- Updated dependencies [54f8864]
- Updated dependencies [f49db45]
- Updated dependencies [4fde903]
- Updated dependencies [6a1b5b3]
- Updated dependencies [a95951a]
- Updated dependencies [9e82187]
- Updated dependencies [c5a3cb0]
- Updated dependencies [363fb71]
- Updated dependencies [de4e57e]
- Updated dependencies [0765aaa]
- Updated dependencies [6b7cf23]
- Updated dependencies [5205e58]
- Updated dependencies [ae45689]
  - @velajs/vela@1.25.0
  - @velajs/feature-flags@1.22.1

## 1.22.1

### Patch Changes

- Publish from the public velajs/vela repository through GitHub Actions OIDC with required signed npm provenance. Attestations identify the source commit and release workflow for each package.
- Updated dependencies
  - @velajs/feature-flags@1.22.1
  - @velajs/vela@1.22.1

## 1.22.0

### Minor Changes

- Continue the coordinated framework release on the 1.x line with the current checked provider, endpoint, identity, CRUD, live, and Studio APIs. Breaking API changes are accepted during this development phase; maintained applications use the current contracts.
- Publish from the pnpm packages workspace with TypeScript 7 and GitHub OIDC. Obsolete standalone examples have been removed; runnable applications live in apps/.
- Updated workspace dependencies
  - @velajs/feature-flags@1.22.0
  - @velajs/vela@1.22.0

## 2.0.1

### Patch Changes

- Publish from the unified packages workspace with corrected repository paths, shared native tooling, TypeScript 7 checks, and npm OIDC releases. Runnable examples now live in apps/.
- Updated dependencies
  - @velajs/vela@2.0.1
  - @velajs/feature-flags@2.0.1

## 2.0.0

Native binding tokens, per-environment application lifetime, environment-created module graphs, isolated live drivers, and Durable Object live inspection. Includes a complete D1/auth/CRUD/live/Studio starter.

Requires the coordinated Vela 2.0 package set. See the workspace migration guide.

## 1.10.1

### Patch Changes

- 6f04d15: Modernize the package build, validation, and release toolchain.

## 1.7.0 (2026-07-04)

- `cloudflareAdapter()` exported (createCloudflareApp composes vela RuntimeAdapter); `@QueueConsumer`/`@Scheduled` declare open entrypoint kinds; queue/scheduled dispatch runs per-event in a request scope through PipelineRunner (consumer-scoped guards/interceptors/filters; request-scoped deps rebuild per batch); DO WebSocket reads `app.entrypoints`. Requires `@velajs/vela >=1.11.0`.

## 1.6.0 (2026-07-01)

### Added

- **Multi-disk `StorageModule` over R2** (`StorageService.put/get/delete/exists/url`, per-disk templated roots, bucket-by-name via `EnvService`, `R2StorageDriver`) + a signature-gated `StorageController` presign-proxy.
- **`KVCacheStore`** implementing vela's `AsyncCacheStore` — pair with `TieredCacheStore` for a memory→KV cache.
- WebSocket transport for vela's WebSocket gateways (Durable Object backed).

### Fixed

- **Multiple same-type bindings** (e.g. two `KVModule.forRoot` with different bindings) now all initialize — `collectBindingRefs` enumerates every binding ref across module buckets instead of resolving each token once.

## 0.2.0 (2026-04-28)

### Breaking changes

- **`CloudflareFactory` renamed to `createCloudflareApp`.** The factory object exposed exactly one method (`.create`) and was a thin wrapper around `VelaFactory`. Replaced with a plain async function:

  ```ts
  // before
  import { CloudflareFactory } from "@velajs/cloudflare";
  const app = await CloudflareFactory.create(AppModule);

  // after
  import { createCloudflareApp } from "@velajs/cloudflare";
  const app = await createCloudflareApp(AppModule);
  ```

### New

- `CloudflareApplication.scheduled()` now also dispatches `@Cron('expr')` jobs from `@velajs/vela`. Use either the cloudflare-specific `@Scheduled()` decorator or the framework's `@Cron()` decorator — both are matched against the incoming cron event.

### Compatibility

- Requires `@velajs/vela` ≥ 1.0.0 for the `@Cron` integration. The schedule split in vela 0.10 makes its `ScheduleModule` metadata-only, which lets edge platforms drive cron via their native triggers.

## 0.1.0 (2026-04-13)

Initial release.
