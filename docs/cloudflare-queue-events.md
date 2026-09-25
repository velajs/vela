# Cloudflare platform events through Queues

`@velajs/cloudflare/queue-events` validates Cloudflare event subscription messages
inside an existing `@QueueConsumer`. It has no Module, producer, provisioning API,
or alternative queue host. Use it for the documented platform-event envelope;
`@velajs/cloudflare/queues` remains the driver for Vela jobs.

## A Worker build consumer

The first example uses the documented
[`cf.workersBuilds.worker.build.succeeded` envelope](https://developers.cloudflare.com/queues/event-subscriptions/events-schemas/#buildsucceeded).
Its `source` is `{ type: 'workersBuilds.worker', workerName: ... }`; `payload`
contains `buildUuid`, `status`, `buildOutcome`, timestamps and build trigger metadata.
The common `metadata` contains `accountId`, `eventSubscriptionId`,
`eventSchemaVersion` and `eventTimestamp`. These are Cloudflare's names, not Vela
job fields. The validator below selects the payload fields this consumer needs.

```ts
import { Injectable, Module } from '@velajs/vela';
import { createCloudflareWorker, QueueConsumer } from '@velajs/cloudflare';
import { consumeQueueEvents, defineQueueEvent } from '@velajs/cloudflare/queue-events';
import { z } from 'zod';

@Injectable()
class BuildEvents {
  @QueueConsumer('platform-events')
  consume(batch: MessageBatch<unknown>): Promise<void> {
    return consumeQueueEvents(batch, {
      queue: 'platform-events',
      accountId: '00000000000000000000000000000000',
      eventSubscriptionIds: ['11111111111111111111111111111111'],
      handlers: [defineQueueEvent({
        type: 'cf.workersBuilds.worker.build.succeeded',
        source: { type: 'workersBuilds.worker', workerName: 'example-worker' },
        schema: z.object({ buildUuid: z.string().min(1), status: z.literal('success') }),
        async handle(event, delivery) {
          // Await application work here. Use an idempotent sink for durable effects.
          console.log(event.payload.buildUuid, delivery.messageId, delivery.attempts);
        },
      })],
    });
  }
}

@Module({ providers: [BuildEvents] })
class App {}
export default createCloudflareWorker(App);
```

Register the provider in the application that consumes this physical queue. Bind
one `@QueueConsumer` to it and return/await `consumeQueueEvents`; do not also
settle its batch or messages. Read deployed account/subscription expectations
from that application's injected environment when needed, rather than sharing
mutable configuration between environments. Configure the native subscription,
queue consumer, retry limit and DLQ separately using
[Cloudflare's subscription setup](https://developers.cloudflare.com/queues/event-subscriptions/manage-event-subscriptions/).
The identifiers above are synthetic placeholders.

Each handler requires a Standard Schema validator (Zod, Valibot, or another
compatible library), and receives its validated **output**, including async
validation and transforms. `source.type` and every supplied source selector must
match exactly. Additional source/metadata fields are allowed and remain `unknown`
until the application validates them. Account and subscription IDs are opaque
strings; no UUID or hex format is imposed. Only event schema version `1` is
supported. Event timestamps must be ISO date-time strings with seconds and a
UTC/offset timezone. Unknown versions and unregistered types are failures, never
silently ignored. Declare one handler per exact type; source selectors can narrow
that handler to a Worker, domain, or other documented source scope.

Other event families use the same `defineQueueEvent` seam with their own payload
validators and selectors. For example,
[Browser Run crawl events](https://developers.cloudflare.com/queues/event-subscriptions/events-schemas/#browser-run)
use `source.type: 'browserRun'` and payload `jobId`;
[Email Sending lifecycle events](https://developers.cloudflare.com/queues/event-subscriptions/events-schemas/#email-sending)
use `source.type: 'email.sending'`, `zoneId`/`domain` source selectors and payload
`eventId`/`messageId`. There is no bundled schema catalog and these payloads are
not inferred from an event-name string. Email Sending events are distinct from
inbound Email Routing delivery.

## Settlement and errors

The helper processes messages sequentially within a batch. It awaits each
validator and handler, then calls that message's native `ack()`. Malformed
bodies, unknown versions/types, mismatched source/account/subscription, invalid
payloads and thrown/rejected handlers each call native `retry()` without a delay
override. Remaining messages are still attempted. Finally,
`QueueEventsBatchError` rejects with `failures: { messageId, error }[]`;
`error.code` distinguishes the failures and validation/handler errors retain
their cause. Queue/bad-configuration errors reject before effects and leave all
messages unsettled. Errors can be reported through the existing queue entrypoint
error reporting; avoid logging sensitive payloads indiscriminately.

Successful siblings remain acknowledged even though the batch rejects. Retry
limits, configured retry delay and dead-letter routing remain Cloudflare's
responsibility. At retry exhaustion the platform sends failures to the configured
DLQ, or deletes them if no DLQ exists. There is no application drop/ack-on-failure
policy in this helper. Catching its batch error does not cancel the explicit
retries. See [native acknowledgement and retry semantics](https://developers.cloudflare.com/queues/configuration/batching-retries/).

## Identity, trust and delivery limits

`delivery.messageId`, `timestamp` and `attempts` expose native queue delivery
metadata. Payload schemas can preserve source identifiers such as `buildUuid`,
`eventId` and `jobId`. The documented envelope has no universal platform event ID;
a build/job ID can identify several lifecycle events. Choose an application
idempotency key that includes the relevant event type and scope. Neither a
repeated native ID nor a repeated payload ID causes this helper to suppress a
handler. Queue delivery is [at least once](https://developers.cloudflare.com/queues/reference/delivery-guarantees/),
and acknowledgements do not make database writes or external effects exactly
once. Use atomic idempotency enforcement appropriate to those effects; a crash
between an effect and acknowledgement can repeat the effect.

Metadata validation is **not authentication**. A producer with permission to
write to the queue can fabricate these fields. Use a dedicated physical queue,
restrict producer/API permissions to trusted principals and the intended
subscription, and keep it separate from signed Vela job queues. Never assert or
convert these account events into `QueueJob` envelopes or send them through
`dispatchQueueJob` as trusted jobs. Raw queue dispatch does not authenticate a
platform event through Vela's signed HTTP invocation path.

Unit fixtures reproduce the published Worker build schema with synthetic values.
Workerd tests exercise native message settlement, raw `@QueueConsumer` dispatch,
partial failures, duplicate handling, per-environment/request isolation and
separation from signed job dispatch. They do **not** prove account-origin delivery,
producer permissions, subscription provisioning, retry scheduling or actual DLQ
routing. A separate deployed acceptance check must create a real subscription in
a test account, trigger a Worker build, observe the delivered envelope and
identifiers, verify configured failures reach the DLQ, and audit producer access.
No account resources are provisioned by this package or its local tests.
