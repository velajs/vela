import { isStandardSchema, validateSchema, type StandardSchemaV1 } from '@velajs/vela/validation';

export interface QueueEvent<Payload = unknown> {
  readonly type: string;
  readonly source: Readonly<Record<string, unknown>> & { readonly type: string };
  readonly payload: Payload;
  readonly metadata: Readonly<Record<string, unknown>> & {
    readonly accountId: string;
    readonly eventSubscriptionId: string;
    readonly eventSchemaVersion: 1;
    readonly eventTimestamp: string;
  };
}

/** Native delivery identity, not a universal platform event ID or an idempotency guarantee. */
export interface QueueEventContext {
  readonly queue: string;
  readonly messageId: string;
  readonly timestamp: Date;
  readonly attempts: number;
}

export type QueueEventErrorCode =
  | 'invalid-envelope'
  | 'unsupported-version'
  | 'unexpected-account'
  | 'unexpected-subscription'
  | 'unhandled-type'
  | 'unexpected-source'
  | 'invalid-payload'
  | 'handler-failed';

export class QueueEventError extends Error {
  constructor(
    readonly code: QueueEventErrorCode,
    options?: ErrorOptions,
  ) {
    super(`Queue event ${code}`, options);
    this.name = 'QueueEventError';
  }
}

export interface QueueEventFailure {
  readonly messageId: string;
  readonly error: QueueEventError;
}

/** Successful siblings are already acknowledged; failures have requested native retries. */
export class QueueEventsBatchError extends AggregateError {
  constructor(readonly failures: readonly QueueEventFailure[]) {
    super(
      failures.map(({ error }) => error),
      `${failures.length} queue event(s) failed`,
    );
    this.name = 'QueueEventsBatchError';
  }
}

export interface QueueEventOptions<Payload> {
  /** The full documented event type, for example cf.workersBuilds.worker.build.succeeded. */
  readonly type: string;
  /** Exact matches for source.type and any source selectors required by the application. */
  readonly source: Readonly<Record<string, string>> & { readonly type: string };
  readonly schema: StandardSchemaV1<unknown, Payload>;
  readonly handle: (event: QueueEvent<Payload>, context: QueueEventContext) => void | Promise<void>;
}

const dispatch = Symbol('queue-event-dispatch');

/** Created with defineQueueEvent so each heterogeneous payload retains its validated type. */
export interface QueueEventHandler {
  readonly type: string;
  readonly [dispatch]: (event: QueueEvent, context: QueueEventContext) => Promise<void>;
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** No module registration or global state: define handlers alongside their consuming provider. */
export function defineQueueEvent<Payload>(options: QueueEventOptions<Payload>): QueueEventHandler {
  if (
    !nonempty(options.type) ||
    !nonempty(options.source.type) ||
    !Object.values(options.source).every(nonempty)
  ) {
    throw new TypeError('Queue event type and source expectations must be nonempty strings');
  }
  if (!isStandardSchema(options.schema))
    throw new TypeError('Expected a Standard Schema validator');
  const { type, schema, handle } = options;
  const source = Object.entries(options.source);
  return Object.freeze({
    type,
    async [dispatch](event: QueueEvent, context: QueueEventContext) {
      if (!source.every(([key, value]) => event.source[key] === value)) {
        throw new QueueEventError('unexpected-source');
      }
      let payload: Payload;
      try {
        payload = await validateSchema(schema, event.payload);
      } catch (cause) {
        throw new QueueEventError('invalid-payload', { cause });
      }
      try {
        await handle({ ...event, payload }, context);
      } catch (cause) {
        throw new QueueEventError('handler-failed', { cause });
      }
    },
  });
}

export interface ConsumeQueueEventsOptions {
  /** Dedicated physical queue name, also claimed by @QueueConsumer. */
  readonly queue: string;
  readonly accountId: string;
  readonly eventSubscriptionIds: readonly string[];
  /** One handler per exact event type; each may require source selectors. */
  readonly handlers: readonly QueueEventHandler[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEvent(value: unknown): QueueEvent {
  if (
    !record(value) ||
    !nonempty(value.type) ||
    !record(value.source) ||
    !nonempty(value.source.type) ||
    !Object.hasOwn(value, 'payload') ||
    !record(value.metadata)
  ) {
    throw new QueueEventError('invalid-envelope');
  }
  const { source, metadata } = value;
  if (
    !nonempty(metadata.accountId) ||
    !nonempty(metadata.eventSubscriptionId) ||
    !Number.isInteger(metadata.eventSchemaVersion) ||
    !nonempty(metadata.eventTimestamp) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      metadata.eventTimestamp,
    ) ||
    !Number.isFinite(Date.parse(metadata.eventTimestamp)) ||
    // Date.parse normalizes impossible dates such as February 30. Reject those too.
    new Date(metadata.eventTimestamp.slice(0, 10)).toISOString().slice(0, 10) !==
      metadata.eventTimestamp.slice(0, 10)
  ) {
    throw new QueueEventError('invalid-envelope');
  }
  if (metadata.eventSchemaVersion !== 1) throw new QueueEventError('unsupported-version');
  return {
    type: value.type,
    source: { ...source, type: value.source.type },
    payload: value.payload,
    metadata: {
      ...metadata,
      accountId: metadata.accountId,
      eventSubscriptionId: metadata.eventSubscriptionId,
      eventSchemaVersion: 1,
      eventTimestamp: metadata.eventTimestamp,
    },
  };
}

/**
 * Await each validated handler, then acknowledge that message. Every malformed,
 * unmatched or failing message requests retry; all siblings are attempted before
 * throwing QueueEventsBatchError. Cloudflare owns retry limits, delays and DLQ routing.
 * Do not acknowledge the batch elsewhere or convert these bodies into Vela jobs.
 */
export async function consumeQueueEvents(
  batch: MessageBatch<unknown>,
  options: ConsumeQueueEventsOptions,
): Promise<void> {
  if (
    !nonempty(options.queue) ||
    !nonempty(options.accountId) ||
    options.eventSubscriptionIds.length === 0 ||
    !options.eventSubscriptionIds.every(nonempty)
  ) {
    throw new TypeError('Expected a physical queue, account and nonempty subscription allowlist');
  }
  if (batch.queue !== options.queue)
    throw new Error('Unexpected physical queue for platform events');
  const handlers = new Map<string, QueueEventHandler>();
  for (const handler of options.handlers) {
    if (handlers.has(handler.type))
      throw new TypeError(`Duplicate queue event handler: ${handler.type}`);
    handlers.set(handler.type, handler);
  }
  const accountId = options.accountId;
  const subscriptions = new Set(options.eventSubscriptionIds);
  const failures: QueueEventFailure[] = [];
  for (const message of batch.messages) {
    try {
      const event = parseEvent(message.body);
      if (event.metadata.accountId !== accountId) throw new QueueEventError('unexpected-account');
      if (!subscriptions.has(event.metadata.eventSubscriptionId))
        throw new QueueEventError('unexpected-subscription');
      const handler = handlers.get(event.type);
      if (!handler) throw new QueueEventError('unhandled-type');
      await handler[dispatch](event, {
        queue: batch.queue,
        messageId: message.id,
        timestamp: message.timestamp,
        attempts: message.attempts,
      });
    } catch (error) {
      message.retry();
      failures.push({
        messageId: message.id,
        error:
          error instanceof QueueEventError
            ? error
            : new QueueEventError('handler-failed', { cause: error }),
      });
      continue;
    }
    message.ack();
  }
  if (failures.length > 0) throw new QueueEventsBatchError(failures);
}
