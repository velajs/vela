import { Injectable, Inject } from '@velajs/vela';
import type { BindingRef } from '../binding-ref';
import { QUEUE_BINDING_REF } from '../tokens';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QueueBinding = Record<string, any>;

/**
 * Wrapper around Cloudflare Queue (producer side).
 * Injected via `QueueModule.forRoot({ binding: 'MY_QUEUE' })`.
 *
 * For consuming messages, use the `@QueueConsumer()` decorator.
 */
@Injectable()
export class QueueService {
  constructor(@Inject(QUEUE_BINDING_REF) private ref: BindingRef) {}

  /** Access the raw Queue binding directly. */
  get queue(): QueueBinding {
    return this.ref.value as QueueBinding;
  }

  send(message: unknown, options?: Record<string, unknown>): Promise<void> {
    return this.queue.send(message, options);
  }

  sendBatch(
    messages: Iterable<{ body: unknown; [key: string]: unknown }>,
    options?: Record<string, unknown>,
  ): Promise<void> {
    return this.queue.sendBatch(messages, options);
  }
}
