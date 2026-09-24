import { observeMessage, parseQueueJob, QueueBatchError } from '@velajs/vela/queue';
import { resolveBinding } from '@velajs/vela/module-kit';
import { QUEUE_PRODUCER } from '../bindings';
import type {
  AddJobOptions,
  QueueDispatchFn,
  QueueDispatchResult,
  QueueDriver,
  QueueDriverContext,
  QueueDriverFactory,
  QueueEnqueueRequest,
  QueueJob,
  QueueMessageLike,
} from '@velajs/vela/queue';

/** The native producer surface the driver uses: a Wrangler `queues.producers` binding. */
export interface CloudflareQueueProducer {
  // Both older void-returning bindings and current metric-returning bindings work.
  send(message: QueueJob, options?: QueueSendOptions): Promise<unknown>;
  sendBatch?(messages: Iterable<MessageSendRequest<QueueJob>>): Promise<unknown>;
}

/** The Cloudflare Queues send limits `addBulk` is chunked to (bytes are decimal kilobytes). */
export const QUEUE_SEND_LIMITS = Object.freeze({
  /** Messages per `sendBatch` call. */
  messages: 100,
  /** Estimated bytes per `sendBatch` call. */
  batchBytes: 256_000,
  /** Estimated bytes per message. */
  messageBytes: 128_000,
});

/** Allowance for the platform's per-message framing on top of the body estimate. */
const MESSAGE_MARGIN_BYTES = 256;
const MAX_DELAY_MS = 86_400_000;

/**
 * A string's size as JSON (UTF-8, quoted, escaped) or as V8 serializes it
 * (one byte per character, two for a string holding any character above
 * U+00FF), whichever is larger.
 */
function stringBytes(text: string): number {
  let json = 2;
  let wide = false;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code > 0xff) wide = true;
    if (code < 0x20) json += 6;
    else if (code === 0x22 || code === 0x5c) json += 2;
    else if (code < 0x80) json += 1;
    else if (code < 0x800) json += 2;
    else if (code >= 0xd800 && code <= 0xdfff) json += 2;
    else json += 3;
  }
  return Math.max(json, (wide ? text.length * 2 : text.length) + 5);
}

function measure(value: unknown, seen: Set<object>): number {
  switch (typeof value) {
    case 'string':
      return stringBytes(value);
    case 'number':
      return Math.max(String(value).length, 9);
    case 'bigint':
      return String(value).length + 9;
    case 'boolean':
      return 5;
    case 'object':
      break;
    default:
      return 9;
  }
  if (value === null) return 4;
  // V8 serializes a repeated reference as a back-reference.
  if (seen.has(value)) return 9;
  seen.add(value);
  let bytes = 2;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    bytes += value.byteLength + 9;
  } else if (value instanceof Date) {
    bytes += 26;
  } else if (value instanceof Map) {
    for (const [key, item] of value) bytes += measure(key, seen) + measure(item, seen) + 2;
  } else if (value instanceof Set) {
    for (const item of value) bytes += measure(item, seen) + 1;
  } else if (Array.isArray(value)) {
    for (const item of value) bytes += measure(item, seen) + 1;
  } else {
    for (const key of Object.keys(value)) {
      bytes += stringBytes(key) + measure(Reflect.get(value, key), seen) + 2;
    }
  }
  return bytes;
}

/**
 * A conservative size estimate of one native queue message: the larger of the
 * body's JSON and V8 sizes, plus a per-message margin.
 */
export function estimateQueueMessageBytes(body: unknown): number {
  return measure(body, new Set()) + MESSAGE_MARGIN_BYTES;
}

function delaySeconds(options: AddJobOptions | undefined): number | undefined {
  const delayMs = options?.delayMs;
  if (delayMs === undefined) return undefined;
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > MAX_DELAY_MS) {
    throw new RangeError('Queue delayMs must be between 0 and 86400000.');
  }
  return Math.ceil(delayMs / 1000);
}


function nativeBatch(payload: unknown): { queue: string; messages: QueueMessageLike[] } {
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

interface PreparedMessage {
  readonly id: string;
  readonly queue: string;
  readonly bytes: number;
  readonly request: MessageSendRequest<QueueJob>;
}

/** Split in order: a new call starts at 100 messages, at the byte budget, or at another queue. */
function chunk(messages: readonly PreparedMessage[]): PreparedMessage[][] {
  const chunks: PreparedMessage[][] = [];
  let current: PreparedMessage[] = [];
  let bytes = 0;
  for (const message of messages) {
    if (
      current.length > 0 &&
      (current.length === QUEUE_SEND_LIMITS.messages ||
        bytes + message.bytes > QUEUE_SEND_LIMITS.batchBytes ||
        current[0]!.queue !== message.queue)
    ) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(message);
    bytes += message.bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function createDriver({ env, queues }: QueueDriverContext): QueueDriver {
  // Physical queue -> the logical queues registrations pin to it.
  const pins = new Map<string, string[]>();
  for (const queue of queues.all()) {
    for (const physical of queue.consumers) {
      pins.set(physical, [...(pins.get(physical) ?? []), queue.name]);
    }
  }

  // Resolved on every send from this application's ENV, never cached.
  const producerFor = (name: string): CloudflareQueueProducer => {
    const registration = queues.get(name);
    if (!registration) {
      throw new Error(
        `Queue '${name}' is not registered. Add QueueModule.registerQueue({ name: '${name}', ` +
          `binding }) to the module that produces it.`,
      );
    }
    if (registration.binding === undefined) {
      throw new Error(
        `Queue '${name}' has no producer binding. Register it with ` +
          `QueueModule.registerQueue({ name: '${name}', binding: 'YOUR_QUEUE' }), where the ` +
          `binding is a queues.producers[].binding of this Worker.`,
      );
    }
    try {
      return resolveBinding(env, { binding: registration.binding }, QUEUE_PRODUCER);
    } catch (error) {
      throw new Error(
        `Queue '${name}' cannot send: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  };

  return {
    kind: 'cloudflare',
    entrypoints: [{ kind: 'cf:queue:module', meta: { consumers: [...pins.keys()] } }],

    async consume(payload: unknown, dispatch: QueueDispatchFn): Promise<void> {
      const batch = nativeBatch(payload);
      const pinned = pins.get(batch.queue);
      await consumeQueueBatch(
        batch,
        (job) => {
          // A pinned queue is consumed only from the physical queues it names.
          const expected = queues.get(job.queue)?.consumers ?? [];
          if (expected.length > 0 && !expected.includes(batch.queue)) {
            throw new Error(
              `Queue '${job.queue}' is consumed from ` +
                `${expected.map((queue) => `'${queue}'`).join(', ')}, not '${batch.queue}'.`,
            );
          }
          return dispatch(job);
        },
        pinned ? { queues: pinned } : {},
      );
    },

    async enqueue(job: QueueJob, options?: AddJobOptions): Promise<void> {
      const delay = delaySeconds(options);
      await producerFor(job.queue).send(
        parseQueueJob(job),
        delay === undefined ? undefined : { delaySeconds: delay },
      );
    },

    async enqueueBatch(requests: readonly QueueEnqueueRequest[]): Promise<void> {
      // Validate every job and resolve every binding before the first send.
      const messages = requests.map(({ job, options }): PreparedMessage => {
        const body = parseQueueJob(job);
        const bytes = estimateQueueMessageBytes(body);
        if (bytes > QUEUE_SEND_LIMITS.messageBytes) {
          throw new RangeError(
            `Queue job '${job.id}' is an estimated ${bytes} bytes, over the ` +
              `${QUEUE_SEND_LIMITS.messageBytes}-byte Cloudflare message limit. Store large ` +
              `payloads elsewhere (for example in R2) and enqueue a reference.`,
          );
        }
        const delay = delaySeconds(options);
        return {
          id: job.id,
          queue: job.queue,
          bytes,
          request: delay === undefined ? { body } : { body, delaySeconds: delay },
        };
      });
      const producers = new Map<string, CloudflareQueueProducer>();
      for (const { queue } of messages) {
        if (!producers.has(queue)) producers.set(queue, producerFor(queue));
      }
      const accepted: string[] = [];
      for (const part of chunk(messages)) {
        const producer = producers.get(part[0]!.queue)!;
        try {
          if (typeof producer.sendBatch === 'function') {
            // eslint-disable-next-line no-await-in-loop
            await producer.sendBatch(part.map(({ request }) => request));
            accepted.push(...part.map(({ id }) => id));
          } else {
            for (const { id, request } of part) {
              const delay = request.delaySeconds;
              // eslint-disable-next-line no-await-in-loop
              await producer.send(
                request.body,
                delay === undefined ? undefined : { delaySeconds: delay },
              );
              accepted.push(id);
            }
          }
        } catch (error) {
          throw new QueueBatchError(
            accepted,
            messages.slice(accepted.length).map(({ id }) => id),
            error,
          );
        }
      }
    },
  };
}

/**
 * The Cloudflare Queues driver for `QueueModule`:
 *
 * ```ts
 * QueueModule.forRoot({ driver: cloudflareQueues() })
 * QueueModule.registerQueue({ name: 'email', binding: 'EMAIL_QUEUE' })
 * ```
 *
 * Each application gets its own driver. Producing reads the registered binding
 * from that application's `ENV` when a job is added and awaits the native
 * send; `addBulk` uses `sendBatch`, chunked to {@link QUEUE_SEND_LIMITS}.
 * Consuming is native too: the Worker's `queue()` handler routes every batch
 * that no `@QueueConsumer` claims through `QueueModule`, one message at a time,
 * by each job's logical `queue`, with the module's dispatch policy (signed
 * dispatch included). A registration's `consumer` pins its queue to that
 * physical queue: the queue's jobs are accepted only from it, and it only
 * carries the queues pinned to it. A message that is not a job envelope,
 * belongs to an unregistered queue, or fails stays unacknowledged, so
 * Cloudflare retries it and then dead-letters it.
 */
export function cloudflareQueues(): QueueDriverFactory {
  return (context) => createDriver(context);
}

export interface ConsumeQueueBatchOptions {
  /**
   * Accept only jobs of these logical queues; any other message fails and is
   * retried. By default every job envelope is accepted.
   */
  readonly queues?: readonly string[];
}

/**
 * Settle native messages one job at a time. Attempts come from the host.
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
  for (const message of batch.messages) {
    try {
      const job = parseQueueJob(message.body, message.attempts);
      if (options.queues && !options.queues.includes(job.queue)) {
        throw new Error(
          `Queue '${job.queue}' is not consumed from '${batch.queue}', which accepts ` +
            `${options.queues.map((queue) => `'${queue}'`).join(', ')}.`,
        );
      }
      const observed = observeMessage(message);
      // eslint-disable-next-line no-await-in-loop
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
