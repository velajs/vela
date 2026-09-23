# Module-based Worker applications

Keep feature services in an exported domain module. Put HTTP controllers in a
separate module importing that domain, and scheduled providers/processors in a
jobs module. Each Worker selects its own imports; disabling a controller after
importing its code does not remove it from a bundle.

```ts
@Module({ providers: [DocumentsService], exports: [DocumentsService] })
class DocumentsModule {}

@Module({ imports: [DocumentsModule], controllers: [DocumentsController] })
class DocumentsHttpModule {}

@Module({ imports: [DocumentsModule], providers: [DocumentJobs] })
class DocumentsJobsModule {}

@Module({ imports: [DocumentsHttpModule] })
class ApiModule {}

@Module({ imports: [DocumentsJobsModule, ScheduleModule.forRoot()] })
class JobsModule {}
```

Use `export default createCloudflareWorker(RootModule)` for each entrypoint; it
seeds that Worker's native environment as the framework `ENV`. Give each Worker
its own `wrangler types` output and type-check it as its own program, so its
`VelaEnv` only has the bindings its Wrangler file declares.
A root may also be a `DynamicModule` such as `AppModule.forRoot(...)`, declared
once at module scope. Roots are static: bindings reach the graph only through
dependency injection, in `forRootAsync({ inject: [ENV] })` factories, `useFactory`
providers and `@InjectEnv()` constructors. The Worker and its Durable Object
instances share the module graph and every value declared with it, such as
`useValue` providers and `forRoot` options. Each application builds its own class
and factory providers, so create per-application state with `useFactory` or
`forRootAsync`. Concurrent events share construction, failed construction is
evicted and retried, and different environments remain isolated. Keep active
database connections and authenticated identities in their invocation scopes, not
in module options or singleton providers.

## Native queues through QueueModule

```ts
// Both Workers
QueueModule.forRoot({ driver: cloudflareQueues() });
// API Worker (producer): DOCUMENTS is a queues.producers binding
QueueModule.registerQueue({ name: 'documents', binding: 'DOCUMENTS' });
// Jobs Worker (consumer): pins the physical queue it consumes
QueueModule.registerQueue({ name: 'documents', consumer: 'documents-staging' });
```

Import `QueueModule`, `InjectQueue`, `Processor` and `Process` from
`@velajs/vela/queue`, and the driver from `@velajs/cloudflare/queues`. Inject the
producer with `@InjectQueue('documents')`; the driver reads `ENV.DOCUMENTS` from
each application's environment when a job is added. Put `@Processor('documents')`
in the consumer Worker's jobs module. Register the queue in the module that uses
it; `forRoot` goes once in each Worker's root module.

The module consumes natively without a mapping: batches no `@QueueConsumer` claims
are routed message by message by each job's logical queue, so several queues can
share one physical queue. `consumer` is optional; it pins the logical queue to
that physical queue in both directions. Do not add a `@QueueConsumer` for a pinned
physical queue: ambiguous ownership fails bootstrap. Unregistered queues,
non-envelope messages and unhandled or failed jobs reject delivery. Successful
siblings are acknowledged after their handlers and managed work settle; failures
remain unsettled for platform redelivery. Existing envelopes and delivery IDs are
preserved. Wrangler owns retry limits, delays and dead-letter queues. Transactional
outboxes, leases and application idempotency remain separate concerns.

`@QueueConsumer`, native `Queue` objects and `consumeQueueBatch` remain available
for applications needing direct native batch control of physical queues that
carry no jobs of registered queues.

`QueueModule` signed dispatch (`dispatch: { kind: 'signed', target }`) re-enters the
signed route for every job the module delivers, native deliveries included, so
global guards apply. See [queues](queues.md) for bulk sends, limits and settlement.

## Scheduling and RPC

Use `ScheduleModule.forRoot()` and `@Cron(expression, { dialect: 'cloudflare' })`.
Declare the exact expression in that Worker's Wrangler triggers. Workers do not
start Node timers, and importing the module does not provision a trigger. Jobs
receive only their `CronInvocation`, as on Node; inject
`CLOUDFLARE_SCHEDULED_EVENT` for the trigger's `noRetry()`. Signed `ScheduleModule`
dispatch re-enters the signed route with its global guards, exactly as on Node.
See [scheduling](scheduling.md#workers-cron-triggers).

`RpcModule.forRoot({ authorize })` and `forRootAsync` serve registered `@Rpc`
procedures through the existing schema-validated HTTP dispatcher. Named clients
use `RpcClientModule.register/registerAsync` and `rpcClientToken(name)`; supply a
native service binding as the client's `fetch` transport. `binding` records its
Wrangler name for deployment checks. Contracts and browser clients stay free of
server imports. The server module applies the global and scoped pipeline once.

`vela deploy check` consumes the selected environment and entrypoint snapshot to
check native consumers, registered queue producers, cron triggers, and RPC
service bindings. It derives a registered queue's physical queue from its
`consumer` pin or its binding's Wrangler producer. It does not create resources. See the [four-worker example](../apps/module-workers/README.md).

## Migration

The modular Workers APIs are available on the active 1.x line from 1.28.0.
Install the framework and affected integrations together at 1.28.0 or later.
The earlier 2.x and 3.x publications are historical; the default release line is 1.x.

Vela permits breaking API changes in minor releases and does not retain
compatibility layers. Follow the current module APIs and update application
imports and configuration when upgrading.

Queue transport configuration now initializes during bootstrap, including apps
without a producer. `QueueModule.forRoot()` configures only the driver; register
queues with `QueueModule.registerQueue()` and replace the former
`@velajs/cloudflare/queue` driver with `cloudflareQueues()` from
`@velajs/cloudflare/queues`. Conflicting queue
bindings fail at startup instead of the first client resolution. Job providers still follow their declared scopes.
Cloudflare queue deliveries without a registered consumer now reject, rather than
returning successfully and allowing implicit acknowledgement. These behavior
changes ship within 1.x; native decorators remain explicit escape hatches.
