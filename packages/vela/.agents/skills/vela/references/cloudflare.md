# Cloudflare Workers

Use native platform bindings through the framework `ENV`, typed by `wrangler types`. `@velajs/cloudflare` supplies HTTP, queue, cron, and live transports; its root entrypoint is safe for Node tooling. Native classes live in feature subpaths: Durable Objects in `@velajs/cloudflare/durable-objects`, Workflows in `@velajs/cloudflare/workflows`, service entrypoints in `@velajs/cloudflare/entrypoints`; `@OnEmail()` and `@OnTail()` come from `@velajs/cloudflare/email` and `@velajs/cloudflare/tail`.

## Worker and environment

```ts
import { InjectEnv, Injectable, Module, type VelaEnv } from '@velajs/vela';
import { createCloudflareWorker } from '@velajs/cloudflare';

@Injectable()
class UsersService {
  constructor(@InjectEnv() private readonly env: VelaEnv) {}
  find(id: string) {
    return this.env.DB.prepare('select * from users where id = ?').bind(id).first();
  }
}

@Module({ providers: [UsersService] })
class AppModule {}
export default createCloudflareWorker(AppModule);
```

`ENV` (`InjectionToken<VelaEnv>` from `@velajs/vela`) is the native environment; the Worker entry only exports. Type it with `wrangler types --include-runtime=false` (keep `@cloudflare/workers-types` for runtime types): include the generated `worker-configuration.d.ts` in tsconfig and regenerate it when the Wrangler file changes; `@velajs/cloudflare` extends `VelaEnv` with its `Cloudflare.Env`. Do not hand-write an `Env` interface or mint an environment `InjectionToken`. Inject `ENV` directly (`@InjectEnv()`, `inject: [ENV]`) or derive a narrower binding token with `defineProvider(TOKEN, { inject: [ENV], useFactory: env => env.DB })`. There is no environment parameter decorator; binding wrapper modules/services are not part of the API. Secrets in `ENV` drive framework features automatically: `URL_SIGNING_SECRET` (signed URLs and invocations) and `VELA_STUDIO_TOKEN` (Studio).

The root is static: a module class, or a `DynamicModule` such as `AppModule.forRoot(...)`, declared once at module scope and passed as-is to `defineCloudflareApp`, `createCloudflareWorker`, `createCloudflareApp`, `VelaDurableObject` and `VelaWebSocketDurableObject`. There is no environment-factory root (`{ create(env) }`) and nothing is decorated inside a function. Read bindings in `forRootAsync({ inject: [ENV], useFactory })` factories, `useFactory` providers and `@InjectEnv()` constructors; they run for each application, so a second environment builds new instances but declares no new classes.

The worker exposes `fetch`, `queue`, and `scheduled` (plus `email`/`tail` once a module imports `@OnEmail()`/`@OnTail()`), and a descriptor under the symbol key `CLOUDFLARE_WORKER` (`Symbol.for('vela.cloudflare.worker')`: `rootModule`, `options`, `durableObjects`, `workflows` and `entrypoints` (the classes defined from the same app), `createOptions(env)`, `createApplication(env)`) that `@velajs/cli` and `@velajs/cloudflare/testing` build the same application from. It is enumerable, so an entry that adds handlers by spreading (`export default { ...worker, email }`) or `Object.assign` keeps it. Applications are cached by environment object identity; concurrent first events share bootstrap, different environments get separate applications, and failed bootstrap retries on the next event. For explicit construction use `createCloudflareApp(AppModule, { env })` or `cloudflareAdapter({ env })`; `adapters: RuntimeAdapter[]` on either entry composes further adapters. There is no `middleware(env)` option: request middleware is a consumer middleware class (`configure(consumer)` in a module) that injects `ENV` like any provider. `createCloudflareWorker(AppModule, { configure(app, env) {} })` finishes each application's HTTP surface (extra Hono routes) once per environment, synchronously and without I/O, before any event, including concurrent cold events, reaches it; a throw fails that construction and the next event retries. `createTestingWorker()` runs the same `configure`; the descriptor's `createApplication(env)` builds the application without it. Bindings exist before DI factories run; binding I/O still belongs inside a platform event. An explicitly constructed app rejects events from another environment. Separate Workers sharing one repository type-check as separate programs, each with its own `wrangler types` output.

## Queue and cron handlers

Register `@Injectable()` providers with `@QueueConsumer('queue-name')`, and schedule work with core `@Cron(expression, { dialect: 'cloudflare' })`: a cron trigger runs every `@Cron` job whose expression is exactly the trigger string (declare the same string under Wrangler `triggers.crons`). There is no Cloudflare-only cron decorator. A job receives only its `CronInvocation` (`expression`, `scheduledTime`, `signal`), as on Node; inject `CLOUDFLARE_SCHEDULED_EVENT` (from `@velajs/cloudflare`; it provides itself as request-scoped in every container, so the injecting class is request-scoped in the Worker, a Durable Object, the CLI and testing alike) for the trigger's bound `noRetry()`, and use `EXECUTION_LIFETIME.waitUntil()` for background work. Outside a trigger (Studio's run-now) the adapter's `SCHEDULE_INVOCATION_SEED` seeds a synthetic event whose `noRetry()` does nothing. Scheduled jobs run no guards/interceptors/filters; `ScheduleModule.forRoot({ dispatch: { kind: 'signed', target } })` re-enters a signed route with its global guards instead. The adapter warns once (throws in `diagnostics: 'throw'`) about a cron without a dialect whose weekday field has digits or whose day fields are both restricted, `dialect: 'unix'`, `timeZone: 'local'`, `@Interval` jobs, which never run on Workers, and `@UseGuards`/`@UseInterceptors`/`@UseFilters` on a cron job; a direct cron job that declares guards is refused on every trigger (fail closed) and `vela deploy check` fails with `scheduled-job-guards`. Parse `MessageBatch<unknown>` bodies before reading application fields. Each queue dispatch uses a fresh scope and its declared guards/interceptors/filters; unhandled errors reach the platform for retry. These cold entrypoints receive the same native bindings as HTTP.

For portable jobs, use `QueueModule.forRoot({ driver: cloudflareQueues() })` (from `@velajs/cloudflare/queues`) with `QueueModule.registerQueue({ name, binding })` and `@InjectQueue(name)`: the driver reads the producer binding from `ENV` per send, `addBulk` uses chunked `sendBatch`, and batches no `@QueueConsumer` claims are routed to `@Processor`s by each job's logical queue. See `queues.md`.

## Durable Objects and live queries

```ts
import { Module } from '@velajs/vela';
import { LiveModule } from '@velajs/vela/live';
import { WebSocketModule } from '@velajs/vela/websocket';
import { defineCloudflareApp } from '@velajs/cloudflare';
import { VelaWebSocketDurableObject } from '@velajs/cloudflare/durable-objects';

// RoomsGateway: @WebSocketGateway({ path: '/rooms/:room/ws', roomParam: 'room', binding: 'ROOMS', ... })
@Module({
  imports: [WebSocketModule.forRoot(), LiveModule.forRoot()],
  providers: [RoomsGateway, TodoLive],
})
class RoomModule {}
const app = defineCloudflareApp(RoomModule);
export class Room extends VelaWebSocketDurableObject(app) {}
export default app.worker;
```

Import the core modules on every runtime; there is no Cloudflare WebSocket module. `cloudflareAdapter` registers the platform as the global `WS_TRANSPORT` and `LIVE_PLATFORM` tokens before modules load and never replaces module providers. In the Worker, `WebSocketModule` serves an upgrade route for every gateway naming a `binding` (authenticating before the Durable Object is derived) and forwards it to the gateway + room Durable Object; without `WebSocketModule` no upgrade route mounts (upgrades answer 404) and the adapter reports each binding-backed gateway. The Worker's `@WebSocketServer()` throws on push; `Gateways.of(Gateway).to(room).emit()` calls the gateway + room Durable Object's `broadcast` RPC, and inside a Durable Object pushes to its own room locally and forwards other rooms. `LiveInspector` (and Studio's `livePanel({ rooms })`) reads a room through the same binding with its `inspectLive` RPC. `LiveModule` defaults to `durableObjectLive()`: Worker invalidations go to the room Durable Object of the single binding-backed gateway, its namespace read from `ENV` when first needed; with several, the first invalidation fails with an ambiguity error, so pass `driver: () => durableObjectLive({ gatewayPath })` (or `{ binding }`, `defaultRoom`). A gateway without `roomParam` has one room Durable Object, named by its path, and its invalidations and inspections always go there. Inside the Durable Object, the server broadcasts to its hibernatable sockets, invalidations apply locally, and the cursor log is a SQLite `DoCursorLog` (in memory without `new_sqlite_classes`). A Worker configured with `localLive()` warns once. Import native classes only in Worker entry files. Configure the namespace and `new_sqlite_classes` migration in Wrangler. Gateway options declare `path`, `roomParam`, `binding`, `allowedOrigins` (origins or `(env) => origins`) and `authenticator`, an `UpgradeAuthenticator` class each application resolves through DI from the declaring module (`websocket.md`); a gateway without one refuses every upgrade. Core trusted identity, tenant, and expiry cross the upgrade boundary; caller-supplied identity headers are not authority. Driver/log factories return fresh state per application. Read `live-queries.md` for shared query schemas and delivery authorization.

## Durable Object hosts

```ts
import { Inject, Injectable, UseGuards } from '@velajs/vela';
import { defineCloudflareApp } from '@velajs/cloudflare';
import { DO_STORAGE, VelaDurableObject } from '@velajs/cloudflare/durable-objects';

@Injectable()
export class CounterHost {
  constructor(@Inject(DO_STORAGE) private readonly storage: DurableObjectStorage) {}
  async increment(by: number): Promise<number> {
    const value = ((await this.storage.get<number>('value')) ?? 0) + by;
    await this.storage.put('value', value);
    return value;
  }
  @UseGuards(CallerGuard)
  async reset(): Promise<void> {
    await this.storage.deleteAll();
  }
}

const app = defineCloudflareApp(AppModule); // one definition: Worker + Durable Object classes
export class Counter extends VelaDurableObject(app, CounterHost, { rpc: ['increment', 'reset'] }) {}
export default app.worker;
// Elsewhere, with wrangler types: COUNTER is DurableObjectNamespace<Counter>
// await env.COUNTER.getByName('orders').increment(1)  // typed: (by: number) => Promise<number>
```

`VelaDurableObject(appOrRoot, Host, { rpc })` returns a class whose instances each boot one application context (`VelaFactory.createApplicationContext`) in the constructor under `blockConcurrencyWhile`, with `Host` added to the root module's providers (never list the host in a module the Worker builds). The app form shares the root and its runtime adapters (`configureContainer`) with the Worker; a bare root works too. Declare the class in the module that defines the app (a separate file importing the app from the Worker entry hits a circular-import TDZ): keep it in the entry, or define the app in its own module (`src/app.ts`) that the entry and the class files import. The context injects `ENV`, `DO_STATE` (`DurableObjectState`), `DO_STORAGE` and `DO_ID`, and reaches gateway rooms and live invalidation like the Worker. Only the host methods `rpc` names become JS-RPC methods, and the stub type exposes exactly those; unlisted public methods, TypeScript `private`/`protected` helpers, lifecycle hooks and `dispose()` are unreachable over RPC, even from plain JS. `rpc` is typed to the host's public methods; at class definition each name must be a prototype method (not an accessor or an arrow-function field), and hooks (`onModuleInit`..., `dispose`, `collectEntrypoints`), event handlers and `ctx`, `env`, `connect`, `dup`, `id`, `name`, `then` are rejected, as is a host whose prototype defines `then()` (a thenable instance would hang DI resolution). Without `rpc`, the object serves only its handlers. Host `fetch`, `alarm`, `webSocketMessage/Close/Error` become the object's handlers (no host `alarm`, no alarm handler). Each call/event runs in a fresh execution scope (request-scoped providers per call; `EXECUTION_LIFETIME` work settles before it returns; a streamed `fetch()` body keeps the scope open until it is sent) through the host's scoped guards, pipes (RPC arguments only, `{ type: 'custom' }`), interceptors and filters; `APP_*` components do not apply. `ExecutionContext.getType()` is `'rpc'`, `'cf:do:fetch'`, `'cf:do:alarm'` or `'cf:do:websocket'`; `getPayload()` is the arguments. Failures are reported first (`edge: 'durable-object'`); an RPC call rejects only with `EntrypointError` from `@velajs/cloudflare` (`status`, `code`, `message`, `details` for 4xx; everything else `500 internal "Internal Server Error"`, stack-free), recognized on the caller side with `isEntrypointError()` (needs `compatibility_date` >= 2026-04-21 or the `enhanced_error_serialization` flag; older dates deliver a plain `Error` without status/code, and `vela deploy check` warns with `rpc-error-serialization`); `fetch` renders the JSON error body; alarms/WebSocket events rethrow for the platform. A claiming filter's non-undefined value becomes an RPC result; for alarms it handles the failure. A context that fails to start resets the object and callers get only the redacted 500. Shutdown hooks do not run on eviction. `VelaWebSocketDurableObject(app)` boots its context the same way. See `docs/durable-objects.md`.

## Workflows, service entrypoints, email and tail

These run in the Worker's own application for the event's environment (the one `app.worker` uses), with their hosts added to the root module's providers; they take the app from `defineCloudflareApp` (a bare root is rejected) and must be declared at module scope before the first event.

- `VelaWorkflow(app, Host)` (`@velajs/cloudflare/workflows`) returns a `WorkflowEntrypoint`; each run calls `Host.run(event, step)` with the engine's own `event`/`step` (untouched: `step.do`/`sleep`/`waitForEvent` keep retry and replay semantics) in a fresh execution scope through the host's scoped guards/interceptors/filters (`getType()` `'cf:workflow'`, `getPayload()` the event; no pipes). The engine may call `run()` again per instance (replay): each call is a new run, so keep side effects inside `step.do`. Failures are reported (`edge: 'workflow'`) and rethrown as-is (`NonRetryableError` ends the instance); a claiming filter settles the run with its value. The engine's interruptions (an `Error('Aborting engine: ...')` a step rejects with on pause/restart/terminate) pass through unreported and unfiltered; interceptors that catch errors must rethrow them. `wrangler types` types the binding from the exported class's `run`; `workflow<WorkflowParams<typeof SignupWorkflow>>({ binding })` from the root entry is the typed binding reference.
- `VelaEntrypoint(app, Host, { rpc })` (`@velajs/cloudflare/entrypoints`) returns a `WorkerEntrypoint` whose JS-RPC methods are exactly the host methods `rpc` names (typed on `Service<typeof Billing>`); `ctx`, `env`, `dup`, `then`, hooks and the `WorkerEntrypoint` handlers (`fetch`, `connect`, `email`, `queue`, `scheduled`, `tail`, ...) are rejected. Each call runs through scoped guards, pipes, interceptors and filters (`getType()` `'rpc'`), with the caller's `ctx.props` injectable as request-scoped `ENTRYPOINT_PROPS` (validate it; `{}` without props). Failures are reported (`edge: 'rpc'`) and reject only with `EntrypointError`. RPC results must be serializable types or the stub types them `never`.
- `@OnEmail({ to? })` (`@velajs/cloudflare/email`) on a provider method receives the native `ForwardableEmailMessage` (entrypoint kind `cf:email`): handlers whose `to` lists the envelope recipient run, else those without `to`; a message no handler accepts is rejected with `setReject(UNCLAIMED_EMAIL_REASON)`. Failures are reported (`edge: 'email'`) and rethrown unless a filter handles them. `readInboundEmail(message)` from `@velajs/mail` parses it into an `InboundEmail` (unverified authentication by default).
- `@OnTail()` (`@velajs/cloudflare/tail`) receives `TraceItem[]` (kind `cf:tail`); every handler runs; failures are reported (`edge: 'tail'`) and never thrown; an application that fails to start is logged to the console and the handler still resolves.
- Test with `createTestingWorker()`'s `email(message)`/`tail(events)`, the `emailMessage()` and `traceItem()` fixtures from `@velajs/cloudflare/testing`, and `introspectWorkflowInstance()` from `cloudflare:test`. See `docs/workflows.md` and `docs/entrypoints.md`.

## Bindings by name: storage, caches, and flags

Module options name bindings; they never hold them. `kv`, `r2`, `d1`, `queue`, `durableObject`, `rateLimit` and `workflow` from `@velajs/cloudflare` take `{ binding }` (the Wrangler name), read nothing when declared, and resolve + validate the native binding from an application's `ENV` when called; a missing one fails naming the binding and its Wrangler key (`… under kv_namespaces`). They are built on `defineBinding`/`resolveBinding` from `@velajs/vela/module-kit`. Keep references at module scope; never read `env` there.

- Storage: `StorageModule` from `@velajs/storage` is the only storage module. `StorageModule.forRoot({ driver: r2Storage({ binding: 'FILES' }) })` with `r2Storage` from `@velajs/cloudflare/storage`; the bucket is read on the first storage operation of each application.
- Caches: `CacheModule.forRoot({ namespace, scope, store: kvCache({ binding: 'CACHE' }), invalidation: kvCacheInvalidation({ binding: 'CACHE_GENERATIONS' }) })` (a separate non-expiring namespace for generations). KV logical TTL is preserved in metadata; distributed invalidation remains eventually consistent. `store: (env) => new TieredCacheStore([...])` composes tiers per application.
- Rate limiting: `ThrottlerModule.forRoot({ throttlers, storage: rateLimitStore({ binding: 'API_LIMITER' }) })` (see `errors-and-health.md`).
- Flags: `kvFlagDriver(env.CACHE, options)` and `flagshipFlagDriver(nativeBinding, options)`. Cache/object flag values remain unknown until parsed.

The `@velajs/vela` root entry imports `hono/context-storage` (`node:async_hooks`) whether or not ambient access is used. `nodejs_compat` provides it and is default-on from compatibility date 2026-08-04; with an earlier date add `nodejs_als` (or `nodejs_compat`). Vela's Cloudflare and Durable Object transports need no other Node.js APIs; add `nodejs_compat` only for dependencies that import other `node:*` modules. Ambient container access is optional; per-request DI works without ambient state. On Workers stamp live commit headers explicitly instead of relying on ALS across DO RPC. See the Cloudflare package README and `apps/live-todo` for the complete deployed wiring.
