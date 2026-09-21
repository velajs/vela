/* eslint-disable no-await-in-loop -- Stream chunks must be consumed sequentially. */
/* eslint-disable promise/no-callback-in-promise -- Bridge completion and AbortSignal into one promise. */
/** One deadline covers fetch, body reading, retries and result decoding. */
export function createDeadline(timeoutMs: number, caller?: AbortSignal) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
    throw new RangeError('RPC timeoutMs must be between 0 and 2147483647 milliseconds');
  caller?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(caller?.reason);
  caller?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException('RPC deadline exceeded', 'TimeoutError')),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      caller?.removeEventListener('abort', abort);
    },
  };
}

export function withSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  onAbort?: () => void,
): Promise<T> {
  // Attach handlers even to an operation started immediately before abort.
  return new Promise((resolve, reject) => {
    const abort = () => {
      onAbort?.();
      reject(signal.reason);
    };
    const done = () => signal.removeEventListener('abort', abort);
    operation.then(
      (value) => {
        done();
        return resolve(value);
      },
      (error: unknown) => {
        done();
        return reject(error);
      },
    );
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

export async function readJson(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new SyntaxError('RPC response has no body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await withSignal(reader.read(), signal, () => {
        void reader.cancel(signal.reason).catch(() => {});
      });
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new RangeError('RPC response exceeds maxResponseBytes');
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    // Do not wait for an uncooperative stream cancellation after a deadline.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
