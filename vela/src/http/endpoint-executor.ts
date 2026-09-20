import type { Context } from 'hono';
import { BadRequestException } from '../errors/http-exception';
import type { RuntimeEndpointDefinition } from '../openapi/endpoint';
import type { PipeTransform } from '../pipeline/types';

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

  let json: unknown;
  if (endpoint.hasJsonBody && context.req.raw.body !== null) {
    try {
      json = await context.req.json();
    } catch (error) {
      if (error instanceof SyntaxError) throw new BadRequestException('Malformed JSON body');
      throw error;
    }
  }

  let input: unknown = {
    ...(endpoint.inputSchema.properties?.param ? { param: context.req.param() } : {}),
    ...(endpoint.inputSchema.properties?.query ? { query } : {}),
    ...(endpoint.inputSchema.properties?.header ? { header: context.req.header() } : {}),
    ...(endpoint.hasJsonBody && json !== undefined ? { json } : {}),
  };
  for (const pipe of pipes) {
    // This route owns validation. Leaving metatype absent prevents a global
    // ValidationPipe from applying a transforming parser a second time.
    input = await pipe.transform(input, { type: 'custom' });
  }
  try {
    return [endpoint.input.parse(input)];
  } catch {
    throw new BadRequestException('Endpoint input validation failed');
  }
}

/** Validate the final interceptor result, not only the controller return value. */
export function mapEndpointResponse(
  context: Context,
  endpoint: RuntimeEndpointDefinition,
  result: unknown,
): Response {
  const value = endpoint.output.parse(result);
  if (endpoint.format === 'text') {
    if (typeof value !== 'string') throw new Error('Text endpoint output must be a string');
    return context.text(value, endpoint.status);
  }
  if (value === undefined) throw new Error('JSON endpoint output cannot be undefined');
  return context.json(value, endpoint.status);
}
