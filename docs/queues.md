# Queues

`@velajs/vela/queue` provides portable jobs and processors. Import `QueueModule`,
inject `queueToken(name)`, and await `client.add(name, data)`. Acceptance means the
driver accepted the job; it does not mean a processor has finished.

## Driver ownership

The default inline driver is created separately for each application. When
reusing module declarations across applications, configure a factory:

```ts
QueueModule.forRoot({ queues: ['email'], driver: () => inline() });
```

A bound driver instance belongs to one application. Reusing it for another
application throws instead of redirecting deliveries. Producer-only drivers
without a `bind` method can be shared if their own transport permits it. Use
`forRootAsync` with the application's environment token for native bindings.

For deterministic tests, create `inline({ mode: 'manual' })` per application and
await `flush()`. Failed jobs reject the flush after all buffered jobs are tried;
the inline driver does not retry them. Closing the application releases its
binding and clears pending jobs. Legacy adds after inline disposal remain no-ops.
Inline delivery is in memory and does not support delayed or durable delivery.

## Observing settlement

`observeMessage` and `observeBatch` wrap native messages without mutating them.
The first successful individual `ack()` or `retry()` call determines the observed
outcome; later calls still forward to the host. A throwing host call does not
record a settlement. Implicit batch completion and batch-level ack/retry calls
are not observed by this message wrapper.

`maxRetries` excludes the initial delivery. With `maxRetries: 3`, an explicit
retry on attempt 4 reports `retryExhausted: true`. `deadLettered` is an inference
of configured routing, never confirmation of delivery. It stays unknown unless
both `maxRetries` and `deadLetterQueue` are supplied. A consumer without a DLQ
reports `deadLettered: false` even when retries are exhausted. Platform
configuration owns retries, deletion, and dead-letter routing.
