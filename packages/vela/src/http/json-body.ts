import type { Context } from 'hono';
import { BadRequestException, UnsupportedMediaTypeException } from '../errors/http-exception';
import { limitEndpointBody } from './endpoint-body';

export interface ReadJsonBodyOptions {
  /** Reject a body larger than this many bytes with 413 before parsing it. */
  maxBytes?: number;
}

// `application/json` or any structured-syntax `+json` media type (RFC 6839).
const JSON_MEDIA_TYPE = /^(?:application\/json|[\w!#$&^.+-]+\/[\w!#$&^.+-]+\+json)$/;

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
      : JSON.parse(new TextDecoder().decode(await limitEndpointBody(c, options.maxBytes)));
  } catch (error) {
    if (error instanceof SyntaxError) throw new BadRequestException('Malformed JSON body');
    throw error;
  }
}
