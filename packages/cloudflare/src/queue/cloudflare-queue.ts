import { observeMessage, parseQueueJob } from '@velajs/vela/queue';
import type {
  QueueDispatchResult,
  QueueDriver,
  QueueJob,
  QueueMessageLike,
} from '@velajs/vela/queue';

/** Logical queue names mapped to native producer bindings from this application's environment. */
export interface CloudflareQueueProducer {
  // Both older void-returning bindings and current metric-returning bindings work.
  send(message: QueueJob, options?: QueueSendOptions): Promise<unknown>;
}
export type CloudflareQueueBindings = Readonly<Record<string, CloudflareQueueProducer>>;

/** Native sends are awaited. No buffering, implicit retry, or deferred error handling. */
export function cloudflareQueueDriver(bindings: CloudflareQueueBindings): QueueDriver {
  const queues = new Map(Object.entries(bindings));
  return {
    kind: 'cloudflare',
    async enqueue(job, options) {
      const queue = queues.get(job.queue);
      if (!queue) throw new Error(`No Cloudflare producer binding for queue '${job.queue}'.`);
      const delayMs = options?.delayMs;
      if (
        delayMs !== undefined &&
        (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 86_400_000)
      ) {
        throw new RangeError('Queue delayMs must be between 0 and 86400000.');
      }
      await queue.send(
        parseQueueJob(job),
        delayMs === undefined ? undefined : { delaySeconds: Math.ceil(delayMs / 1000) },
      );
    },
  };
}

export interface ConsumeQueueBatchOptions {
  /** Logical queue name. Defaults to the native batch queue name. */
  queue?: string;
}

/**
 * Bridge native messages to portable dispatch. Attempts come from the host.
 * Process every message; ack successful/unsettled deliveries, then rethrow any
 * failures so the host retries the unsettled remainder. Explicit settlement wins.
 * The callback must await all work that should determine delivery success.
 */
export async function consumeQueueBatch(
  batch: { readonly queue: string; readonly messages: readonly QueueMessageLike[] },
  dispatch: (job: QueueJob, message: QueueMessageLike) => Promise<QueueDispatchResult | void>,
  options: ConsumeQueueBatchOptions = {},
): Promise<void> {
  const errors: unknown[] = [];
  const queue = options.queue ?? batch.queue;
  for (const message of batch.messages) {
    try {
      const job = parseQueueJob(message.body, message.attempts);
      if (job.queue !== queue)
        throw new Error(`Queue envelope '${job.queue}' does not match '${queue}'.`);
      const observed = observeMessage(message);
      const result = await dispatch(job, observed.message);
      if (result?.handled === 0) throw new Error(`Queue job '${job.name}' has no handler.`);
      if (observed.disposition().outcome === 'unsettled') observed.message.ack();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Queue batch deliveries failed.');
}
