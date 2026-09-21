import { describe, it, expect } from 'vitest';
import { observeMessage, observeBatch } from '../queue/index.js';
import type { QueueMessageLike, MessageDisposition, BatchDisposition } from '../queue/index.js';

/**
 * A frozen, non-extensible stand-in for a host queue `Message`. `ack`/`retry`
 * live on the class PROTOTYPE (like Cloudflare Queues' `Message`), while
 * id/timestamp/body/attempts are own data properties that `Object.freeze` makes
 * non-configurable + non-writable — the exact shape the Proxy invariant cares
 * about. Settlement calls forward to injected spies so pass-through is
 * observable without mutating the (frozen) message.
 */
class FrozenMessage<Body> implements QueueMessageLike<Body> {
  constructor(
    readonly id: string,
    readonly timestamp: Date,
    readonly body: Body,
    readonly attempts: number,
    private readonly onAck: () => void,
    private readonly onRetry: (options?: { delaySeconds?: number }) => void,
  ) {}

  ack(): void {
    this.onAck();
  }

  retry(options?: { delaySeconds?: number }): void {
    this.onRetry(options);
  }
}

function frozenMessage<Body>(
  fields: { id: string; timestamp: Date; body: Body; attempts: number },
  spies: { onAck?: () => void; onRetry?: (options?: { delaySeconds?: number }) => void } = {},
): QueueMessageLike<Body> {
  return Object.freeze(
    new FrozenMessage(
      fields.id,
      fields.timestamp,
      fields.body,
      fields.attempts,
      spies.onAck ?? (() => {}),
      spies.onRetry ?? (() => {}),
    ),
  );
}

describe('queue disposition harness — observeMessage', () => {
  it('wraps (does not replace or mutate) the host message', () => {
    const ts = new Date('2026-07-14T00:00:00.000Z');
    const host = frozenMessage({ id: 'm1', timestamp: ts, body: { n: 1 }, attempts: 1 });
    const ownKeysBefore = Reflect.ownKeys(host);

    const observed = observeMessage(host);

    // A Proxy — a different reference…
    expect(observed.message).not.toBe(host);
    // …that exposes identical data properties verbatim.
    expect(observed.message.id).toBe('m1');
    expect(observed.message.timestamp).toBe(ts);
    expect(observed.message.body).toEqual({ n: 1 });
    expect(observed.message.attempts).toBe(1);

    // The target gained no own properties (observation lives in a closure).
    expect(Reflect.ownKeys(host)).toEqual(ownKeysBefore);
  });

  it('records an ack and calls through to the host method', () => {
    let acked = 0;
    const host = frozenMessage(
      { id: 'm2', timestamp: new Date(0), body: 'x', attempts: 2 },
      { onAck: () => acked++ },
    );

    const observed = observeMessage(host);
    expect(observed.disposition().outcome).toBe('unsettled');

    observed.message.ack();

    expect(acked).toBe(1);
    const disposition = observed.disposition();
    expect(disposition.outcome).toBe('acked');
    expect(disposition.id).toBe('m2');
    expect(disposition.attempts).toBe(2);
    expect(disposition.retryDelaySeconds).toBeUndefined();
  });

  it('records a retry with its delay and calls through to the host method', () => {
    let seenDelay: number | undefined = -1;
    const host = frozenMessage(
      { id: 'm3', timestamp: new Date(0), body: null, attempts: 1 },
      { onRetry: (options) => (seenDelay = options?.delaySeconds) },
    );

    const observed = observeMessage(host);
    observed.message.retry({ delaySeconds: 30 });

    expect(seenDelay).toBe(30);
    const disposition = observed.disposition();
    expect(disposition.outcome).toBe('retried');
    expect(disposition.retryDelaySeconds).toBe(30);
  });

  it('infers DLQ routing after initial delivery plus configured retries', () => {
    const host = frozenMessage({ id: 'm4', timestamp: new Date(0), body: 0, attempts: 4 });
    const observed = observeMessage(host, { maxRetries: 3, deadLetterQueue: true });

    observed.message.retry();

    const disposition = observed.disposition();
    expect(disposition.outcome).toBe('retried');
    expect(disposition.deadLettered).toBe(true);
  });

  it('reports deadLettered false (known) when retried below the ceiling', () => {
    const host = frozenMessage({ id: 'm5', timestamp: new Date(0), body: 0, attempts: 1 });
    const observed = observeMessage(host, { maxRetries: 3, deadLetterQueue: true });

    observed.message.retry();

    expect(observed.disposition().deadLettered).toBe(false);
  });

  it('leaves deadLettered undefined (unknown, never false) when maxRetries is omitted', () => {
    const host = frozenMessage({ id: 'm6', timestamp: new Date(0), body: 0, attempts: 9 });
    const observed = observeMessage(host);

    observed.message.retry();

    expect(observed.disposition().deadLettered).toBeUndefined();
  });
});

describe('queue disposition harness — observeBatch', () => {
  it('maps over the batch and aggregates the report', () => {
    const acked = frozenMessage({ id: 'a', timestamp: new Date(0), body: 0, attempts: 1 });
    const retried = frozenMessage({ id: 'b', timestamp: new Date(0), body: 0, attempts: 4 });
    const untouched = frozenMessage({ id: 'c', timestamp: new Date(0), body: 0, attempts: 1 });

    const observed = observeBatch([acked, retried, untouched], {
      maxRetries: 3,
      deadLetterQueue: true,
    });
    expect(observed.messages).toHaveLength(3);

    observed.messages[0]!.ack();
    observed.messages[1]!.retry();

    const report: BatchDisposition = observed.report();
    expect(report.acked).toBe(1);
    expect(report.retried).toBe(1);
    expect(report.unsettled).toBe(1);
    expect(report.deadLettered).toBe(1);
    expect(report.messages.map((d) => d.outcome)).toEqual(['acked', 'retried', 'unsettled']);
  });
});

describe('queue disposition harness — exported type signatures', () => {
  it('MessageDisposition/QueueMessageLike dogfood without casts', () => {
    const host: QueueMessageLike<{ userId: string }> = frozenMessage({
      id: 't1',
      timestamp: new Date(0),
      body: { userId: 'u1' },
      attempts: 1,
    });

    const disposition: MessageDisposition = observeMessage(host).disposition();
    // deadLettered is intentionally `boolean | undefined` — assignable to a
    // union local without a cast.
    const dead: boolean | undefined = disposition.deadLettered;
    // body stays typed through the structural contract.
    const userId: string = host.body.userId;

    expect(disposition.outcome).toBe('unsettled');
    expect(dead).toBeUndefined();
    expect(userId).toBe('u1');
  });
});

describe('first successful settlement observation', () => {
  it.each(['ack', 'retry'] as const)('keeps the first %s including its delay', (first) => {
    const host = frozenMessage({ id: 'first', timestamp: new Date(0), body: null, attempts: 1 });
    const observed = observeMessage(host);
    if (first === 'ack') observed.message.ack();
    else observed.message.retry({ delaySeconds: 7 });
    observed.message.retry({ delaySeconds: 99 });
    observed.message.ack();
    expect(observed.disposition()).toMatchObject({
      outcome: first === 'ack' ? 'acked' : 'retried',
    });
    expect(observed.disposition().retryDelaySeconds).toBe(first === 'ack' ? undefined : 7);
  });

  it('does not record a failed host call', () => {
    const host = frozenMessage(
      { id: 'throw', timestamp: new Date(0), body: null, attempts: 1 },
      {
        onRetry: () => {
          throw new Error('invalid delay');
        },
      },
    );
    const observed = observeMessage(host);
    expect(() => observed.message.retry()).toThrow('invalid delay');
    expect(observed.disposition().outcome).toBe('unsettled');
    observed.message.ack();
    expect(observed.disposition().outcome).toBe('acked');
  });

  it('distinguishes retry exhaustion from DLQ configuration and includes the initial attempt', () => {
    for (const [attempts, maxRetries, exhausted] of [
      [1, 0, true],
      [3, 3, false],
      [4, 3, true],
    ] as const) {
      const host = frozenMessage({ id: 'limit', timestamp: new Date(0), body: null, attempts });
      const unknown = observeMessage(host, { maxRetries });
      unknown.message.retry();
      expect(unknown.disposition().retryExhausted).toBe(exhausted);
      expect(unknown.disposition().deadLettered).toBeUndefined();
      const absent = observeMessage(host, { maxRetries, deadLetterQueue: false });
      absent.message.retry();
      expect(absent.disposition().deadLettered).toBe(false);
    }
  });
});
