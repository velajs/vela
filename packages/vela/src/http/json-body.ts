import type { Context } from 'hono';
import {
  BadRequestException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '../errors/http-exception';

export interface ReadJsonBodyOptions {
  /** Reject a body larger than this many bytes with 413 before parsing it. */
  maxBytes?: number;
}

// `application/json` or any structured-syntax `+json` media type (RFC 6839).
const JSON_MEDIA_TYPE = /^(?:application\/json|[\w!#$&^.+-]+\/[\w!#$&^.+-]+\+json)$/;

/**
 * Read at most `maxBytes` of the request body, after the route's guards.
 * Oversized bodies answer 413 as soon as the count passes the limit; the rest
 * of the stream is cancelled, never buffered.
 */
export async function readBoundedBody(c: Context, maxBytes: number): Promise<ArrayBuffer> {
  const request = c.req;
  if (Number(request.header('content-length')) > maxBytes)
    throw new PayloadTooLargeException('Request body exceeds the route limit');
  if (request.raw.bodyUsed) {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > maxBytes)
      throw new PayloadTooLargeException('Request body exceeds the route limit');
    return bytes;
  }
  const reader = request.raw.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        // A request clone may hold the other tee branch open. Do not wait
        // for that consumer before returning the bounded-body error.
        void reader.cancel().catch(() => {});
        throw new PayloadTooLargeException('Request body exceeds the route limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

/**
 * Parse a request's JSON body; `undefined` when the request has none.
 *
 * Hono's `c.req.json()` ignores Content-Type, and a browser sends a
 * `text/plain` or form-encoded POST cross-site without a CORS preflight. A body
 * is therefore parsed only under `application/json` or a `+json` media type
 * (parameters such as `charset` are allowed); any other body is a 415, and
 * malformed JSON is a 400.
 */
export async function readJsonBody(
  c: Context,
  options: ReadJsonBodyOptions = {},
): Promise<unknown> {
  if (c.req.raw.body === null || c.req.header('content-length') === '0') return undefined;
  const media = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (media === undefined || !JSON_MEDIA_TYPE.test(media)) {
    throw new UnsupportedMediaTypeException('Expected application/json body');
  }
  try {
    return options.maxBytes === undefined
      ? await c.req.json()
      : JSON.parse(new TextDecoder().decode(await readBoundedBody(c, options.maxBytes)));
  } catch (error) {
    if (error instanceof SyntaxError) throw new BadRequestException('Malformed JSON body');
    throw error;
  }
}
