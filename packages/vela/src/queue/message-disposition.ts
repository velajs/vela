// Queue disposition harness — a platform-neutral testing/observability seam
// over a host queue Message. It WRAPS (never mutates) each message so a test or
// observer can see whether the handler acked, retried, or left it unsettled,
// and can honestly INFER dead-lettering when the retry ceiling is known.
//
// Deliberately dependency-free: no `node:`/`cloudflare:` imports, no vela
// imports. It operates over the STRUCTURAL {@link QueueMessageLike} shape, so it
// works over a Cloudflare Queues `Message`, a fake, or any host that mirrors the
// same surface. Not wired into any delivery path — pure observation.

/**
 * The structural surface of a host queue message this harness observes. It is a
 * SUBSET of Cloudflare Queues' `Message`: the identity/payload getters plus the
 * two settlement methods. Any host message with this shape can be observed.
 */
export interface QueueMessageLike<Body = unknown> {
  readonly id: string;
  readonly timestamp: Date;
  readonly body: Body;
  /** Delivery attempt count, as reported by the host (1-based on most hosts). */
  readonly attempts: number;
  /** Settle as handled. */
  ack(): void;
  /** Return for redelivery, optionally after a delay. */
  retry(options?: { delaySeconds?: number }): void;
}

/** How a message was settled by the handler. */
export type MessageOutcome = 'acked' | 'retried' | 'unsettled';

/**
 * What the harness observed for one message.
 *
 * `outcome` starts `unsettled` and only moves when the handler explicitly calls
 * `ack()`/`retry()`. Implicit-ack on normal batch completion is runtime-owned
 * and NOT inferred here — the harness reports the raw fact and lets the observer
 * interpret it.
 */
export interface MessageDisposition {
  id: string;
  attempts: number;
  outcome: MessageOutcome;
  /** Present only when `retry({ delaySeconds })` supplied a delay. */
  retryDelaySeconds?: number;
  /** Retry requested after the last allowed delivery (attempts are 1-based). */
  retryExhausted?: boolean;
  /**
   * Inferred DLQ routing, never confirmation of delivery. Unknown unless both
   * maxRetries and deadLetterQueue configuration are supplied.
   */
  deadLettered: boolean | undefined;
}

export interface ObserveMessageOptions {
  /** Retries after the initial delivery; maxRetries: 0 permits one attempt. */
  maxRetries?: number;
  /** Whether a dead-letter queue is configured on the host consumer. */
  deadLetterQueue?: boolean;
}

export interface ObservedMessage<Body = unknown> {
  /** A Proxy wrapper to hand to the handler in place of the host message. */
  message: QueueMessageLike<Body>;
  /** Snapshot the observed disposition at call time. */
  disposition(): MessageDisposition;
}

/** Aggregate view over an observed batch. */
export interface BatchDisposition {
  messages: MessageDisposition[];
  acked: number;
  retried: number;
  unsettled: number;
  /** Count of messages inferred dead-lettered (only definite `true` counts). */
  deadLettered: number;
}

export interface ObservedBatch<Body = unknown> {
  /** Proxy wrappers to hand to the handler in place of the host messages. */
  messages: QueueMessageLike<Body>[];
  /** Snapshot the aggregate + per-message dispositions at call time. */
  report(): BatchDisposition;
}

function retryExhausted(
  outcome: MessageOutcome,
  attempts: number,
  maxRetries: number | undefined,
): boolean | undefined {
  if (maxRetries === undefined) return undefined;
  return outcome === 'retried' && attempts > maxRetries;
}

/**
 * Wrap a host message in an observing Proxy. The returned `message` is safe to
 * hand to the queue handler; call `disposition()` afterwards to read what
 * happened.
 *
 * WHY A PROXY (not a copy): a host `Message` is non-extensible and exposes its
 * fields through getters/own props that a plain copy cannot faithfully
 * re-expose — and a copy would also lose host identity. The Proxy honors the
 * non-extensible-target invariant: for every property except `ack`/`retry` the
 * `get` trap returns `Reflect.get(target, prop, target)` UNCHANGED, so
 * `id`/`body`/`timestamp`/`attempts` pass through verbatim. Only `ack`/`retry`
 * are substituted with recording wrappers — safe because on real hosts those
 * are PROTOTYPE methods (not own non-configurable data properties), so the
 * invariant does not force the trap to return the target's own value.
 *
 * Observation state lives in this closure, never on the target — the host
 * message is never mutated.
 */
export function observeMessage<Body = unknown>(
  message: QueueMessageLike<Body>,
  options: ObserveMessageOptions = {},
): ObservedMessage<Body> {
  if (
    options.maxRetries !== undefined &&
    (!Number.isSafeInteger(options.maxRetries) || options.maxRetries < 0)
  ) {
    throw new RangeError('maxRetries must be a non-negative safe integer.');
  }
  let outcome: MessageOutcome = 'unsettled';
  let retryDelaySeconds: number | undefined;

  const proxy = new Proxy(message, {
    get(target, prop) {
      if (prop === 'ack') {
        return (): void => {
          target.ack();
          if (outcome === 'unsettled') outcome = 'acked';
        };
      }
      if (prop === 'retry') {
        return (retryOptions?: { delaySeconds?: number }): void => {
          target.retry(retryOptions);
          if (outcome === 'unsettled') {
            outcome = 'retried';
            retryDelaySeconds = retryOptions?.delaySeconds;
          }
        };
      }
      // Non-extensible-target invariant: return the target's own value for
      // every data property (receiver = target so host getters see the host).
      return Reflect.get(target, prop, target);
    },
  });

  return {
    message: proxy,
    disposition(): MessageDisposition {
      const exhausted = retryExhausted(outcome, message.attempts, options.maxRetries);
      const result: MessageDisposition = {
        id: message.id,
        attempts: message.attempts,
        outcome,
        retryExhausted: exhausted,
        deadLettered:
          exhausted === undefined || options.deadLetterQueue === undefined
            ? undefined
            : exhausted && options.deadLetterQueue,
      };
      if (retryDelaySeconds !== undefined) result.retryDelaySeconds = retryDelaySeconds;
      return result;
    },
  };
}

/**
 * Observe a whole batch: maps {@link observeMessage} over each message and
 * aggregates the per-message dispositions via `report()`.
 */
export function observeBatch<Body = unknown>(
  messages: readonly QueueMessageLike<Body>[],
  options: ObserveMessageOptions = {},
): ObservedBatch<Body> {
  const observed = messages.map((message) => observeMessage(message, options));
  return {
    messages: observed.map((o) => o.message),
    report(): BatchDisposition {
      const dispositions = observed.map((o) => o.disposition());
      return {
        messages: dispositions,
        acked: dispositions.filter((d) => d.outcome === 'acked').length,
        retried: dispositions.filter((d) => d.outcome === 'retried').length,
        unsettled: dispositions.filter((d) => d.outcome === 'unsettled').length,
        deadLettered: dispositions.filter((d) => d.deadLettered === true).length,
      };
    },
  };
}
