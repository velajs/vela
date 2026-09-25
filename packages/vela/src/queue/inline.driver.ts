import type {
  AddJobOptions,
  QueueDispatchFn,
  QueueDriver,
  QueueDriverBindHooks,
  QueueJob,
} from './queue.types';

export interface InlineQueueOptions {
  /**
   * `immediate` (default): deliver on a microtask after `enqueue` resolves —
   * `add()` resolving does NOT mean the job was handled. Handler errors are
   * routed to the binding's error hook (container diagnostics), never thrown
   * into the detached microtask.
   *
   * `manual`: buffer until `flush()` — deterministic delivery for tests.
   */
  mode?: 'immediate' | 'manual';
}

export interface InlineQueueDriver extends QueueDriver {
  /**
   * Deliver everything buffered (manual mode; also drains jobs enqueued
   * before the driver was bound). Resolves with the delivered count; rejects
   * with an `AggregateError` after attempting ALL buffered jobs if any
   * handler error went unclaimed — the awaiter exists here, so the
   * platform-retry rethrow contract is meaningful.
   */
  flush(): Promise<number>;
  /** Jobs currently buffered (unbound immediate + all manual). */
  readonly size: number;
}

/**
 * In-process driver for dev, tests, and single-isolate apps. Edge-pure: no
 * timers — `immediate` mode uses `queueMicrotask`. `delayMs` is not
 * supported (warns once through the bound error hook's diagnostics side).
 */
export function inline(options: InlineQueueOptions = {}): InlineQueueDriver {
  const mode = options.mode ?? 'immediate';
  const buffer: QueueJob[] = [];
  let dispatch: QueueDispatchFn | undefined;
  let onError: QueueDriverBindHooks['onError'];
  let warnedDelay = false;
  let closed = false;

  const deliverDetached = (job: QueueJob): void => {
    const deliver = dispatch!;
    const report = onError;
    queueMicrotask(() => {
      if (closed) return;
      void deliver(job).catch((error) => report?.(error, job));
    });
  };

  return {
    kind: 'inline',

    get size(): number {
      return buffer.length;
    },

    async enqueue(job: QueueJob, addOptions?: AddJobOptions): Promise<void> {
      if (closed) throw new Error('inline() queue driver is closed.');
      if (addOptions?.delayMs !== undefined && !warnedDelay) {
        warnedDelay = true;
        console.warn(
          `[vela] inline() queue driver does not support delayMs — job '${job.name}' delivers without delay.`,
        );
      }
      if (mode === 'manual' || !dispatch) {
        buffer.push(job);
        return;
      }
      deliverDetached(job);
    },

    bind(fn: QueueDispatchFn, hooks?: QueueDriverBindHooks): () => void {
      if (dispatch || closed) {
        throw new Error(
          'inline() driver already belongs to an application. Use driver: () => inline() for isolated reuse.',
        );
      }
      dispatch = fn;
      onError = hooks?.onError;
      if (mode === 'immediate' && buffer.length > 0) {
        for (const job of buffer.splice(0)) deliverDetached(job);
      }
      return () => {
        closed = true;
        dispatch = undefined;
        onError = undefined;
        buffer.length = 0;
      };
    },

    async flush(): Promise<number> {
      if (!dispatch) return 0;
      const deliver = dispatch;
      const jobs = buffer.splice(0);
      const errors: unknown[] = [];
      let delivered = 0;
      for (const job of jobs) {
        try {
          if (closed) break;
          await deliver(job);
          delivered++;
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          `queue flush: ${errors.length} of ${jobs.length} jobs failed (${delivered} delivered)`,
        );
      }
      return delivered;
    },
  };
}
