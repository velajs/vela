import { observeMessage, parseQueueJob } from '@velajs/vela/queue';
import type {
  QueueDispatchFn,
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

export interface CloudflareQueueDriverOptions {
  /** Physical delivery queue name -> logical QueueModule name. */
  consumers?: Readonly<Record<string, string>>;
  /** Logical queue -> Wrangler producer binding name, for deployment inspection. */
  producerBindings?: Readonly<Record<string, string>>;
}

function nativeBatch(payload: unknown): {
  queue: string;
  messages: QueueMessageLike[];
} {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('queue' in payload) ||
    typeof payload.queue !== 'string' ||
    !('messages' in payload) ||
    !Array.isArray(payload.messages)
  )
    throw new TypeError('Invalid native queue batch.');
  const messages: QueueMessageLike[] = [];
  for (const message of payload.messages as unknown[]) {
    if (
      typeof message !== 'object' ||
      message === null ||
      !('body' in message) ||
      !('ack' in message) ||
      typeof message.ack !== 'function' ||
      !('retry' in message) ||
      typeof message.retry !== 'function' ||
      !('id' in message) ||
      typeof message.id !== 'string' ||
      !('timestamp' in message) ||
      !(message.timestamp instanceof Date) ||
      !('attempts' in message) ||
      typeof message.attempts !== 'number'
    )
      throw new TypeError('Invalid native queue message.');
    messages.push(message as QueueMessageLike);
  }
  return { queue: payload.queue, messages };
}

/**
 * Native sends are awaited. No buffering, implicit retry, or deferred error handling.
 * Only a driver with `consumers` consumes through QueueModule, so signed module
 * dispatch without a consumer mapping fails at bootstrap instead of being skipped.
 */
export function cloudflareQueueDriver(
  bindings: CloudflareQueueBindings,
  options: CloudflareQueueDriverOptions = {},
): QueueDriver {
  const queues = new Map(Object.entries(bindings));
  const consumers = new Map(Object.entries(options.consumers ?? {}));
  for (const [physical, logical] of consumers) {
    if (!physical.trim() || !logical.trim())
      throw new TypeError('Queue mapping names must not be empty.');
  }
  const producerBindings = Object.entries(options.producerBindings ?? {});
  for (const [logical, binding] of producerBindings) {
    if (!queues.has(logical) || !binding.trim())
      throw new TypeError('Invalid queue producer binding declaration.');
  }
  return {
    kind: 'cloudflare',
    entrypoints: [
      ...[...consumers].map(([queueName, queue]) => ({
        kind: 'cf:queue:module',
        queue,
        meta: { queueName, logicalQueue: queue },
      })),
      ...producerBindings.map(([queue, binding]) => ({
        kind: 'cf:queue:producer',
        queue,
        meta: { logicalQueue: queue, binding },
      })),
    ],
    ...(consumers.size > 0
      ? {
          async consume(payload: unknown, dispatch: QueueDispatchFn): Promise<void> {
            const batch = nativeBatch(payload);
            const queue = consumers.get(batch.queue);
            if (!queue) throw new Error(`No consumer mapping for queue '${batch.queue}'.`);
            await consumeQueueBatch(batch, (job) => dispatch(job), { queue });
          },
        }
      : {}),
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
