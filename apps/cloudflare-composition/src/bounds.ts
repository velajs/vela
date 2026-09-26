// Application limits, not a replacement for native binding lifecycles.
export class RequestFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function deadline(parent: AbortSignal, milliseconds: number) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  if (parent.aborted) abort();
  else parent.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException('Deadline exceeded', 'TimeoutError')),
    milliseconds,
  );
  return {
    signal: controller.signal,
    abort: (reason: unknown) => controller.abort(reason),
    dispose() {
      clearTimeout(timer);
      parent.removeEventListener('abort', abort);
    },
  };
}

export function discard(body: ReadableStream<Uint8Array> | null): void {
  // A native producer may never settle cancel(). Cleanup must not extend deadlines.
  void body?.cancel().catch(() => {});
}

// Own the reader until EOF/error/cancel. Never enqueue the chunk crossing the limit.
export function limitStream(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
  onClose: (reason?: unknown) => void = () => {},
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let size = 0;
  let finished = false;
  let abort: () => void;
  function finish(reason?: unknown): void {
    if (finished) return;
    finished = true;
    signal.removeEventListener('abort', abort);
    if (reason !== undefined) {
      // Cancellation is best effort; do not wait for an uncooperative producer.
      void reader.cancel(reason).catch(() => {});
      reader.releaseLock();
    } else reader.releaseLock();
    onClose(reason);
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        if (finished) return;
        finish(signal.reason);
        controller.error(signal.reason);
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    },
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (finished) return;
        if (chunk.done) {
          finish();
          controller.close();
          return;
        }
        size += chunk.value.byteLength;
        if (size > maxBytes) throw new RequestFailure(413, 'Byte limit exceeded');
        controller.enqueue(chunk.value);
      } catch (error) {
        if (finished) return;
        finish(error);
        controller.error(error);
      }
    },
    cancel(reason) {
      finish(reason ?? new DOMException('Response cancelled', 'AbortError'));
    },
  });
}

export async function readBytes(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  if (signal.aborted) {
    discard(body);
    signal.throwIfAborted();
  }
  return body
    ? new Response(limitStream(body, maxBytes, signal)).arrayBuffer()
    : new ArrayBuffer(0);
}

// Quick Actions and Images output() cannot be interrupted through their native API.
// Stop waiting locally and cancel a late response body; do not claim upstream cancellation.
export function waitForResponse(
  pending: Promise<Response>,
  signal: AbortSignal,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    void pending.then(
      (response) => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) discard(response.body);
        else resolve(response);
        return undefined;
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

export const privateHeaders = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
