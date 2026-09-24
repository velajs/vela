import type { Context } from 'hono';
import { BadRequestException } from '../errors/http-exception';
import type { RuntimeEndpointDefinition } from '../openapi/endpoint';
import { isEndpointBinaryBody } from '../openapi/endpoint-response';
import { parseSchemaAsync } from '../validation/parse-schema';
import { SchemaValidationError } from '../validation/standard-schema';
import type { PipeTransform } from '../pipeline/types';
import { extractEndpointForm } from './endpoint-body';
import { readJsonBody } from './json-body';

/** Extract HTTP wire values before the endpoint parser establishes their types. */
export async function extractEndpointInput(
  context: Context,
  endpoint: RuntimeEndpointDefinition,
  pipes: readonly PipeTransform[],
): Promise<unknown[]> {
  const arrayParameters = new Set(
    endpoint.queryParameters
      .filter((parameter) => parameter.multiple)
      .map((parameter) => parameter.name),
  );
  const query: Record<string, string | string[]> = {};
  for (const [name, values] of Object.entries(context.req.queries())) {
    // Preserve repeated scalar parameters so their parser can reject ambiguity.
    Object.defineProperty(query, name, {
      value: arrayParameters.has(name) || values.length !== 1 ? values : values[0],
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  const json = endpoint.hasJsonBody
    ? await readJsonBody(
        context,
        endpoint.body?.maxBytes === undefined ? {} : { maxBytes: endpoint.body.maxBytes },
      )
    : undefined;

  const form =
    endpoint.body && endpoint.body.contentType !== 'application/json'
      ? await extractEndpointForm(context, endpoint.body)
      : undefined;

  let input: unknown = {
    ...(endpoint.inputSchema.properties?.param ? { param: context.req.param() } : {}),
    ...(endpoint.inputSchema.properties?.query ? { query } : {}),
    ...(endpoint.inputSchema.properties?.header ? { header: context.req.header() } : {}),
    ...(endpoint.hasJsonBody && json !== undefined ? { json } : {}),
    ...(form !== undefined ? { form } : {}),
  };
  for (const pipe of pipes) {
    // This route owns validation. Leaving metatype absent prevents a global
    // ValidationPipe from applying a transforming parser a second time.
    input = await (pipe.transformAsync
      ? pipe.transformAsync(input, { type: 'custom' })
      : pipe.transform(input, { type: 'custom' }));
  }
  try {
    return [await parseSchemaAsync(endpoint.input, input)];
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      throw new BadRequestException('Endpoint input validation failed', {
        details: { issues: error.issues },
        cause: error,
      });
    }
    throw error;
  }
}

/** Validate the final interceptor result, not only the controller return value. */
export async function mapEndpointResponse(
  context: Context,
  endpoint: RuntimeEndpointDefinition,
  result: unknown,
): Promise<Response> {
  const value = await parseSchemaAsync(endpoint.output, result);
  if (
    endpoint.format === 'binary' ||
    endpoint.format === 'stream' ||
    endpoint.format === 'response'
  ) {
    if (value instanceof Response) return value;
    if (isEndpointBinaryBody(value) || value instanceof ReadableStream) {
      return new Response(value, {
        status: endpoint.status,
        headers: { 'content-type': endpoint.contentType ?? 'application/octet-stream' },
      });
    }
    throw new TypeError('Invalid native endpoint response');
  }
  if (endpoint.format === 'text') {
    if (typeof value !== 'string') throw new Error('Text endpoint output must be a string');
    return context.text(value, endpoint.status);
  }
  if (value === undefined) throw new Error('JSON endpoint output cannot be undefined');
  return context.json(value, endpoint.status);
}
