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
// The value a request's response schema already produced, sent as is.
const parsed = new WeakMap<Context, unknown>();

/** Record the route a request executes, for interceptors such as the response cache. */
export function enterRoute(c: Context, route: ExecutingRoute): void {
  executing.set(c, route);
}

/** The route the request is executing through the HTTP pipeline, if any. */
export function executingRoute(c: Context): ExecutingRoute | undefined {
  return executing.get(c);
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
 * Parse a result through the executing route's `response` schema, as the
 * route would before sending it. The route sends the returned value — or the
 * value later marked with `markParsed` — without parsing it again.
 */
export async function parseRouteResponse(c: Context, result: unknown): Promise<unknown> {
  const route = executing.get(c);
  const schema = route?.contract?.validate ? route.contract.response : undefined;
  if (!route || !schema || result instanceof Response || !hasBody(route.status)) return result;
  return markParsed(c, await parseChecked(schema, result, route.source));
}

/** Mark a value the route's response schema produced (a cached copy of one) as ready to send. */
export function markParsed<T>(c: Context, value: T): T {
  parsed.set(c, value);
  return value;
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
  const ready = parsed.has(c) && Object.is(parsed.get(c), result);
  const value =
    contract.response && contract.validate && !ready
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
