export interface WorkflowEventStreamOptions extends WorkflowInstanceSubscribeOptions {
  instance: Pick<WorkflowInstance, 'id' | 'subscribe'>;
  /** Throw unless the current caller may read this instance, including its outputs.
   * Checked before opening and before/after each pending read. Use signal for
   * immediate revocation while next() is waiting. */
  authorize: (instanceId: string) => void | Promise<void>;
  signal?: AbortSignal;
}

/** Native execution events as a backpressured stream. Does not expose HTTP/SSE
 * routes. Cancel the reader/body on disconnect; disposal also occurs on abort,
 * authorization failure, native error, and normal completion. */
export async function workflowEventStream(
  options: WorkflowEventStreamOptions,
): Promise<ReadableStream<WorkflowInstanceEvent>> {
  const { instance, authorize, signal, ...subscribeOptions } = options;
  signal?.throwIfAborted();
  await authorize(instance.id);
  signal?.throwIfAborted();
  const subscription = await instance.subscribe(subscribeOptions);
  let disposed = false;
  let controller: ReadableStreamDefaultController<WorkflowInstanceEvent>;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener('abort', abort);
    subscription[Symbol.dispose]();
  };
  const abort = (): void => {
    if (disposed) return;
    controller.error(signal?.reason);
    dispose();
  };
  return new ReadableStream<WorkflowInstanceEvent>(
    {
      start(value) {
        controller = value;
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      },
      async pull() {
        try {
          await authorize(instance.id);
          if (disposed) return;
          const result = await subscription.next();
          if (disposed) return;
          await authorize(instance.id);
          if (disposed) return;
          if (result.done) {
            controller.close();
            dispose();
          } else controller.enqueue(result.value);
        } catch (error) {
          if (!disposed) {
            controller.error(error);
            dispose();
          }
        }
      },
      cancel: dispose,
    },
    { highWaterMark: 0 },
  );
}
