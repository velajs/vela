import type { Context } from 'hono';
import type { ContentfulStatusCode, StatusCode } from 'hono/utils/http-status';
import type { ValidationSchema } from '../validation/parse-schema';
import type { RouteContractMetadata } from './route-contract';

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

/**
 * Send the final result of a route that declares a contract: the status the
 * route resolved, the body its `response` schema parsed, in its format. A
 * ready `Response` is sent as is.
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
  let value = result;
  if (contract.response && contract.validate) {
    try {
      value = await parseResult(contract.response, result);
    } catch (cause) {
      throw new Error(`${source} returned a value its response schema rejects`, { cause });
    }
  }
  const format = contract.format;
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
