import { defineMetadata, getMetadata, registerEntrypointKind } from '@velajs/vela';

const QUEUE_CONSUMER_METADATA_KEY = 'cloudflare:queue-consumer';

// Open entrypoint kind: any adapter can enumerate queue consumers via
// `app.entrypoints.ofKind('cf:queue')` — declared here, next to the decorator,
// with zero vela-core involvement.
registerEntrypointKind({ kind: 'cf:queue', metaKey: QUEUE_CONSUMER_METADATA_KEY, level: 'method' });

export interface QueueConsumerMetadata {
  queueName: string;
  methodName: string;
}

/**
 * Marks a method as a queue consumer handler.
 *
 * @example
 * ```ts
 * @Injectable()
 * class WorkerService {
 *   @QueueConsumer('email-queue')
 *   async processEmails(batch: MessageBatch) {
 *     for (const msg of batch.messages) {
 *       console.log('Processing:', msg.body);
 *       msg.ack();
 *     }
 *   }
 * }
 * ```
 */
export function QueueConsumer(queueName: string): MethodDecorator {
  return (target: object, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
    const existing: QueueConsumerMetadata[] =
      (getMetadata(QUEUE_CONSUMER_METADATA_KEY, target.constructor) as QueueConsumerMetadata[]) ??
      [];
    existing.push({ queueName, methodName: String(propertyKey) });
    defineMetadata(QUEUE_CONSUMER_METADATA_KEY, existing, target.constructor);
  };
}

export function getQueueConsumerMetadata(target: object): QueueConsumerMetadata[] {
  const ctor = target.constructor ?? target;
  return (getMetadata(QUEUE_CONSUMER_METADATA_KEY, ctor) as QueueConsumerMetadata[]) ?? [];
}
