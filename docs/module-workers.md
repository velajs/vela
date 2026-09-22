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

Use `createCloudflareWorker(RootModule, { envToken: ENV })` for each entrypoint.
A root may also be a dynamic module, or `{ create: async env => dynamicModule }`.
Factories run once per environment object in an isolate: the Worker and its
Durable Object instances share the module graph and every value the factory
created, such as `useValue` providers and module options. Each application builds
its own class and factory providers, so create per-application state with
`useFactory` or `forRootAsync`. Concurrent events share construction, failed construction is
evicted and retried, and different environments remain isolated. Keep active
database connections and authenticated identities in their invocation scopes, not
in root factories or singleton providers.

## Native queues through QueueModule

```ts
QueueModule.forRootAsync({
  queues: ['documents'],
  inject: [ENV],
  useFactory: env => ({
    driver: cloudflareQueueDriver(
      { documents: env.DOCUMENTS },
      {
        consumers: { 'documents-staging': 'documents' },
        producerBindings: { documents: 'DOCUMENTS' },
      },
    ),
  }),
});
```

Import `QueueModule`, `Processor`, `Process` and `queueToken` from
`@velajs/vela/queue`; import the driver from `@velajs/cloudflare/queue`.
The first driver argument maps logical names to native producer objects. Omit
those entries in consumer-only Workers. Omit `consumers` in producer-only Workers.
`producerBindings` declares the corresponding Wrangler binding names for deployment
checks. Consumer keys are physical queue names; values are logical processor names.

The module contributes native routes automatically. Do not add a bridge consumer
for the same physical queue: ambiguous ownership fails bootstrap. Unknown native
queues, mismatched envelopes and unhandled jobs reject delivery. Successful siblings
are acknowledged after their handlers and managed work settle; failures remain
unsettled for platform redelivery. Existing envelopes and delivery IDs are preserved.
Wrangler owns retry limits, delays and dead-letter queues. Transactional outboxes,
leases and application idempotency remain separate concerns.

`@QueueConsumer`, native `Queue` objects and `consumeQueueBatch` remain available
for applications needing direct native batch control.

`QueueModule` signed dispatch (`dispatch: { kind: 'signed', target }`) re-enters the
signed route for batches the module consumes, so global guards apply. It needs a
`consumers` mapping: bootstrap rejects signed dispatch on a producer-only driver,
because bridge deliveries would skip the signed route.

## Scheduling and RPC

Use `ScheduleModule.forRoot()` and `@Cron(expression, { dialect: 'cloudflare' })`.
Declare the exact expression in that Worker's Wrangler triggers. Workers do not
start Node timers, and importing the module does not provision a trigger.
`@Scheduled` remains available for direct native controller access.
The Cloudflare adapter does not support signed `ScheduleModule` dispatch yet and
rejects it at bootstrap. To run a scheduled job through a signed route, call
`InternalDispatcher.run()` from the `@Cron` handler.

`RpcModule.forRoot({ authorize })` and `forRootAsync` serve registered `@Rpc`
procedures through the existing schema-validated HTTP dispatcher. Named clients
use `RpcClientModule.register/registerAsync` and `rpcClientToken(name)`; supply a
native service binding as the client's `fetch` transport. `binding` records its
Wrangler name for deployment checks. Contracts and browser clients stay free of
server imports. The server module applies the global and scoped pipeline once.

`vela deploy check` consumes the selected environment and entrypoint snapshot to
check native consumers, producer declarations, cron triggers, and RPC service
bindings. It does not create resources. See the [four-worker example](../apps/module-workers/README.md).

## Migration

The modular Workers APIs are available on the active 1.x line from 1.28.0.
Install the framework and affected integrations together at 1.28.0 or later.
The earlier 2.x and 3.x publications are historical; the default release line is 1.x.

Vela permits breaking API changes in minor releases and does not retain
compatibility layers. Follow the current module APIs and update application
imports and configuration when upgrading.

Queue transport configuration now initializes during bootstrap, including apps
without a producer. Duplicate queue ownership fails at startup instead of the
first client resolution. Job providers still follow their declared scopes.
Cloudflare queue deliveries without a registered consumer now reject, rather than
returning successfully and allowing implicit acknowledgement. These behavior
changes ship within 1.x; native decorators remain explicit escape hatches.
