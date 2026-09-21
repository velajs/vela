# Queues

`@velajs/vela/queue` provides portable jobs and processors. Import `QueueModule`,
inject `queueToken(name)`, and await `client.add(name, data)`. Acceptance means the
driver accepted the job; it does not mean a processor has finished.

## Driver ownership

The default inline driver is created separately for each application. When
reusing module declarations across applications, configure a factory:

```ts
QueueModule.forRoot({ queues: ['email'], driver: () => inline() });
```

A bound driver instance belongs to one application. Reusing it for another
application throws instead of redirecting deliveries. Producer-only drivers
without a `bind` method can be shared if their own transport permits it. Use
`forRootAsync` with the application's environment token for native bindings.

For deterministic tests, create `inline({ mode: 'manual' })` per application and
await `flush()`. Failed jobs reject the flush after all buffered jobs are tried;
the inline driver does not retry them. Closing the application releases its
binding and clears pending jobs. Legacy adds after inline disposal remain no-ops.
Inline delivery is in memory and does not support delayed or durable delivery.

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
import { z } from 'zod';
import { Injectable } from '@velajs/vela';
import { defineQueueJob, Process, Processor } from '@velajs/vela/queue';
import type { QueueJob, QueueJobOutput } from '@velajs/vela/queue';

export const welcome = defineQueueJob('welcome', z.object({
  userId: z.string(),
  age: z.string().transform(Number),
}));

@Processor('email')
@Injectable()
class EmailProcessor {
  @Process(welcome)
  async send(job: QueueJob<QueueJobOutput<typeof welcome>>) {
    // job.data.age is a validated number.
  }
}

await client.add(welcome, { userId: 'u1', age: '20' });
```

The typed overload checks the input, snapshots it with `structuredClone`, and
awaits validation before sending. Validation receives a separate clone so
mutating validators cannot change the wire snapshot. Transport carries the
original input shape; each processor validates it into output before invoking
the method. Async schemas are supported. Schemas should be deterministic and
free of external side effects because producer and consumer both validate.
Typed jobs must be structured-cloneable. Legacy `add(name, data)` and
`@Process(name)` retain their existing behavior without automatic validation.

The decorator checks the annotated handler's job type. Use `QueueJobInput<D>` for
producer payload types and `QueueJobOutput<D>` for processor payload types.
Validation failures propagate through declared processor filters; a filter that
claims an error treats that delivery as handled. A valid payload does not confer
trusted principal or tenant identity.

## Cloudflare bridge

Native `Queue<T>` bindings and `@QueueConsumer` remain independently usable. The
optional `@velajs/cloudflare/queue` helpers connect native delivery to portable processors:

```ts
import { Container, EntrypointRegistry, Inject, Injectable } from '@velajs/vela';
import { QueueModule, dispatchQueueJob } from '@velajs/vela/queue';
import { QueueConsumer } from '@velajs/cloudflare';
import { cloudflareQueueDriver, consumeQueueBatch } from '@velajs/cloudflare/queue';

// ENV is an InjectionToken for the native Workers environment.
QueueModule.forRootAsync({
  queues: ['email'],
  inject: [ENV],
  useFactory: (env) => ({ driver: cloudflareQueueDriver({ email: env.EMAIL_QUEUE }) }),
});

@Injectable()
class NativeEmailConsumer {
  constructor(
    @Inject(Container) private readonly container: Container,
  ) {}

  @QueueConsumer('email-production')
  async consume(batch: MessageBatch<unknown>) {
    await consumeQueueBatch(batch, (job) =>
      dispatchQueueJob(this.container, this.container.resolve(EntrypointRegistry), job, { unhandled: 'error' }),
      { queue: 'email' },
    );
  }
}
```

Register the consumer and processors in ordinary module providers and configure
Wrangler's producer/consumer bindings. `queue` maps the physical queue to its
logical name; mismatched envelopes fail. The bridge validates envelope fields
and uses native delivery attempts, preserving the producer job ID for application
idempotency. Native send is awaited and failures propagate without hidden retries.
`delayMs` rounds up to whole seconds; zero explicitly disables a configured delay.

Every message is attempted. Success is acknowledged only after the callback
finishes; failures remain unsettled and are rethrown after the batch is tried.
The callback can explicitly call `message.retry({ delaySeconds })` or
`message.ack()` through its second argument; first settlement wins. Returning
`{ handled: 0 }` fails instead of silently dropping a message. The portable
dispatcher also offers opt-in `{ unhandled: 'error' }`; its legacy default remains
unchanged. Every matching processor settles before portable dispatch resolves or
rejects. If one processor fails, previously successful processors may run again
on redelivery: business operations must handle duplicates.

Keep all delivery-critical work awaited by the callback. The bridge does not
schedule background sends, claim exactly-once delivery, configure retries/DLQs,
or implement a durable outbox. [Cloudflare settlement rules](https://developers.cloudflare.com/queues/configuration/batching-retries/)
and native queue configuration determine redelivery.


## Module and invocation isolation

Processor discovery retains each owning module, including multiple keyed
instances of the same module/processor class. Async options and declared guards,
interceptors, and filters resolve from that owner. Processors with request scope
are constructed after guards pass. Each matching processor runs inside the
shared managed invocation scope: registered deferred work finishes before scope
disposal and before delivery succeeds or fails. A deferred failure rejects the
delivery; it is not hidden behind acknowledgement.
