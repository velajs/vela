# Queues (`@velajs/vela/queue`)

Job queues live on the **subpath** `@velajs/vela/queue` (deliberately off the main barrel to avoid colliding with `@velajs/cloudflare`'s own queue types). Registration is Nest/BullMQ-shaped: one driver per application, queues registered where they are used. Transport configuration materializes at bootstrap, so registrations are validated before any event arrives.

## Setup — `forRoot` once, `registerQueue` per feature

```ts
import { QueueModule } from '@velajs/vela/queue';
import { cloudflareQueues } from '@velajs/cloudflare/queues';

// root module: the application's driver (global)
@Module({ imports: [QueueModule.forRoot({ driver: cloudflareQueues() }), EmailModule] })
class AppModule {}

// feature module: the queue it produces/processes
@Module({
  imports: [QueueModule.registerQueue({ name: 'email', binding: 'EMAIL_QUEUE' })],
  providers: [SignupService, EmailProcessor],
})
class EmailModule {}
```

- `QueueModule.forRoot({ driver?, dispatch? })` is global and imported **once** per application. The driver and a signed dispatch policy compare by reference: re-importing the same objects deduplicates; a different driver instance or another signed policy object (a different target, method or TTL, even one a helper builds from the same source) fails bootstrap. `driver` defaults to `inline()`. `forRootAsync({ inject, useFactory })` resolves the same options; its options object is the configuration, so a different one, or a `forRoot` next to it, fails bootstrap.
- A driver may be an instance or a factory `(context: QueueDriverContext) => QueueDriver`; the factory receives the application's `ENV` (when a runtime seeded one) and its `QueueRegistry`, and builds a fresh driver per application. Use `driver: () => inline()` when reusing module declarations across applications; one bound driver instance belongs to one application.
- `QueueModule.registerQueue({ name, binding?, consumer? }, ...more)` provides each queue's `QueueClient`. Registering one queue in several modules is fine (merged by name, one shared client); two different `binding`s for one name fail bootstrap. A registration without `forRoot` in the app fails bootstrap.
  - `name` — logical queue: `@InjectQueue(name)`, `@Processor(name)` and every job's `queue`.
  - `binding` — the transport binding the driver sends through (Workers: a Wrangler `queues.producers[].binding`, read from `ENV` when a job is added). Omit it where a module only consumes.
  - `consumer` — optional physical queue pin (Workers): the queue's jobs are accepted only from it, and it carries only the queues pinned to it.
- `QueueRegistry` (exported by `forRoot`) lists the merged registrations; each is also published as a `queue:registration` entrypoint for `vela deploy check`.

There is no `queues` list on `forRoot`; that API was removed in favor of `registerQueue`.

## Processors — `@Processor` / `@Process`

A processor is a normal `@Injectable()` provider (listed in `providers`, not a special array). `@Processor(queueName)` binds the class to a queue; `@Process(jobName?)` marks a handler for a named job (omit the name for the wildcard/fallback handler):

```ts
import { Processor, Process } from '@velajs/vela/queue';
import type { QueueJob } from '@velajs/vela/queue';

@Processor('email')
@Injectable()
class EmailProcessor {
  @Process('welcome')
  welcome(job: QueueJob<{ userId: string }>) { /* handle welcome email */ }

  @Process()                       // fallback: any 'email' job with no named handler
  fallback(job: QueueJob) { /* ... */ }
}
```

Named handlers win over the wildcard. Registering `@Processor` also declares the `'queue'` entrypoint kind so platform adapters can find processors.

## Enqueuing — `@InjectQueue` + `QueueClient`

```ts
import { InjectQueue, type QueueClient } from '@velajs/vela/queue';

@Injectable()
class SignupService {
  constructor(@InjectQueue('email') private readonly email: QueueClient) {} // = @Inject(queueToken('email'))

  async register(userId: string) {
    await this.email.add('welcome', { userId });            // jobName, data
    await this.email.add('digest', {}, { delayMs: 60_000 }); // optional delay
    await this.email.addBulk([
      { job: 'welcome', data: { userId: 'a' } },
      { job: 'welcome', data: { userId: 'b' } },
    ]);
  }
}
```

`add(jobName | definition, data, { delayMs? })` resolves once the **driver** accepts the job (not once it's processed). Each job gets a `crypto.randomUUID()` id. `addBulk([{ job, data, options? }])` entries mirror `add()` (not BullMQ's `{ name, data, opts }`) and are typed per entry, so typed and named jobs with different payloads can share one call. It validates every typed job first, then uses the driver's optional `enqueueBatch` (or enqueues sequentially); it resolves only when every job was accepted, else rejects with `QueueBatchError` (`accepted` / `rejected` job ids — retry only `rejected`).

## Drivers

The default `inline()` driver runs in-process — edge-pure, no timers. Modes: `'immediate'` (deliver on a microtask after enqueue) or `'manual'` (buffer until `flush()`, deterministic for tests):

```ts
import { inline } from '@velajs/vela/queue';

const driver = inline({ mode: 'manual' });
// ... QueueModule.forRoot({ driver }), QueueModule.registerQueue({ name: 'email' })
await driver.flush();   // deliver all buffered jobs; returns the count
```

Platform drivers implement the `QueueDriver` interface (`enqueue`, optional `enqueueBatch`, `bind`, `consume`, `entrypoints`).

## Cloudflare Queues — `cloudflareQueues()`

`cloudflareQueues()` from `@velajs/cloudflare/queues` is the Workers driver:

- Producing reads `ENV[binding]` per send (never at module scope), checks it has `send()`, and awaits it. `delayMs` rounds up to seconds. `addBulk` uses `sendBatch` in calls of ≤100 messages and an estimated ≤256 KB; a job estimated over 128 KB is rejected before anything is sent. A partial failure rejects with `QueueBatchError`.
- Delivery needs no mapping: the Worker `queue()` handler gives batches no `@QueueConsumer` claims to `QueueModule`, which routes each message by the envelope's logical `queue` (several logical queues may share one physical queue) through the module's dispatch policy. Success acks after processors and managed work settle; non-envelope messages, unregistered queues, unhandled jobs and failures stay unacked (retry → dead-letter).
- Raw `@QueueConsumer(physicalQueue)` handlers keep their physical queue; bootstrap rejects a physical queue claimed by both a `@QueueConsumer` and a registration `consumer`.
- `vela deploy check` verifies registered bindings against Wrangler `queues.producers`, and that each processed queue has a `queues.consumers` entry (derived from `consumer` or the binding's producer queue). It fails when a `@QueueConsumer` claims a physical queue a processed or pinned registration uses (`queue-consumer-claimed-by-raw`), when an unpinned queue's producer sends to a physical queue pinned by other registrations (`queue-sent-to-pinned-queue`), and when a pinned queue's producer binding sends outside its own pins (`queue-producer-outside-pins`).
- A raw `@QueueConsumer` owns its physical queue and must not carry jobs of registered queues: they reach their `@Processor` only if the raw handler dispatches them itself, and the adapter warns once when it sees them. Deliver registered queues through `cloudflareQueues()`. Each native delivery failure is reported once to the exception handler.

## Signed dispatch

`QueueModule.forRoot({ driver, dispatch: { kind: 'signed', target: (job) => ({ path: '/jobs/email' }) } })` delivers every job by re-entering a `@SignedInvocation()` route (job as body) instead of calling processors, so the full request pipeline — including global guards — runs. It applies to every delivery through the module, native Cloudflare deliveries included.

## Validated jobs

`defineQueueJob(name, schema)` connects `QueueClient.add(definition, wireInput)`
with `@Process(definition)` and `QueueJobOutput<typeof definition>`. The producer
validates a snapshot and sends the original wire input; the consumer parses it
into handler data. Async transforms execute once at each boundary. Legacy
string job names remain supported. Native retry and DLQ configuration belongs to
Cloudflare; settlement observation (`observeMessage`) records the first
successful ack/retry and does not prove that a DLQ received a delivery.

## Dispatching a single job

`dispatchQueueJob(container, entrypoints, job)` is the delivery entry point for tests and for custom transports other than Cloudflare Queues (`cloudflareQueues()` delivers registered queues itself; never bridge a raw `@QueueConsumer` to processors with it). In an app with `QueueModule.forRoot()` it goes through `QueueDispatchBinding` exactly like a native delivery: the job's queue must be registered, and signed dispatch re-enters the signed route, so its global guards run and a custom transport cannot bypass them. Without a `QueueModule` it calls the processors directly:

```ts
import { dispatchQueueJob } from '@velajs/vela/queue';

const result = await dispatchQueueJob(app.getContainer(), app.entrypoints, {
  id: '1', queue: 'email', name: 'welcome', data: { userId: 'u1' }, attempt: 1,
});
// result.handled === number of handlers that ran (1 for a signed re-entry)
```

## Pipeline note

Queue dispatch runs handler-scoped guards/interceptors/filters through the shared `PipelineRunner` (`getType() === 'queue'`), but **app-wide `APP_*` components deliberately do NOT apply** — a documented divergence from the WebSocket dispatcher, matching native Cloudflare queue consumers. (Scheduled jobs differ: they run no guards/interceptors/filters at all; see `schedule-and-cron.md`.) If you need cross-cutting behavior on queue jobs, use scoped components (`@UseGuards`, `@UseInterceptors` on the processor), not `APP_*`, or signed dispatch.

Dispatch preserves each registration's module owner, resolves handlers and
components asynchronously, and drains managed invocation work before disposing
its child. Payload fields never grant trusted principal or tenant authority.
