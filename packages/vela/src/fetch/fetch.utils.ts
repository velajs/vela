import type { HttpTransport } from './fetch.types';

export class HttpResponseSizeException extends Error {
  constructor(
    public readonly maxResponseBytes: number,
    public readonly receivedBytes: number,
  ) {
    super(`HTTP response exceeds the ${maxResponseBytes} byte buffer limit`);
    this.name = 'HttpResponseSizeException';
  }
}

export function validateLimit(
  name: string,
  value: number | undefined,
  maximum = Number.MAX_SAFE_INTEGER,
): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > maximum)) {
    throw new RangeError(`${name} must be an integer between 0 and ${maximum}`);
  }
}

export function validateTransport(transport: HttpTransport | undefined): void {
  if (transport === undefined || typeof transport === 'function') return;
  if (transport !== null && typeof transport === 'object' && typeof transport.fetch === 'function')
    return;
  throw new TypeError('transport must be a fetch function or an object with a fetch method');
}

export function composeSignal(
  caller: AbortSignal | undefined,
  timeout: number | undefined,
): {
  signal: AbortSignal | undefined;
  dispose: () => void;
} {
  if (timeout === undefined) return { signal: caller, dispose: () => {} };
  const controller = new AbortController();
  const cancel = () => controller.abort(caller?.reason);
  if (caller?.aborted) cancel();
  else caller?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException('The HTTP request timed out', 'TimeoutError')),
    timeout,
  );
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      caller?.removeEventListener('abort', cancel);
    },
  };
}

/** Also bounds transports and validators which do not implement cancellation themselves. */
export function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', cancel);
        return resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', cancel);
        reject(error);
      },
    );
  });
}

export async function readResponse(
  response: Response,
  method: string,
  maximum: number | undefined,
  signal?: AbortSignal,
): Promise<unknown> {
  if (method.toUpperCase() === 'HEAD' || response.status === 204 || response.status === 205) {
    void response.body?.cancel().catch(() => {});
    return undefined;
  }
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  try {
    while (true) {
      signal?.throwIfAborted();
      // Stream reads are sequential so the limit is enforced before requesting more bytes.
      // oxlint-disable-next-line no-await-in-loop
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      received += value.byteLength;
      if (maximum !== undefined && received > maximum) {
        throw new HttpResponseSizeException(maximum, received);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    // Do not wait for an uncooperative underlying source to acknowledge cancellation.
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (received === 0 && response.headers.get('content-length') === '0') return undefined;
  const contentType =
    response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return contentType === 'application/json' || contentType.endsWith('+json')
    ? (JSON.parse(text) as unknown)
    : text;
}
