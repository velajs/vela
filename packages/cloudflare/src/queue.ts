/** Optional portable-job bridge; native bindings and consumers need no bridge import. */
export { cloudflareQueueDriver, consumeQueueBatch } from './queue/cloudflare-queue';
export type {
  CloudflareQueueBindings,
  CloudflareQueueProducer,
  ConsumeQueueBatchOptions,
} from './queue/cloudflare-queue';
