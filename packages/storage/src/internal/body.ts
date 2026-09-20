import type { Body } from '../storage.types';

const encoder = new TextEncoder();

/** Byte length when known synchronously; `undefined` for unknown-length streams. */
export function byteLengthOf(body: Body): number | undefined {
  if (typeof body === 'string') return encoder.encode(body).byteLength;
  if (body instanceof Blob) return body.size; // File extends Blob
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return undefined; // ReadableStream
}

/** True for the unknown-length stream case. */
export function isStream(body: Body): body is ReadableStream<Uint8Array> {
  return body instanceof ReadableStream;
}

/** Buffer any body into bytes (used for hashing / part chunking). */
export async function toBytes(body: Body): Promise<Uint8Array> {
  if (typeof body === 'string') return encoder.encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    // Copy into a fresh ArrayBuffer-backed view (the source buffer is
    // ArrayBufferLike, which may be a SharedArrayBuffer).
    const slice = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    return new Uint8Array(slice as ArrayBuffer);
  }
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  return new Uint8Array(await new Response(body).arrayBuffer()); // ReadableStream
}

/** View any body as a byte stream without buffering when it already is one. */
export function toStream(body: Body): ReadableStream<Uint8Array> {
  if (body instanceof ReadableStream) return body;
  const res = new Response(body as BodyInit);
  return res.body ?? emptyStream();
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

/** Wrap a stream so `onLoaded` is called with the cumulative byte count. */
export function countingStream(
  src: ReadableStream<Uint8Array>,
  onLoaded: (loaded: number) => void,
): ReadableStream<Uint8Array> {
  let loaded = 0;
  const reader = src.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      loaded += value.byteLength;
      onLoaded(loaded);
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** Concatenate ordered byte chunks into one buffer. */
export function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Yield fixed-size (`partSize`) chunks from a byte stream, buffering only one
 * part at a time. The final chunk may be smaller. Empty input yields nothing.
 */
export async function* chunkStream(
  src: ReadableStream<Uint8Array>,
  partSize: number,
): AsyncGenerator<Uint8Array> {
  const reader = src.getReader();
  let buffer: Uint8Array = new Uint8Array(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = buffer.length === 0 ? value : concatChunks([buffer, value]);
      while (buffer.byteLength >= partSize) {
        yield buffer.subarray(0, partSize);
        buffer = buffer.subarray(partSize);
      }
    }
    if (buffer.byteLength > 0) yield buffer;
  } finally {
    reader.releaseLock();
  }
}
