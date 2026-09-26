import {
  consumeQueueEvents,
  defineQueueEvent,
  type QueueEventHandler,
} from '@velajs/cloudflare/queue-events';
import { z } from 'zod';

const handler = defineQueueEvent({
  type: 'cf.workersBuilds.worker.build.succeeded',
  source: { type: 'workersBuilds.worker', workerName: 'example-worker' },
  schema: z.object({ buildUuid: z.string() }).transform((payload) => ({ id: payload.buildUuid })),
  handle(event, delivery) {
    const id: string = event.payload.id;
    const nativeId: string = delivery.messageId;
    const version: 1 = event.metadata.eventSchemaVersion;
    const selector: unknown = event.source.workerName;
    // @ts-expect-error handler receives schema output rather than unchecked input
    event.payload.buildUuid;
    // @ts-expect-error handlers cannot acknowledge before their own completion
    delivery.ack();
    void [id, nativeId, version, selector];
  },
});
const handlers: readonly QueueEventHandler[] = [
  handler,
  defineQueueEvent({
    type: 'cf.r2.bucket.created',
    source: { type: 'r2' },
    schema: z.object({ name: z.string() }),
    handle(event) {
      const name: string = event.payload.name;
      void name;
    },
  }),
];

export function publishedQueueEvents(batch: MessageBatch<unknown>): Promise<void> {
  return consumeQueueEvents(batch, {
    queue: 'platform-events',
    accountId: 'example-account',
    eventSubscriptionIds: ['example-subscription'],
    handlers,
  });
}
