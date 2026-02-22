import 'reflect-metadata';

const QUEUE_CONSUMER_METADATA_KEY = 'cloudflare:queue-consumer';

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
    // Use getOwnMetadata to avoid inheriting metadata from parent classes
    const existing: QueueConsumerMetadata[] =
      Reflect.getOwnMetadata(QUEUE_CONSUMER_METADATA_KEY, target.constructor) ?? [];
    existing.push({ queueName, methodName: String(propertyKey) });
    Reflect.defineMetadata(QUEUE_CONSUMER_METADATA_KEY, existing, target.constructor);
  };
}

export function getQueueConsumerMetadata(target: object): QueueConsumerMetadata[] {
  const ctor = target.constructor ?? target;
  return Reflect.getOwnMetadata(QUEUE_CONSUMER_METADATA_KEY, ctor) ?? [];
}
