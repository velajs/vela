import './vela-env';
/**
 * `@velajs/cloudflare/queues`: the Cloudflare Queues driver for
 * `@velajs/vela/queue`. Native bindings and `@QueueConsumer` need no import
 * from here.
 */
export { cloudflareQueues, consumeQueueBatch } from './queue/cloudflare-queues';
export type { CloudflareQueueProducer, ConsumeQueueBatchOptions } from './queue/cloudflare-queues';
