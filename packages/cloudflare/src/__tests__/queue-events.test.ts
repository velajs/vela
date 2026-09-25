import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { StandardSchemaV1 } from '@velajs/vela/validation';
import {
  consumeQueueEvents,
  defineQueueEvent,
  QueueEventsBatchError,
  type QueueEventErrorCode,
} from '../queue-events';
import {
  buildEventExpectation,
  eventConsumerExpectation,
  workerBuildSucceeded,
} from './fixtures/worker-build-event';

function incoming(body: unknown, id = 'message-1') {
  return {
    body,
    id,
    timestamp: new Date('2026-09-25T00:00:00Z'),
    attempts: 2,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}
function batch(messages: Message<unknown>[]): MessageBatch<unknown> {
  return {
    queue: 'platform-events',
    messages,
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  };
}
function setup() {
  const handle = vi.fn();
  const options = {
    ...eventConsumerExpectation,
    handlers: [defineQueueEvent({ ...buildEventExpectation, handle })],
  };
  return { handle, options };
}

async function failureOf(promise: Promise<void>): Promise<QueueEventsBatchError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(QueueEventsBatchError);
    if (error instanceof QueueEventsBatchError) return error;
    throw error;
  }
  throw new Error('Expected a batch failure');
}

describe('platform queue events', () => {
  it('awaits Standard Schema output and the handler before acknowledging the individual message', async () => {
    const message = incoming(workerBuildSucceeded());
    const order: string[] = [];
    const schema: StandardSchemaV1<unknown, { buildId: string }> = {
      '~standard': {
        version: 1,
        vendor: 'async-test',
        async validate(value) {
          const result = await buildEventExpectation.schema['~standard'].validate(value);
          if (result.issues) return { issues: result.issues };
          order.push('validated');
          return { value: { buildId: result.value.buildUuid } };
        },
      },
    };
    await consumeQueueEvents(batch([message]), {
      ...eventConsumerExpectation,
      handlers: [
        defineQueueEvent({
          ...buildEventExpectation,
          schema,
          async handle(event, delivery) {
            expect(event.payload).toEqual({ buildId: workerBuildSucceeded().payload.buildUuid });
            expect(event.metadata).toEqual(workerBuildSucceeded().metadata);
            expect(event.source).toEqual(workerBuildSucceeded().source);
            expect(delivery).toEqual({
              queue: 'platform-events',
              messageId: message.id,
              timestamp: message.timestamp,
              attempts: 2,
            });
            await Promise.resolve();
            expect(message.ack).not.toHaveBeenCalled();
            order.push('handled');
          },
        }),
      ],
    });
    expect(order).toEqual(['validated', 'handled']);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  const fixture = workerBuildSucceeded();
  const invalid: [string, unknown, QueueEventErrorCode][] = [
    ['null', null, 'invalid-envelope'],
    ['JSON string', JSON.stringify(fixture), 'invalid-envelope'],
    ['array', [], 'invalid-envelope'],
    [
      'missing payload',
      { type: fixture.type, source: fixture.source, metadata: fixture.metadata },
      'invalid-envelope',
    ],
    ['missing metadata', { ...fixture, metadata: {} }, 'invalid-envelope'],
    ['missing source', { ...fixture, source: {} }, 'invalid-envelope'],
    [
      'wrong timestamp type',
      { ...fixture, metadata: { ...fixture.metadata, eventTimestamp: 123 } },
      'invalid-envelope',
    ],
    [
      'non-ISO timestamp',
      { ...fixture, metadata: { ...fixture.metadata, eventTimestamp: 'May 1, 2025' } },
      'invalid-envelope',
    ],
    [
      'invalid date',
      { ...fixture, metadata: { ...fixture.metadata, eventTimestamp: '2025-99-99T00:00:00Z' } },
      'invalid-envelope',
    ],
    [
      'wrong version type',
      { ...fixture, metadata: { ...fixture.metadata, eventSchemaVersion: '1' } },
      'invalid-envelope',
    ],
    [
      'unknown version',
      { ...fixture, metadata: { ...fixture.metadata, eventSchemaVersion: 2 } },
      'unsupported-version',
    ],
    [
      'unknown type',
      { ...fixture, type: 'cf.workersBuilds.worker.build.unknown' },
      'unhandled-type',
    ],
    [
      'wrong account',
      { ...fixture, metadata: { ...fixture.metadata, accountId: 'other' } },
      'unexpected-account',
    ],
    [
      'wrong subscription',
      { ...fixture, metadata: { ...fixture.metadata, eventSubscriptionId: 'other' } },
      'unexpected-subscription',
    ],
    [
      'wrong source type',
      { ...fixture, source: { ...fixture.source, type: 'workers' } },
      'unexpected-source',
    ],
    [
      'wrong source selector',
      { ...fixture, source: { ...fixture.source, workerName: 'other' } },
      'unexpected-source',
    ],
    [
      'invalid payload',
      { ...fixture, payload: { status: 'success', buildUuid: 123 } },
      'invalid-payload',
    ],
    [
      'Vela job',
      { id: 'job-1', queue: 'jobs', name: 'run', data: {}, attempt: 1 },
      'invalid-envelope',
    ],
  ];
  invalid.push([
    'impossible calendar date',
    { ...fixture, metadata: { ...fixture.metadata, eventTimestamp: '2025-02-30T02:48:57.132Z' } },
    'invalid-envelope',
  ]);
  it.each(invalid)('retries %s without calling a handler', async (_name, body, code) => {
    const { handle, options } = setup();
    const message = incoming(body);
    const error = await failureOf(consumeQueueEvents(batch([message]), options));
    expect(error.failures).toEqual([
      { messageId: message.id, error: expect.objectContaining({ code }) },
    ]);
    expect(handle).not.toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledExactlyOnceWith();
  });

  it('continues after failures, acknowledges successes and retries only failed messages', async () => {
    const messages = [
      incoming(null, 'malformed'),
      incoming(fixture, 'ok'),
      incoming(fixture, 'failed'),
      incoming(fixture, 'later'),
    ];
    const seen: string[] = [];
    const native = batch(messages);
    const cause = new Error('downstream unavailable');
    const error = await failureOf(
      consumeQueueEvents(native, {
        ...eventConsumerExpectation,
        handlers: [
          defineQueueEvent({
            ...buildEventExpectation,
            async handle(_event, delivery) {
              seen.push(delivery.messageId);
              if (delivery.messageId === 'failed') {
                await Promise.resolve();
                throw cause;
              }
            },
          }),
        ],
      }),
    );
    expect(seen).toEqual(['ok', 'failed', 'later']);
    expect(error.failures.map(({ messageId, error }) => [messageId, error.code])).toEqual([
      ['malformed', 'invalid-envelope'],
      ['failed', 'handler-failed'],
    ]);
    expect(error.failures[1]?.error.cause).toBe(cause);
    expect(
      messages.filter((message) => message.ack.mock.calls.length).map((message) => message.id),
    ).toEqual(['ok', 'later']);
    expect(
      messages.filter((message) => message.retry.mock.calls.length).map((message) => message.id),
    ).toEqual(['malformed', 'failed']);
    expect(native.ackAll).not.toHaveBeenCalled();
    expect(native.retryAll).not.toHaveBeenCalled();
  });

  it('does not deduplicate repeated event identifiers or repeated delivery IDs', async () => {
    const { handle, options } = setup();
    await consumeQueueEvents(
      batch([incoming(fixture), incoming(fixture), incoming(fixture, 'new-delivery')]),
      options,
    );
    expect(handle).toHaveBeenCalledTimes(3);
  });

  it('preserves source-native event IDs through the supplied payload schema', async () => {
    const handle = vi.fn();
    await consumeQueueEvents(
      batch([
        incoming({
          ...fixture,
          type: 'cf.email.sending.message.delivered',
          source: { type: 'email.sending', domain: 'example.com' },
          payload: { eventId: 'event-1', messageId: 'outbound-1' },
        }),
      ]),
      {
        ...eventConsumerExpectation,
        handlers: [
          defineQueueEvent({
            type: 'cf.email.sending.message.delivered',
            source: { type: 'email.sending', domain: 'example.com' },
            schema: z.object({ eventId: z.string(), messageId: z.string() }),
            handle,
          }),
        ],
      },
    );
    expect(handle.mock.calls[0]?.[0].payload).toEqual({
      eventId: 'event-1',
      messageId: 'outbound-1',
    });
  });

  it('treats validator exceptions as retryable and permits additive metadata', async () => {
    const { handle, options } = setup();
    await consumeQueueEvents(
      batch([incoming({ ...fixture, metadata: { ...fixture.metadata, extra: true } })]),
      options,
    );
    expect(handle.mock.calls[0]?.[0].metadata.extra).toBe(true);
    const message = incoming(fixture);
    const error = await failureOf(
      consumeQueueEvents(batch([message]), {
        ...options,
        handlers: [
          defineQueueEvent({
            ...buildEventExpectation,
            schema: {
              '~standard': {
                version: 1,
                vendor: 'test',
                validate() {
                  throw new Error('validator failed');
                },
              },
            },
            handle,
          }),
        ],
      }),
    );
    expect(error.failures[0]?.error.code).toBe('invalid-payload');
    expect(message.retry).toHaveBeenCalledOnce();
  });

  it('fails configuration before effects and never consumes another physical queue', async () => {
    const { handle, options } = setup();
    const message = incoming(fixture);
    const native = batch([message]);
    for (const configured of [
      { ...options, queue: 'other' },
      { ...options, accountId: '' },
      { ...options, eventSubscriptionIds: [] },
      { ...options, handlers: [...options.handlers, ...options.handlers] },
    ])
      await expect(consumeQueueEvents(native, configured)).rejects.toThrow();
    expect(handle).not.toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });
});
