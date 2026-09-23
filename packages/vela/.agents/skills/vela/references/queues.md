# Queues (`@velajs/vela/queue`)

Job queues live on the **subpath** `@velajs/vela/queue` (deliberately off the main barrel to avoid colliding with `@velajs/cloudflare`'s own queue types). The module is lazy.

## Setup

```ts
import { QueueModule } from '@velajs/vela/queue';

@Module({
  imports: [QueueModule.forRoot({ queues: ['email'] })],  // queues is structural/required
  providers: [EmailProcessor],
})
class AppModule {}
```

`QueueModuleOptions`: `queues?: string[]` (must be known at `forRoot`/`forRootAsync` call time; missing/empty throws) and `driver?: QueueDriver | (() => QueueDriver)` (defaults to the in-core `inline()` driver). Use `driver: () => inline()` when reusing module definitions across applications; one bound driver instance belongs to one application. `forRootAsync({ queues: [...], inject: [], useFactory: () => ({ driver }) })` is also available — pass `queues` alongside the factory.

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

## Enqueuing — `queueToken` + `QueueClient`

Inject the queue's client with `queueToken(name)` and enqueue with `add`:

```ts
import { queueToken, QueueClient } from '@velajs/vela/queue';

@Injectable()
class SignupService {
  constructor(@Inject(queueToken('email')) private readonly email: QueueClient) {}

  async register(userId: string) {
    await this.email.add('welcome', { userId });          // jobName, data
    await this.email.add('digest', {}, { delayMs: 60_000 }); // optional delay
  }
}
```

`add(jobName, data, { delayMs? })` resolves once the **driver** accepts the job (not once it's processed). Each job gets a `crypto.randomUUID()` id.

## Drivers

The default `inline()` driver runs in-process — edge-pure, no timers. Modes: `'immediate'` (deliver on a microtask after enqueue) or `'manual'` (buffer until `flush()`, deterministic for tests):

```ts
import { inline } from '@velajs/vela/queue';

const driver = inline({ mode: 'manual' });
// ... QueueModule.forRoot({ queues: ['email'], driver })
await driver.flush();   // deliver all buffered jobs; returns the count
```

Platform drivers (e.g. Cloudflare Queues via `@velajs/cloudflare`) implement the `QueueDriver` interface.

## Validated jobs and native queues

`defineQueueJob(name, schema)` connects `QueueClient.add(definition, wireInput)`
with `@Process(definition)` and `QueueJobOutput<typeof definition>`. The producer
validates a snapshot and sends the original wire input; the consumer parses it
into handler data. Async transforms execute once at each boundary. Legacy
string job names remain supported.

The optional `@velajs/cloudflare/queue` subpath provides native queue helpers.
Keep logical job routing separate from physical queue bindings. Native retry
and DLQ configuration belongs to Cloudflare; settlement observation records the
first successful ack/retry and does not prove that a DLQ received a delivery.
See the package guide for exact helper options.

## Dispatching a single job

`dispatchQueueJob(container, entrypoints, job)` is the low-level delivery primitive both the inline driver and platform adapters call:

```ts
import { dispatchQueueJob } from '@velajs/vela/queue';

const result = await dispatchQueueJob(app.getContainer(), app.entrypoints, {
  id: '1', queue: 'email', name: 'welcome', data: { userId: 'u1' }, attempt: 1,
});
// result.handled === number of handlers that ran
```

## Pipeline note

Queue dispatch runs handler-scoped guards/interceptors/filters through the shared `PipelineRunner` (`getType() === 'queue'`), but **app-wide `APP_*` components deliberately do NOT apply** — a documented divergence from the WebSocket dispatcher, matching native Cloudflare queue consumers. (Scheduled jobs differ: they run no guards/interceptors/filters at all; see `schedule-and-cron.md`.) If you need cross-cutting behavior on queue jobs, use scoped components (`@UseGuards`, `@UseInterceptors` on the processor), not `APP_*`.

Dispatch preserves each registration's module owner, resolves handlers and
components asynchronously, and drains managed invocation work before disposing
its child. Payload fields never grant trusted principal or tenant authority.
