# @velajs/cloudflare

Nest-style modules, dependency injection, controllers, queue consumers, cron triggers,
and live WebSockets on Cloudflare Workers. HTTP routing uses Hono. Bindings use the
platform's native types.

The [native composition example](../../apps/cloudflare-composition/README.md)
combines request-scoped `ENV` injection with Browser Run Quick Actions, Workers AI
and AI Gateway, VPC through `HttpService`, and authorized R2-to-WebP Images transforms.
It keeps destination/model policy on the server, bounds I/O and cancellation, and
separates local emulation from opt-in live acceptance without additional packages.

## Native environment and application lifetime

The Worker's native environment is the framework `ENV` from `@velajs/vela`.
`createCloudflareWorker` seeds it for each environment before any provider is
constructed, so the Worker entry only exports. Inject it wherever bindings or
secrets are needed, including async provider factories (`inject: [ENV]`).

Types come from Wrangler. Run `wrangler types --include-runtime=false` (runtime
types stay with `@cloudflare/workers-types`) and include the generated
`worker-configuration.d.ts` in your tsconfig. It declares `Cloudflare.Env` from
the bindings and variables in your Wrangler file and the secret names in
`.dev.vars`; this package extends `VelaEnv` with it, so `ENV`, `forRootAsync`
factories and `registerAs` factories are typed without a hand-written interface.
Regenerate it whenever the Wrangler file changes.

```ts
import { Controller, Get, InjectEnv, Module, type VelaEnv } from '@velajs/vela';
import { createCloudflareWorker } from '@velajs/cloudflare';

@Controller('/status')
class StatusController {
  // CACHE is a KVNamespace in worker-configuration.d.ts.
  constructor(@InjectEnv() private readonly env: VelaEnv) {}

  @Get()
  async status() {
    return { message: await this.env.CACHE.get('status') };
  }
}

@Module({ controllers: [StatusController] })
class AppModule {}

export default createCloudflareWorker(AppModule);
```

The worker exposes `fetch`, `queue`, and `scheduled`, plus `email` and `tail`
once a module imports `@OnEmail()` or `@OnTail()` (see
[Service entrypoints, email and tail](#service-entrypoints-email-and-tail)), and carries a
descriptor under the symbol key `CLOUDFLARE_WORKER`
(`Symbol.for('vela.cloudflare.worker')`), which the platform ignores and which
an entry adding handlers keeps (`export default { ...worker, email }`): the
root module, the options, the Durable Object, Workflow and service entrypoint
classes defined from the same app (each class also carries its descriptor
under `CLOUDFLARE_DURABLE_OBJECT`, `CLOUDFLARE_WORKFLOW` or
`CLOUDFLARE_ENTRYPOINT`), and
`createOptions(env)`/`createApplication(env)`, which build the application
exactly as the Worker does, short of the `configure(app, env)` hook, which
receives the Workers application. `@velajs/cli` loads the Worker entry and builds its
application from it, so a project needs no `vela.config`, and
`@velajs/cloudflare/testing` builds test applications from the same options.
Its first event builds an application with that event's environment. Concurrent events for the same
environment object share construction. Different environment objects receive
separate applications, including separate providers, lifecycle state, and live
drivers. A failed construction is evicted and the next event retries.

The root is static: a module class, or a `DynamicModule` such as
`AppModule.forRoot(...)`, declared once at module scope. `createCloudflareWorker`,
`createCloudflareApp`, `VelaDurableObject` and `VelaWebSocketDurableObject` all
take the same root. An entry that exports Durable Object classes defines the app
once with `defineCloudflareApp(AppModule, options)`: its `worker` is the default
export, and the classes built from the app share its root, and its runtime
adapters configure their containers (`configureContainer`) (see [Durable Object hosts](#durable-object-hosts)); `createCloudflareWorker` is
`defineCloudflareApp(...).worker`.
When module configuration needs bindings, read them where each application is
built, from its own `ENV`:

```ts
import { ENV, Module } from '@velajs/vela';

@Module({
  imports: [
    DatabaseModule.forRootAsync({
      inject: [ENV],
      useFactory: (env) => ({ database: env.DB }),
    }),
  ],
})
class AppModule {}
```

`forRootAsync` factories, `useFactory` providers, `@InjectEnv()` constructors and
queue driver factories such as `cloudflareQueues()` run for each application, so
nothing built from one environment is shared with another. Because the root never
changes, building another application or Durable Object instance declares no new
classes in the isolate. See the
[complete API starter](../../apps/api-starter/README.md) for D1, Better Auth, CRUD,
the generated Hono client, live updates, and Studio inspection in one application.

The application cache uses weak object keys, so the cache itself does not keep a
replaced environment alive. Build secret-bearing values in `forRootAsync`
factories that inject `ENV` rather than capturing them in module options.
Providers with request scope still rebuild per HTTP request or queue/cron dispatch.
Do not retain request objects or authentication state in singleton providers.

Request middleware belongs in modules: a consumer middleware class resolves
through dependency injection, so it can inject `ENV` like any provider.

```ts
import {
  InjectEnv,
  Injectable,
  Module,
  type MiddlewareConsumer,
  type NestMiddleware,
  type NestModule,
  type VelaContext,
  type VelaEnv,
} from '@velajs/vela';

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
```

`createCloudflareWorker(AppModule, { configure })` finishes each application's
HTTP surface, for example with extra Hono routes, once per environment. It runs
after the application is built and before any event reaches it, including
concurrent cold events; a throw fails that construction and the next event
retries. It must be synchronous and do no I/O (a returned promise fails the
construction):

```ts
export default createCloudflareWorker(AppModule, {
  configure(app, env) {
    app.getHonoApp().get('/version', (c) => c.text(env.SERVICE_VERSION));
  },
});
```

Enable CORS as in Nest, with the `cors` option or `app.enableCors()` inside
`configure`; Hono's `cors` middleware then answers preflights ahead of every
route and guard:

```ts
export default createCloudflareWorker(AppModule, { cors: { origin: ['https://app.example.com'] } });
```

For explicit construction inside a platform event:

```ts
const app = await createCloudflareApp(AppModule, { env, globalPrefix: '/api' });
const bindings = app.get(ENV); // VelaEnv
return app.fetch(request, env, executionContext);
```

`env` is registered as `ENV` before provider factories and lifecycle hooks.
Referencing a binding is safe during construction; platform I/O must still
happen inside a Workers event or Durable Object context. An explicitly built
application rejects requests or events carrying another environment object,
including calls through the underlying Hono app. Internal `ctx.run` reentry
retains the application's environment.

`cloudflareAdapter({ env })` provides the same bootstrap and request contract
when composing `VelaFactory.create` directly. `createCloudflareWorker` and
`createCloudflareApp` accept `adapters: RuntimeAdapter[]`, composed after the
Cloudflare adapter for each application, so the Worker entry needs no
hand-written per-environment cache for them.

Because `ENV` carries every binding, variable and secret, framework features
read their secrets from it without extra wiring: a string `URL_SIGNING_SECRET`
signs URLs and invocations when no explicit secret is configured, and Studio
reads `VELA_STUDIO_TOKEN` and its `VELA_STUDIO_*_EDITABLE` flags. Set them with
`wrangler secret put`. Values come from outside the program, so validate each
value your own code reads before relying on it.

## Module-based queues, cron and RPC

`QueueModule` from `@velajs/vela/queue` is the Workers queue API. Configure the
driver once in the root module and register each queue where it is used:

```ts
import { Injectable, Module } from '@velajs/vela';
import {
  InjectQueue,
  Process,
  Processor,
  QueueModule,
  defineQueueJob,
  type QueueClient,
  type QueueJob,
} from '@velajs/vela/queue';
import { cloudflareQueues } from '@velajs/cloudflare/queues';
import { z } from 'zod';

const welcome = defineQueueJob('welcome', z.object({ userId: z.string() }));

@Injectable()
class Signup {
  constructor(@InjectQueue('email') private readonly email: QueueClient) {}
  invite(userId: string) {
    return this.email.add(welcome, { userId });
  }
}

@Processor('email')
class EmailProcessor {
  @Process(welcome)
  send(job: QueueJob<{ userId: string }>) {}
}

@Module({
  imports: [QueueModule.forFeature([{ name: 'email', binding: 'EMAIL_QUEUE' }])],
  providers: [Signup, EmailProcessor],
})
class EmailModule {}

@Module({ imports: [QueueModule.forRoot({ driver: cloudflareQueues() }), EmailModule] })
class AppModule {}
```

`binding` names a Wrangler `queues.producers[].binding`. The driver reads it
from the application's `ENV` when a job is added and awaits the native send.
`addBulk` uses `sendBatch`, split into calls of at most 100 messages and an
estimated 256 KB, and rejects a job estimated over 128 KB before sending
anything. A partial failure rejects with a `QueueBatchError` whose `accepted`
lists the job ids already sent.

The Worker's `queue()` handler gives each batch to the `@QueueConsumer` handlers
of its physical queue. Batches no `@QueueConsumer` claims go to `QueueModule`,
which routes every job by its logical queue, so several registered queues may
share one physical queue. Each job runs through the module's dispatch policy,
including signed dispatch and its global guards. A message is acknowledged
after its processors succeed; a message that is not a job envelope, belongs to
an unregistered queue, or fails stays unacknowledged, so Cloudflare retries it
and then dead-letters it. `forFeature({ name, consumer: 'email-production' })`
pins the queue to that physical queue: its jobs are accepted only from it, and
it carries only the queues pinned to it. A physical queue cannot be both a
`@QueueConsumer` queue and a pinned consumer. A `@QueueConsumer` owns its
physical queue and must not carry jobs of registered queues: those reach their
`@Processor` only if the raw handler dispatches them itself, so the adapter
warns once when it sees them. Registered queues are delivered by
`cloudflareQueues()`. `dispatchQueueJob` is for tests and for transports other
than Cloudflare Queues; it applies the module's dispatch policy, signed dispatch
included.

Use `ScheduleModule.forRoot()` and `@Cron()` for native scheduled work. The
[queue guide](../../docs/queues.md) and [module guide](../../docs/module-workers.md)
cover producer-only and consumer-only Workers, RPC modules and deployment
checks. `@QueueConsumer` remains available for raw batches.

## Managed queue and cron work

Each matching `@QueueConsumer` handler receives its batch and environment, plus
a context whose `waitUntil(promise)` delegates to the platform and retains that
handler's DI scope until the promise settles. Class/method guards, interceptors
and filters resolve asynchronously from the handler's declaring module. The
execution context exposes that same child via `getContainer()` and its owner via
`getModuleId()`; `REQUEST_CONTEXT` remains HTTP-only.

A `@Cron` job receives only its `CronInvocation`, with no environment or
context argument, and runs no guards, interceptors or filters: the adapter warns
once (fails bootstrap in `diagnostics: 'throw'`) when a job declares
`@UseGuards`, `@UseInterceptors` or `@UseFilters`, and a job that declares
guards is refused on every trigger instead of running unguarded. Use signed
`ScheduleModule` dispatch to run a job through a route's request pipeline, and
inject `ENV`, `CLOUDFLARE_SCHEDULED_EVENT` and `EXECUTION_LIFETIME` for what the
native handler arguments used to carry.

In both, inject `EXECUTION_LIFETIME` from `@velajs/vela` to schedule deferred
callbacks with `lifetime.defer(work)` or register already-started work with
`lifetime.waitUntil(promise)`. The handler, managed work and asynchronous provider
disposal finish before queue/cron dispatch returns. Unclaimed failures reject
for the platform to observe; they are not silently converted into success. When
several handlers match, every handler settles before a single failure or
`AggregateError` is returned. Background failure does not undo completed writes;
handlers still need the idempotency appropriate to their delivery semantics.

See [execution scopes](../../docs/execution-scopes.md) for lifetime ownership,
stream boundaries, cancellation and optional transport integration.

## Native handler tracing

Import `CloudflareTracingInterceptor` from the optional
`@velajs/cloudflare/tracing` entrypoint and register it on HTTP controllers or
`VelaEntrypoint` hosts with `@UseInterceptors`. It uses the native
`cloudflare:workers` tracing API; the package root does not import it.

```ts
import { Controller, Get, Injectable, Module, UseInterceptors } from '@velajs/vela';
import { defineCloudflareApp } from '@velajs/cloudflare';
import { VelaEntrypoint } from '@velajs/cloudflare/entrypoints';
import { CloudflareTracingInterceptor } from '@velajs/cloudflare/tracing';

@Controller('/status')
@UseInterceptors(CloudflareTracingInterceptor)
class StatusController {
  @Get()
  async read() {
    return { ready: true };
  }
}

@Injectable()
@UseInterceptors(CloudflareTracingInterceptor)
class StatusHost {
  async read() {
    return { ready: true };
  }
}

@Module({ controllers: [StatusController] })
class AppModule {}

const app = defineCloudflareApp(AppModule);
export class Status extends VelaEntrypoint(app, StatusHost, { rpc: ['read'] }) {}
export default app.worker;
```

Enable traces in Wrangler and choose an application sampling rate:

```toml
[observability.traces]
enabled = true
head_sampling_rate = 1
```

The interceptor calls `next.handle()` inside `tracing.enterSpan()` and returns
its promise. Native child spans and awaited platform calls run within that
callback's async context. Cloudflare owns sampling, span completion and export,
including its service RPC transport instrumentation. Unsampled calls still run
normally. Use a Workers runtime with the
[native custom-span API](https://developers.cloudflare.com/workers/observability/traces/custom-spans/).

Span names are fixed: `vela.http.handler` and `vela.rpc.handler`. Sampled spans
add only `vela.handler.class` and `vela.handler.method`, each limited to 128
characters. Symbol method names are omitted. Labels use runtime names, which
may change with minification. No request values, arguments, errors, identifiers,
HTTP status or outcome attributes are added by this interceptor. Other execution
kinds pass through without a span.

The span covers the handler and inner interceptors until their returned promise
settles. Guards and pipes run earlier; response streams, deferred work and scope
disposal can outlive it. This integration does not implement Vela's portable
`Telemetry` interface or expose parent selection, span IDs or trace-header
propagation. See [observability](../../docs/observability.md) for that separate API.

The workerd tests exercise nested HTTP/RPC and KV calls, concurrent environments,
errors and disabled sampling. They do not inspect exported span trees or assert
parent IDs. Inspect sampled traces with Wrangler's
[local tracing tools](https://developers.cloudflare.com/changelog/post/2026-08-04-local-tracing/)
when verifying the runtime's exported hierarchy.

## Typed provider factories

Bindings retain their full native API and generic parameters. There are no
binding-name wrappers to initialize or cast.

```ts
import { defineProvider, ENV, InjectionToken, Module } from '@velajs/vela';

const TASK_QUEUE = new InjectionToken<Queue<{ taskId: string }>>('task queue');

@Module({
  providers: [defineProvider(TASK_QUEUE, {
    inject: [ENV],
    useFactory: (env) => env.JOBS,
  })],
  exports: [TASK_QUEUE],
})
class JobsModule {}
```

A `useFactory` strategy declares its dependencies with `inject`; a factory
without parameters may omit it. This also applies to `lazyProvider` and
`forRootAsync` factory options.

Use native `env.DB`, `env.CACHE`, `env.FILES`, `env.JOBS`, `env.AI`,
`env.VECTORIZE`, or `env.HYPERDRIVE` directly. Inject `ENV` in constructors
(`@InjectEnv()`) and factories (`inject: [ENV]`); it works the same in HTTP,
queue, cron and Durable Object code.

## Platform event subscriptions

`@velajs/cloudflare/queue-events` composes inside `@QueueConsumer` to validate
Cloudflare event subscription envelopes and Standard Schema payloads. It awaits
explicit handlers, acknowledges each success and retries failed messages through
the native queue policy. Use a dedicated queue with trusted producer permissions;
metadata checks are not authentication and duplicate deliveries require consumer
idempotency. See the [Worker build example and settlement guide](../../docs/cloudflare-queue-events.md).

## Queues and cron

```ts
import { InjectEnv, Injectable, type VelaEnv } from '@velajs/vela';
import { Cron, type CronInvocation } from '@velajs/vela/schedule';
import { QueueConsumer } from '@velajs/cloudflare';

@Injectable()
class Jobs {
  constructor(@InjectEnv() private readonly env: VelaEnv) {}

  // Declare the same string under Wrangler `triggers.crons`.
  @Cron('0 * * * *', { dialect: 'cloudflare' })
  async refresh(tick: CronInvocation) {
    await this.env.CACHE.put('last-refresh', new Date(tick.scheduledTime).toISOString());
  }

  @QueueConsumer('jobs')
  async consume(batch: MessageBatch<unknown>) {
    for (const message of batch.messages) {
      // Validate message.body before interpreting its application shape.
    }
  }
}
```

A cron trigger runs every core `@Cron()` job whose expression is exactly the
trigger string. Jobs receive only their `CronInvocation`, as on Node, in a fresh
request scope and without guards, interceptors or filters; inject
`CLOUDFLARE_SCHEDULED_EVENT` for the trigger's bound `noRetry()` and
`EXECUTION_LIFETIME` for background work. A job run outside a trigger (Studio's
run-now) receives a synthetic event whose `noRetry()` does nothing. Signed `ScheduleModule` dispatch runs
the signed route with its global guards. Queue consumers use fresh request
scopes and their declared guards, interceptors, and filters. Unclaimed errors
propagate to the platform for retry. Cold queue and cron events have the same
native bindings and live invalidation capabilities as HTTP. See
[scheduling](../../docs/scheduling.md).

## WebSockets, live queries, and Durable Objects

Import the core modules; the Cloudflare adapter wires them to Durable Objects.
Use the native Durable Object entrypoint only in your Worker entry file:

```ts
import { Module } from '@velajs/vela';
import { LiveModule } from '@velajs/vela/live';
import { WebSocketModule } from '@velajs/vela/websocket';
import { defineCloudflareApp } from '@velajs/cloudflare';
import { VelaWebSocketDurableObject } from '@velajs/cloudflare/durable-objects';

@Module({
  imports: [WebSocketModule.forRoot(), LiveModule.forRoot()],
  // Your @WebSocketGateway({ binding: 'ROOMS', ... }) and @LiveResolver classes.
  providers: [],
})
class RoomModule {}

const app = defineCloudflareApp(RoomModule);
export class Room extends VelaWebSocketDurableObject(app) {}
export default app.worker;
```

`cloudflareAdapter` registers the platform as the global `WS_TRANSPORT` and
`LIVE_PLATFORM` tokens before modules load; it never replaces module providers.
In the Worker, `WebSocketModule` serves an upgrade route for each gateway that
names a `binding` and forwards the authenticated upgrade to that room's Durable
Object. The Worker keeps no sockets, so a gateway's `@WebSocketServer()`
refuses pushes there; `Gateways` from `@velajs/vela/websocket`
(`gateways.of(ChatGateway).to(room).emit(event, data)`) calls the `broadcast`
RPC of the gateway + room Durable Object, read by the gateway's `binding` from
`ENV`. Inside a Durable Object, a `Gateways` push to its own room reaches its
sockets and a push to another room goes to that room's object. `LiveModule`
sends invalidations to the room Durable
Object of the single binding-backed gateway, reading the namespace from `ENV`
when first needed; with several, the first invalidation reports the ambiguity,
and `driver: () => durableObjectLive({ gatewayPath })` (or `{ binding }`)
chooses. A gateway without `roomParam` has one room Durable Object, named by
its path, so its invalidations and inspections go there whatever room they
name. Inside the Durable Object, the gateway server broadcasts to its
hibernatable sockets, invalidations apply locally, and the cursor log is a
`DoCursorLog` in the object's SQLite storage (in memory when the class is not
SQLite-backed). `LiveInspector` reads a named room through the same gateway
binding with the object's `inspectLive` RPC, which
Studio's `livePanel({ rooms })` uses. The same `RoomModule` serves the Worker, every Durable Object
and a node host. Without `WebSocketModule`, the Worker mounts no upgrade route,
and the adapter reports each binding-backed gateway through the diagnostics
policy.

Declare gateways with `@WebSocketGateway({ path, roomParam, binding, ... })` and
configure origins and upgrade authentication for your application.
`authenticator` names an `UpgradeAuthenticator` class that the Worker resolves
once per application from the module declaring the gateway, and
`allowedOrigins` may read the environment: `(env) => [env.APP_ORIGIN]`.
`BetterAuthUpgradeAuthenticator` (`@velajs/better-auth`) and
`CloudflareAccessUpgradeAuthenticator` (`@velajs/cloudflare-access/vela`) are
ready-made authenticators. A gateway without an authenticator refuses every
upgrade. Authentication finishes before the Durable Object id is derived. Upgrade
routing consumes the core trusted request identity, checks conflicts with the
upgrade credential, and forwards issuer, subject, tenant, and expiry to the DO.
Client-supplied internal identity headers are stripped before authorization.

Declare each live query once with `defineLiveQuery({ name, args, result })` from
`@velajs/vela/live`. Both schemas accept a parser object such as a Zod schema.
Use `@LiveQuery(definition, { tags: ['todos'] })` on the resolver and share the
definition with its client. Restored hibernation arguments
and final query results use the same validation boundary.

Each application constructs its own driver and cursor log. Workers send
invalidations through the gateway's DO namespace; the DO uses its own live engine
and SQLite cursor log. Configure the class in Wrangler `new_sqlite_classes` to
retain cursor/epoch state across hibernation. Hibernated subscriptions are
restored on wake; the shared live protocol handles resume or snapshot fallback.

The DO class preserves its RPC types, so `DurableObjectNamespace<Room>` exposes
`invalidate`, `broadcast`, `inspectLive`, and PITR methods without assertions.
`liveInvalidateToRoom` and the PITR helpers remain available from the root
package. `VelaNonceDurableObject` is exported from `/durable-objects`; its
`durableObjectNonceStore` factory remains on the root entrypoint.

The root package contains no runtime `cloudflare:workers` import and can be
loaded by Node tooling. Native classes belong to `/durable-objects`.

## Durable Object hosts

`VelaDurableObject(app, Host)` from `/durable-objects` returns a Durable Object
class whose instances each boot one application context from the app's root
(`VelaFactory.createApplicationContext`, under `blockConcurrencyWhile`), with
`Host`, an `@Injectable()`, added to the root module's providers. The host
methods the `rpc` option names become the class's JS-RPC methods, typed on the
binding; no other method, TypeScript `private` helpers included, is reachable
over RPC. Its `fetch`, `alarm` and WebSocket handlers become the object's:

```ts
import { Inject, Injectable } from '@velajs/vela';
import { DO_STORAGE, VelaDurableObject } from '@velajs/cloudflare/durable-objects';

@Injectable()
export class CounterHost {
  constructor(@Inject(DO_STORAGE) private readonly storage: DurableObjectStorage) {}

  async increment(by: number): Promise<number> {
    const value = ((await this.storage.get<number>('value')) ?? 0) + by;
    await this.storage.put('value', value);
    return value;
  }
}

export class Counter extends VelaDurableObject(app, CounterHost, { rpc: ['increment'] }) {}
// Anywhere with the COUNTER binding: await env.COUNTER.getByName('orders').increment(1)
```

The context injects `ENV`, `DO_STATE`, `DO_STORAGE` and `DO_ID`. Each call and
event runs in its own execution scope (request-scoped providers per call)
through the host's scoped guards, pipes, interceptors and filters, with an
`ExecutionContext` of type `rpc` (or `cf:do:fetch`, `cf:do:alarm`,
`cf:do:websocket`); a streamed `fetch()` body keeps its scope open until it is
sent. Failures are reported first; an RPC call rejects only with an
`EntrypointError` (`status`, `code`, `message`, and `details` for a client
fault), which `isEntrypointError()` from the root entry recognizes on the
caller's side from `compatibility_date` 2026-04-21 (or with
`enhanced_error_serialization`). A host whose prototype defines `then()` is
rejected when the class is defined. See
[Durable Objects](../../docs/durable-objects.md).

## Workflows

`VelaWorkflow(app, Host)` from `@velajs/cloudflare/workflows` returns a
`WorkflowEntrypoint` class whose `run(event, step)` is the `run` method of an
`@Injectable()` host, resolved in the Worker's application for the run's
environment (the one the Worker's handlers use), with the host added to the
root module's providers:

```ts
import { Injectable } from '@velajs/vela';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { VelaWorkflow } from '@velajs/cloudflare/workflows';

@Injectable()
export class SignupHost {
  constructor(private readonly users: UsersService) {}

  async run(event: WorkflowEvent<{ email: string }>, step: WorkflowStep) {
    const userId = await step.do(
      'create user',
      async (): Promise<string> => this.users.create(event.payload.email),
    );
    await step.sleep('grace period', '1 day');
    return { userId };
  }
}

export class SignupWorkflow extends VelaWorkflow(app, SignupHost) {}
// Worker code: await env.SIGNUP_WORKFLOW.create({ params: { email } })
```

`event` and `step` pass through untouched, so step retries and replays keep
their semantics. Each run gets its own execution scope (request-scoped
providers per run) and runs the host's scoped guards, interceptors and filters
(`getType()` `'cf:workflow'`). A failure is reported (`edge: 'workflow'`) and
rethrown as it is, so the engine honors `NonRetryableError`. The engine's own
interruptions (`Aborting engine: ...` when an instance is paused, restarted or
terminated) pass through unreported and unfiltered. The typed
`workflow<Params>({ binding })` reference (root entry) creates and reads
instances from module options and helpers; `WorkflowParams<T>` reads a
Workflow's params from its class or host. See
[Workflows](../../docs/workflows.md).

For portable `defineWorkflow(...)` and compiled `@velajs/agent` definitions,
import `VelaWorkflowDefinition` from `@velajs/cloudflare/workflow-definitions`.
This separate entrypoint requires the optional `@velajs/workflow` peer; importing
`/workflows` does not load it. The helper accepts `{ params, inject, useFactory }`:
validate trigger data with `params`, resolve the typed injection tuple per run,
and return `{ definition, run }` from the factory. `run` is an explicit application
dispatcher. Native steps preserve retries, checkpoints and compensation, including
portable terminal-error conversion inside step/rollback callbacks. Export a named
subclass and register it in Wrangler just as above. See the
[portable bridge example](../workflow/README.md#cloudflare-and-dependency-injection).

## Service entrypoints, email and tail

`VelaEntrypoint(app, Host, { rpc })` from `@velajs/cloudflare/entrypoints`
returns a `WorkerEntrypoint` class whose JS-RPC methods are the host methods
`rpc` names, typed on a `Service<typeof Billing>` binding. Each call runs in the
Worker's application through the host's scoped guards, pipes, interceptors and
filters (`getType()` `'rpc'`), with the caller's `ctx.props` injectable as
`ENTRYPOINT_PROPS`; failures are reported (`edge: 'rpc'`) and reject only with
an `EntrypointError`:

```ts
import { Inject, Injectable } from '@velajs/vela';
import { ENTRYPOINT_PROPS, VelaEntrypoint } from '@velajs/cloudflare/entrypoints';

@Injectable()
export class BillingHost {
  constructor(@Inject(ENTRYPOINT_PROPS) private readonly props: unknown) {}

  async charge(customerId: string, cents: number): Promise<{ invoiceId: string }> {
    return { invoiceId: `${customerId}-${cents}` };
  }
}

export class Billing extends VelaEntrypoint(app, BillingHost, { rpc: ['charge'] }) {}
// Another Worker: services: [{ binding: 'BILLING', service: 'billing', entrypoint: 'Billing' }]
// await env.BILLING.charge('customer-1', 500)
```

`fetch`, `connect`, `then`, `ctx`, `env`, `dup`, hooks and the
`WorkerEntrypoint` handlers are never RPC methods.

`@OnEmail({ to? })` from `@velajs/cloudflare/email` and `@OnTail()` from
`@velajs/cloudflare/tail` make provider methods the Worker's Email Workers and
Tail Workers handlers (entrypoint kinds `cf:email` and `cf:tail`); importing
them gives `app.worker` its `email` and `tail` handlers. An email goes to the
handlers whose `to` lists its envelope recipient, else to those without `to`,
and a message no handler accepts is rejected with `setReject()`. Tail handler
failures are reported and never thrown into the platform's loop; an
application that fails to start is logged to the console instead. See
[Service entrypoints, email and tail](../../docs/entrypoints.md).

## Bindings by name

Module options name a binding instead of holding it. `kv`, `r2`, `d1`,
`queue`, `durableObject`, `rateLimit`, `workflow`, `flagship` and
`secretsStoreSecret` each take `{ binding }`, the name
declared in the Wrangler configuration, and read nothing when declared: calling
the reference with an application's `ENV` returns the typed native binding, or
fails naming the binding and the Wrangler key that declares it
(`ENV.UPLOADS is not set: declare the R2 bucket binding 'UPLOADS' under r2_buckets …`).
The drivers and stores below are built on them, so one static module graph
serves every environment.

`flagship` returns the native `Flagship` handle, including typed value and detail
methods. `secretsStoreSecret` returns a native `SecretsStoreSecret` handle; call
`get()` to read its current value. References perform structural checks only:
they do not read secrets, evaluate flags, cache results, create resources or prove
remote availability. Native method errors and local-development behavior are
unchanged. Use current generated Wrangler types or Workers types containing
these native interfaces (validated with Wrangler 4.135.0 and Workers types
5.20260920.1).

```ts
import { flagship, secretsStoreSecret } from '@velajs/cloudflare';

const flags = flagship({ binding: 'FLAGS' });
const apiKey = secretsStoreSecret({ binding: 'API_KEY' });

// In request/application scope, using that application's environment:
async function readSettings(env: Env) {
  const enabled = await flags(env).getBooleanValue('new-layout', false);
  const key = await apiKey(env).get();
  return { enabled, key };
}
```

Declare `FLAGS` under `flagship` with an `app_id`, and `API_KEY` under
`secrets_store_secrets` with a `store_id` and `secret_name`, separately for each
named environment. `vela add binding` can write those config declarations;
resource setup remains explicit. See Cloudflare's [Flagship binding API](https://developers.cloudflare.com/flagship/binding/)
and [Secrets Store Workers integration](https://developers.cloudflare.com/secrets-store/integrations/workers/)
for native methods and local setup. In particular, local Secrets Store values
are separate from production secrets.

## Rate limiting

`ThrottlerModule` from `@velajs/vela/throttler` counts through Workers Rate
Limiting bindings named in `rateLimitStore`:

```ts
import { ThrottlerModule } from '@velajs/vela/throttler';
import { rateLimitStore } from '@velajs/cloudflare';

ThrottlerModule.forRoot({
  throttlers: [
    { name: 'burst', ttl: 10_000, limit: 20 },
    { name: 'sustained', ttl: 60_000, limit: 100 },
  ],
  storage: rateLimitStore({ binding: { burst: 'BURST_LIMITER', sustained: 'API_LIMITER' } }),
});
```

`rateLimitStore({ binding: 'API_LIMITER' })` serves every throttler from one
binding. Each binding's `simple.limit` and `simple.period` in the Wrangler
`ratelimits` block must equal its throttler's `limit` and `ttl` (10 or 60
seconds): the platform enforces them, so a `@Throttle()` override that changes
them fails at bootstrap, and one binding serves only throttlers that share a
`limit` and `ttl`. The store checks the declared throttlers at bootstrap: another
period, different values on one binding, or a throttler the per-name map leaves
out fails the application before any binding is charged. The platform exposes no
counters, so responses carry no `X-RateLimit-Remaining`, and no reset time, so
`X-RateLimit-Reset` and `Retry-After` report the configured period.

Workers Rate Limiting counts per Cloudflare location, and its counters are
eventually consistent: limits are approximate, not a global or exact quota. A
client spread across locations can exceed them. For strict limits such as login
attempts per account, implement a `ThrottlerStore` that counts in a Durable
Object.

## R2 storage and caches

`StorageModule` from [`@velajs/storage`](../storage/README.md#storage-on-cloudflare-workers)
is the one file-storage module. Its native R2 driver comes from the
`@velajs/cloudflare/storage` subpath:

```ts
import { StorageModule } from '@velajs/storage';
import { r2Storage } from '@velajs/cloudflare/storage';

StorageModule.register({ driver: r2Storage({ binding: 'UPLOADS' }) });
```

The bucket is read from each application's `ENV` on its first storage
operation. The native binding cannot presign; use `publicBaseUrl`, the storage
HTTP controller with `http: { download: 'proxy' }`, or the R2 HTTP/hybrid
drivers for provider-signed URLs.

`CacheModule` from `@velajs/vela/cache` takes its KV stores by binding name:

```ts
import { CacheModule } from '@velajs/vela/cache';
import { kvCache, kvCacheInvalidation } from '@velajs/cloudflare';

CacheModule.forRoot({
  namespace: 'catalog-v1',
  scope: trustedCacheScope,
  store: kvCache({ binding: 'CACHE' }),
  invalidation: kvCacheInvalidation({ binding: 'CACHE_GENERATIONS' }),
});
```

Each operation reads the namespace from the application's `ENV`. A binding that
is not declared fails the operation with an error naming it and
`kv_namespaces`; the cache treats that as a miss and sends the error to the
application's error reporter (edge `'cache'`).

`kvCache({ binding })` is a function of `ENV`, so a tier composes it without
reading `ENV` directly:
`store: (env) => new TieredCacheStore([new MemoryCacheStore(), kvCache({ binding: 'CACHE' })(env)])`.
`KVCacheStore` and `KVCacheInvalidationStore` also take a namespace or a
function returning one.
Construct `KvFlagDriver` with a native namespace: `new KvFlagDriver(env.CACHE)`.
Cache reads and object-valued flag reads return `unknown`; validate them with an
application parser (`cache.scope(scope).getParsed(key, parser)`).

## Testing Worker handlers

`@velajs/cloudflare/testing` runs inside the Workers Vitest pool
(`@cloudflare/vitest-plugin`) and needs `@velajs/testing`.
`createTestingWorker(AppModule, { env?, overrides?, ...workerOptions })` builds
the module as `createCloudflareWorker(AppModule, workerOptions)` does (its
adapters, then its `configure(app, env)` hook), through
`Test.createTestingModule()`, and drives the Worker's handlers:

```ts
import { env } from 'cloudflare:workers';
import { createTestingWorker, queueJob } from '@velajs/cloudflare/testing';
import { expect, it } from 'vitest';

it('processes a created todo', async () => {
  const worker = await createTestingWorker(AppModule, {
    env,
    overrides: (module) =>
      module
        .overrideModule(NotificationsModule)
        .useModule(SilentNotifications)
        .useMocker((token) => (token === Notifier ? fakeNotifier : undefined)),
  });
  try {
    const created = await worker.fetch('/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Write tests' }),
    });
    expect(created.ok).toBe(true);

    const result = await worker.queue('todo-events', [
      queueJob('todo-events', todoCreated, { id: '1', title: 'Write tests' }),
    ]);
    expect(result.outcome).toBe('ok');
    expect(result.explicitAcks).toHaveLength(1);

    await worker.scheduled('0 3 * * *');
  } finally {
    await worker.close();
  }
});
```

- `env` defaults to the pool's `env` from `cloudflare:workers`; every event
  carries it, so the Cloudflare adapter accepts the requests.
- `overrides` receives the `@velajs/testing` builder: `overrideProvider()`,
  `overrideGuard()` and the other enhancer overrides, `overrideModule().useModule()`
  and `useMocker()`. `worker.module` is the compiled `TestingModule`; its
  `fetch()` and `http` client send the same `env` as `c.env`.
- `fetch(input, init?)` resolves a path against `http://localhost`.
- `queue(physicalQueue, messages)` delivers one batch built with `cloudflare:test`'s
  `createMessageBatch()` and returns its `getQueueResult()` plus `outcome`
  (`'exception'`, with `error`, when the handler rejected: Cloudflare would retry
  the unacknowledged messages). `queueJob(queue, jobOrName, data, { id?, attempts? })`
  builds the envelope `QueueClient.add()` sends.
- `scheduled(cron, { scheduledTime? })` fires a cron trigger with
  `createScheduledController()`, and rejects when no `@Cron` job declares `cron`.
- `email(message)` and `tail(events)` deliver to the `@OnEmail()` and
  `@OnTail()` handlers. `emailMessage({ from, to, subject?, text?, headers?, raw? })`
  builds a `ForwardableEmailMessage` that records `setReject()`, `forward()` and
  `reply()` (`rejectReason`, `forwards`, `replies`); `traceItem(overrides?)`
  builds a `TraceItem`.
- `close()` cancels response bodies a test never read, waits for background
  work (`waitUntil`) and closes the application.

The subpath is not part of any Worker bundle: import it from tests only.

## Validated Pipelines producers

`@velajs/cloudflare/pipelines` adds producer validation to a configured native
stream handle. It is an optional adapter subpath: there is no module, queue
driver, or replacement for the native Pipelines API.

Configure the stream in Wrangler and regenerate your environment types:

```jsonc
{
  "pipelines": [{ "binding": "EVENT_STREAM", "stream": "<STREAM_ID>" }],
}
```

Use a Standard Schema validator whose **output** matches the deployed stream
schema. Synchronous and asynchronous transforms are supported; `send()` takes
schema **inputs** and sends the validated outputs:

```ts
import { ENV, InjectionToken, defineProvider } from '@velajs/vela';
import { createPipelinesWriter, type PipelinesWriter } from '@velajs/cloudflare/pipelines';
import { z } from 'zod';

const event = z.object({
  id: z.string().min(1),
  count: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().nonnegative()),
});

export const EVENTS = new InjectionToken<PipelinesWriter<z.input<typeof event>>>('events');

// Add this provider to your application's providers. ENV and the writer belong
// to that application; do not capture a request's environment at module scope.
export const eventsProvider = defineProvider(EVENTS, {
  inject: [ENV],
  useFactory: (env) => createPipelinesWriter(env.EVENT_STREAM, { schema: event }),
});

// In a provider that injects EVENTS:
// await this.events.send([{ id: 'sample-1', count: '2' }]);
```

The factory also works directly with `createPipelinesWriter(env.EVENT_STREAM,
{ schema: event })`. The binding is structural (`send(records): Promise<void>`),
remains available as `env.EVENT_STREAM`, and needs no `cloudflare:pipelines`
runtime import. Generated `Pipeline<RecordType>` bindings check schema output
compatibility at compile time. Select the stream through trusted configuration;
the writer does not accept a stream name or endpoint from a record or request.

Each nonempty `send(records)` validates all records before making one native
call. A failure rejects without sending any records; validation may stop at the
first error. Standard Schema failures use `SchemaValidationError` from
`@velajs/vela/validation`, with the record index prefixed to each issue path.
Validator exceptions and native failures propagate. There is no automatic retry,
batch splitting, rate limiter, or buffering. Empty batches reject.

After schema transforms, each record must be a plain JSON object. Nested objects
and dense arrays may contain strings, booleans, null, and finite numbers. The
writer rejects undefined values (including explicitly undefined optional fields),
functions, symbols, bigint, non-finite numbers, cycles, class instances, `Date`,
`Map`, `Set`, typed arrays, getters, non-enumerable or symbol properties, extra
array properties, and `toJSON` functions. Convert special values in your schema.
Validated outputs are copied before the next asynchronous validation, so later
mutations cannot alter already checked records. Callers must not mutate inputs
while their schema is validating them.

The writer measures the UTF-8 encoding of compact JSON outputs, including escapes,
commas and array brackets, against a conservative **5,000,000-byte request
ceiling**. A single record must fit inside that same JSON array (at most
4,999,998 bytes). The current [Cloudflare limits](https://developers.cloudflare.com/pipelines/platform/limits/)
document 5 MB per ingestion request without a separate record size cap; this
adapter does not invent one. Oversize records or batches reject with `RangeError`;
non-JSON output rejects with `TypeError`.

`send()` resolves to `void` only after native ingestion acceptance. Cloudflare
[accepts but later drops invalid structured events](https://developers.cloudflare.com/pipelines/streams/writing-to-streams/#schema-validation),
so keep your producer schema aligned with the configured stream. Resolution
provides no query visibility, transaction, application exactly-once, or terminal
storage guarantee. A failed native request may have reached the service; any
retry and deduplication policy belongs to the application.

Tests cover producer behavior and native type compatibility. Workerd tests also
exercise Miniflare's local Pipelines binding, whose `send()` is a no-op; they
provide no remote ingestion, schema enforcement, or downstream storage proof.

## Development

From the repository root:

```sh
pnpm --filter @velajs/cloudflare test
pnpm --filter @velajs/cloudflare test:workers
pnpm --filter @velajs/cloudflare typecheck
```

The Workers suite uses real KV, D1, R2, WebSockets, SQLite Durable Objects, and
cold event dispatch. See the [security guide](https://github.com/velajs/vela/blob/main/docs/cloudflare-security.md) for trusted identity,
URL signing, and WebSocket boundaries.

### KV caches

`kvCache` works directly as `CacheModule`'s store or, through `KVCacheStore`, as
a tier beneath `TieredCacheStore`. The adapter retains absolute logical expiry in
KV metadata; KV's minimum physical retention does not extend the requested TTL.
For tags and scoped invalidation, configure `kvCacheInvalidation` with a separate
dedicated KV namespace without TTLs or lifecycle cleanup. It is eventually
consistent, including concurrent writes and cached negative reads, and does not
promise globally strong invalidation. See the [caching guide](../../docs/caching.md).
