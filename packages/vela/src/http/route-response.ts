import type { Context } from 'hono';
import type { ContentfulStatusCode, StatusCode } from 'hono/utils/http-status';
import type { ValidationSchema } from '../validation/parse-schema';
import type { RouteContractMetadata } from './route-contract';
import { mapResponse } from './response-mapper';

/** The route a request is executing: what it sends on success. */
export interface ExecutingRoute {
  readonly status: StatusCode;
  readonly contract?: RouteContractMetadata;
  /** `Controller.handler`, for errors. */
  readonly source: string;
}

const executing = new WeakMap<Context, ExecutingRoute>();
// A stored response a request replays, and what receives the one it sends.
const replays = new WeakMap<Context, Response>();
const senders = new WeakMap<Context, (response: Response) => Promise<void>>();

/** Record the route a request executes, for interceptors such as the response cache. */
export function enterRoute(c: Context, route: ExecutingRoute): void {
  executing.set(c, route);
}

/** The route the request is executing through the HTTP pipeline, if any. */
export function executingRoute(c: Context): ExecutingRoute | undefined {
  return executing.get(c);
}

/**
 * Replay a stored response: the route sends it as is. Interceptors outside
 * the one replaying it receive it; a value they return instead of a
 * `Response` is ignored.
 */
export function replayResponse(c: Context, response: Response): Response {
  replays.set(c, response);
  return response;
}

/** The response a request replays, if an interceptor replayed one. */
export function replayedResponse(c: Context): Response | undefined {
  return replays.get(c);
}

/**
 * Receive the response the route sends from its handler's result, with its
 * headers applied, before it leaves the route. Not called for a returned
 * `Response`, a redirect, an event stream or a native body.
 */
export function onResponseSent(c: Context, receive: (response: Response) => Promise<void>): void {
  senders.set(c, receive);
}

/** Hand the response the route sends to the receiver `onResponseSent` recorded. */
export async function responseSent(c: Context, response: Response): Promise<void> {
  await senders.get(c)?.(response);
}

// Parse a result through a response schema: a Standard Schema, a `parse()`
// parser, or a descriptor wrapping either. `parseAsync` comes first, so a
// Zod transform runs once instead of after a synchronous probe. A rejection is
// the handler's bug, answered as an internal error; the issues travel on the
// reported cause.
async function parseResult(schema: ValidationSchema, value: unknown): Promise<unknown> {
  if ('parseAsync' in schema && typeof schema.parseAsync === 'function')
    return schema.parseAsync(value);
  if ('~standard' in schema) {
    const result = await schema['~standard'].validate(value);
    if (result.issues) throw new Error('Response schema rejected the result', { cause: result });
    return result.value;
  }
  if ('parse' in schema && typeof schema.parse === 'function') return schema.parse(value);
  if ('schema' in schema) return parseResult(schema.schema, value);
  throw new TypeError('Response schema has no parse() or Standard Schema validator');
}

function hasBody(status: StatusCode): status is ContentfulStatusCode {
  return status !== 101 && status !== 204 && status !== 205 && status !== 304;
}

async function parseChecked(schema: ValidationSchema, value: unknown, source: string) {
  try {
    return await parseResult(schema, value);
  } catch (cause) {
    throw new Error(`${source} returned a value its response schema rejects`, { cause });
  }
}

/**
 * Send the final result of a route that declares a contract: the status the
 * route resolved, the body its `response` schema parsed, in its format. A
 * ready `Response` is sent as is; without `response` or `format`, the result
 * is sent as on a route without options.
 */
export async function sendRouteResult(
  c: Context,
  contract: RouteContractMetadata,
  status: StatusCode,
  result: unknown,
  source: string,
): Promise<Response> {
  if (result instanceof Response) return result;
  if (contract.response === null || !hasBody(status)) return c.body(null, status);
  const value =
    contract.response && contract.validate
      ? await parseChecked(contract.response, result, source)
      : result;
  const format = contract.format;
  if (format === undefined) return mapResponse(c, value, status);
  if (format === 'json') return value === undefined ? c.body(null, status) : c.json(value, status);
  if (format === 'text' && typeof value === 'string') return c.text(value, status);
  if (
    (format === 'stream' && value instanceof ReadableStream && !value.locked) ||
    (format === 'binary' &&
      (value instanceof Blob ||
        value instanceof ArrayBuffer ||
        (value instanceof Uint8Array && value.buffer instanceof ArrayBuffer)))
  )
    return new Response(value as BodyInit, {
      status,
      headers: { 'content-type': contract.contentType ?? 'application/octet-stream' },
    });
  throw new TypeError(`${source} must return a ${format} body or a Response`);
}
