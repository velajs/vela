# Queues

`@velajs/vela/queue` provides portable jobs and processors with Nest-style
registration. Configure the driver once in the root module, register each queue
in the module that uses it, inject its client, and process its jobs:

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
  type QueueJobOutput,
} from '@velajs/vela/queue';
import { cloudflareQueues } from '@velajs/cloudflare/queues';
import { z } from 'zod';

export const welcome = defineQueueJob('welcome', z.object({ userId: z.string() }));

@Injectable()
class SignupService {
  constructor(@InjectQueue('email') private readonly email: QueueClient) {}

  invite(userId: string) {
    return this.email.add(welcome, { userId });
  }

  inviteAll(userIds: string[]) {
    return this.email.addBulk(userIds.map((userId) => ({ job: welcome, data: { userId } })));
  }
}

@Processor('email') // implies @Injectable()
class EmailProcessor {
  @Process(welcome)
  async send(job: QueueJob<QueueJobOutput<typeof welcome>>) {
    // job.data.userId is validated.
  }
}

// Feature module: registers the queue it produces and processes.
@Module({
  imports: [QueueModule.registerQueue({ name: 'email', binding: 'EMAIL_QUEUE' })],
  providers: [SignupService, EmailProcessor],
})
class EmailModule {}

// Root module: one driver for the whole application.
@Module({ imports: [QueueModule.forRoot({ driver: cloudflareQueues() }), EmailModule] })
class AppModule {}
```

`add()` resolves when the driver accepted the job, not when a processor has
finished. Processors retain their declared scopes and run in a fresh invocation
scope per job.

## Registration

`QueueModule.forRoot({ driver, dispatch })` configures the driver and dispatch
policy. It is global and belongs in the root module, once per application. The
driver and a signed dispatch policy are compared by reference: importing the
same objects again deduplicates, while a different driver instance or another
signed policy object fails bootstrap, even a policy that differs only in its
target, method or TTL, or one a helper builds from the same source. The driver
defaults to the in-process `inline()` driver. `forRootAsync` resolves the same
options from a factory during application initialization. Its options object
is the configuration, with or without an explicit `key`: importing the same
object again deduplicates, and a different one, even one that shares its `key`,
or a `forRoot` next to it, fails bootstrap.

`QueueModule.registerQueue({ name, binding?, consumer? })` registers queues in
the module that uses them and provides each queue's `QueueClient`. Inject it with
`@InjectQueue(name)`, which is `@Inject(queueToken(name))`. Several queues can be
registered in one call. Registering one queue in several modules is fine: the
registrations merge by name, and every module gets the same client. A queue has
one producer binding, so two different bindings for one name fail bootstrap; a
module that only consumes the queue may omit `binding`. A registration without
`QueueModule.forRoot()` in the application fails bootstrap.

- `name` is the logical queue: the `@InjectQueue(name)` client, the
  `@Processor(name)` handlers and every job's `queue` field.
- `binding` is the transport binding the driver sends through. With
  `cloudflareQueues()` it is a Wrangler `queues.producers[].binding`.
- `consumer` pins the queue to a physical queue this application consumes; see
  [Cloudflare delivery](#cloudflare-delivery).

`QueueRegistry`, exported by `forRoot`, lists the merged registrations. Each
registered queue is also published as a `queue:registration` entrypoint that
`vela deploy check` reads.

## Adding jobs in bulk

`client.addBulk([{ job, data, options? }, ...])` takes one entry per
`add(job, data, options)` call. Each entry is typed on its own: a typed entry's
`data` is its definition's wire input, a named entry's `data` is free, and typed
and named entries may share one call. The entry shape follows `add()`, so it
differs from BullMQ's `addBulk([{ name, data, opts }])`: use `job` for the name
or definition and `options` for `{ delayMs }`.

```ts
await this.email.addBulk([
  { job: welcome, data: { userId: 'u1' } },
  { job: 'digest', data: { day: '2026-09-23' }, options: { delayMs: 60_000 } },
]);
```

`addBulk` validates every typed job before the driver sees any of them, then
hands the whole batch to the driver's optional `enqueueBatch`, or enqueues the
jobs one at a time in order when the driver has none. It resolves with the added jobs only when every job was accepted. Otherwise
it rejects with a `QueueBatchError`: `accepted` lists the ids of jobs the
transport already took, which will be delivered, and `rejected` the rest. Retry
only the rejected jobs; sending the whole batch again delivers the accepted ones
twice.

## Drivers

A driver factory, `driver: (context) => QueueDriver`, builds a fresh driver for
each application from its `QueueDriverContext`: the application's `ENV`, when a
runtime seeded one, and its `QueueRegistry`. `cloudflareQueues()` is such a
factory. Use a factory whenever module declarations are reused across
applications, for example `driver: () => inline()`.

A bound driver instance belongs to one application. Reusing it for another
application throws instead of redirecting deliveries. Producer-only drivers
without a `bind` method can be shared if their own transport permits it.

A transport that is not Cloudflare Queues, and a test, hands each job it
receives to `dispatchQueueJob(container, entrypoints, job)` from
`@velajs/vela/queue`. Like a native delivery, it goes through `QueueModule`'s
dispatch policy: the job's queue must be registered, and signed dispatch
re-enters the signed route, so its global guards run. Without a `QueueModule`,
it calls the processors directly. It rejects a job that no processor handles,
such as a misspelled or removed job name, unless you pass
`{ unhandled: 'ignore' }`. Acknowledge a message only when `dispatchQueueJob`
resolves, and let the transport retry it when it rejects, so no job is lost.
Cloudflare Queues need no such code: `cloudflareQueues()` delivers registered
queues itself.

For deterministic tests, create `inline({ mode: 'manual' })` per application and
await `flush()`. Failed jobs reject the flush after all buffered jobs are tried;
the inline driver does not retry them. Closing the application releases its
binding and clears pending jobs. Adds after inline disposal reject. A driver that implements `bind` must return
a cleanup function; the module calls it at disposal.
Inline delivery is in memory and does not support delayed or durable delivery.

## Cloudflare Queues

`cloudflareQueues()` from `@velajs/cloudflare/queues` is the Workers driver.
Declare each registered binding as a producer, and a consumer for each physical
queue the Worker processes:

```jsonc
{
  "queues": {
    "producers": [{ "binding": "EMAIL_QUEUE", "queue": "email-production" }],
    "consumers": [{ "queue": "email-production", "max_retries": 3, "dead_letter_queue": "email-dlq" }]
  }
}
```

### Producing

The driver reads the registered binding from the application's `ENV` when a job
is added, checks that it has `send()`, and awaits the native send; failures
propagate without hidden retries. Bindings are never captured at module scope.
`delayMs` rounds up to whole seconds; zero explicitly disables a configured
delay. `addBulk` uses `sendBatch`, split in order into calls of at most 100
messages and an estimated 256 KB. The estimate is the larger of the job's JSON
and V8 serialized sizes plus a margin; a job estimated over 128 KB is rejected
before anything is sent, so store large payloads elsewhere (for example in R2)
and enqueue a reference.

### Cloudflare delivery

The Worker's `queue()` handler first gives a batch to the `@QueueConsumer`
handlers of its physical queue. A batch no `@QueueConsumer` claims goes to
`QueueModule`, which settles it one message at a time:

- Each job envelope is routed by its logical `queue`, so several registered
  queues may share one physical queue.
- Every job goes through the module's dispatch policy. Signed dispatch
  re-enters the signed route, so its global guards run for native deliveries.
- A message is acknowledged after every processor of its queue and their managed
  work settle.
- A message that is not a job envelope, belongs to an unregistered queue, has no
  handler, or fails stays unacknowledged. The batch rejects after every message
  was tried, so Cloudflare retries the remainder and then routes it to the
  configured dead-letter queue.
- `registerQueue({ name, consumer: 'email-production' })` pins the queue: its
  jobs are accepted only from `email-production`, and that physical queue only
  carries the queues pinned to it. Without `consumer`, a job is accepted from any
  physical queue the Worker consumes. A pinned registration with a `binding`
  must send to one of its pins; `vela deploy check` fails with
  `queue-producer-outside-pins` otherwise.

Each failure is reported once to the exception handler on the `queue` edge: a
processor failure where the processor ran, and a message that is not a job, an
unregistered queue, a job no processor handles or a rejected signed re-entry when
the batch settles.

Delivery attempts come from the platform and the producer's job id is
preserved for application idempotency. If one of several processors fails, the
others may run again on redelivery: business operations must tolerate
duplicates. The driver does not claim exactly-once delivery, configure retries
or dead-letter queues, or implement a durable outbox.

A producer-only Worker registers `{ name, binding }`. A consumer-only Worker
registers `{ name }`, or `{ name, consumer }` to pin its physical queue, and
declares the processors. `vela deploy check` verifies producer bindings and
consumers against the selected Wrangler environment; see
[deployment](deployment.md). The [four-worker example](../apps/module-workers/README.md)
runs a producer and a consumer Worker in workerd.

### Raw batches

Native `Queue<T>` bindings and `@QueueConsumer(physicalQueue)` remain available
for batches that are not Vela jobs. A `@QueueConsumer` owns its physical queue:
it receives that queue's batches whole and owns their settlement, and a batch no
consumer claims is rejected unacknowledged. It must not carry jobs of queues
registered with `QueueModule`. Registered queues are delivered by
`cloudflareQueues()`; a job that arrives at a raw consumer reaches its
`@Processor` only if the raw handler dispatches it itself, so send registered
queues to physical queues that no `@QueueConsumer` claims.

A physical queue cannot be both a `@QueueConsumer` queue and a pinned `consumer`
of a registration: bootstrap fails. When a `@QueueConsumer` receives jobs of a
registered queue, the adapter warns once per physical and logical queue (unless
diagnostics are silent), and `vela deploy check` fails with
`queue-consumer-claimed-by-raw` when a `@QueueConsumer` claims the physical
queue a registered queue's producer binding sends to, whether or not the Worker
processes that queue.

`consumeQueueBatch` from `@velajs/cloudflare/queues` applies the per-message
settlement described above to a raw batch: each message is acknowledged after
its callback resolves unless the callback settled it first with `ack()` or
`retry()`, a message that is not a job envelope stays unacknowledged, and
failures are rethrown after the batch was tried. Its `queues` option accepts
only jobs of the listed logical queues.

## Signed dispatch

`QueueModule.forRoot({ driver, dispatch: { kind: 'signed', target } })` delivers
every job by re-entering a `@SignedInvocation()` route, with the job as the
request body, instead of calling its processors directly. The route runs the
full request pipeline, including global guards that direct processor dispatch
deliberately skips. The policy applies to every delivery through the module:
the inline driver's, a platform driver's native consumer and `dispatchQueueJob`
alike, so a custom transport cannot bypass the route's guards. A producer-only
application may configure it too. On Workers the invocation is
signed with the `URL_SIGNING_SECRET` from `ENV` unless a secret is configured.

```ts
QueueModule.forRoot({
  driver: cloudflareQueues(),
  dispatch: { kind: 'signed', target: (job) => ({ path: `/jobs/${job.queue}` }) },
});
```

## Observing settlement

`observeMessage` and `observeBatch` wrap native messages without mutating them.
The first successful individual `ack()` or `retry()` call determines the observed
outcome; later calls still forward to the host. A throwing host call does not
record a settlement. Implicit batch completion and batch-level ack/retry calls
are not observed by this message wrapper.

`maxRetries` excludes the initial delivery. With `maxRetries: 3`, an explicit
retry on attempt 4 reports `retryExhausted: true`. `deadLettered` is an inference
of configured routing, never confirmation of delivery. It stays unknown unless
both `maxRetries` and `deadLetterQueue` are supplied. A consumer without a DLQ
reports `deadLettered: false` even when retries are exhausted. Platform
configuration owns retries, deletion, and dead-letter routing.

## Validated job definitions

Share a job definition between producers and processors. The schema implements
Standard Schema (for example, Zod or Valibot). Input and transformed output remain
distinct:

```ts
export const welcome = defineQueueJob('welcome', z.object({
  userId: z.string(),
  age: z.string().transform(Number),
}));

@Processor('email') // implies @Injectable()
class EmailProcessor {
  @Process(welcome)
  async send(job: QueueJob<QueueJobOutput<typeof welcome>>) {
    // job.data.age is a validated number.
  }
}

await this.email.add(welcome, { userId: 'u1', age: '20' });
```

The typed overload checks the input, snapshots it with `structuredClone`, and
awaits validation before sending. Validation receives a separate clone so
mutating validators cannot change the wire snapshot. Transport carries the
original input shape; each processor validates it into output before invoking
the method. Async schemas are supported. Schemas should be deterministic and
free of external side effects because producer and consumer both validate.
Typed jobs must be structured-cloneable. Raw `add(name, data)` and `@Process(name)` transport arbitrary payloads without
automatic validation; use definitions for validated jobs.

The decorator checks the annotated handler's job type. As in NestJS, a
`@Process(definition)` composed through `applyDecorators` does not check the
handler it decorates. Use `QueueJobInput<D>` for
producer payload types and `QueueJobOutput<D>` for processor payload types.
Validation failures propagate through declared processor filters; a filter that
claims an error treats that delivery as handled. A valid payload does not confer
trusted principal or tenant identity.

## Module and invocation isolation

Processor discovery retains each owning module, including multiple keyed
instances of the same module/processor class. Async options and declared guards,
interceptors, and filters resolve from that owner. Processors with request scope
are constructed after guards pass. Each matching processor runs inside the
shared managed invocation scope: registered deferred work finishes before scope
disposal and before delivery succeeds or fails. A deferred failure rejects the
delivery; it is not hidden behind acknowledgement.
