import type { EndpointSchema } from './endpoint';

/** Native HTTP bodies are checked without consuming or cloning them. */
export type EndpointResponseFormat = 'binary' | 'stream' | 'response';
export type EndpointBinaryBody = Blob | ArrayBuffer | Uint8Array<ArrayBuffer>;
export type EndpointResponseOutput<Format extends EndpointResponseFormat> =
  | Response
  | (Format extends 'binary'
      ? EndpointBinaryBody
      : Format extends 'stream'
        ? ReadableStream<Uint8Array>
        : never);

export function endpointResponseSchema<Format extends EndpointResponseFormat>(
  format: Format,
): EndpointSchema<EndpointResponseOutput<Format>> {
  return {
    parse(value: unknown): EndpointResponseOutput<Format> {
      if (!isResponseOutput(value, format))
        throw new TypeError(
          `Endpoint ${format} output must be a native ${format === 'response' ? 'Response' : format === 'stream' ? 'ReadableStream or Response' : 'Blob, ArrayBuffer, Uint8Array or Response'}`,
        );
      if (value instanceof Response && (value.bodyUsed || value.body?.locked))
        throw new TypeError('Endpoint Response body must be unused and unlocked');
      if (value instanceof ReadableStream && value.locked)
        throw new TypeError('Endpoint stream must be unlocked');
      return value;
    },
    toJSONSchema: () => (format === 'response' ? {} : { type: 'string', format: 'binary' }),
  };
}

function isResponseOutput<Format extends EndpointResponseFormat>(
  value: unknown,
  format: Format,
): value is EndpointResponseOutput<Format> {
  if (value instanceof Response) return true;
  if (format === 'stream') return value instanceof ReadableStream;
  return format === 'binary' && isEndpointBinaryBody(value);
}

export function isEndpointBinaryBody(value: unknown): value is EndpointBinaryBody {
  return (
    value instanceof Blob ||
    value instanceof ArrayBuffer ||
    (value instanceof Uint8Array && value.buffer instanceof ArrayBuffer)
  );
}

export function endpointContentType(value: string | undefined): string {
  const contentType = value ?? 'application/octet-stream';
  // Contracts carry concrete media types. Parameters belong on native Response headers.
  if (!/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(contentType))
    throw new TypeError('Endpoint contentType must be a concrete media type without parameters');
  return contentType.toLowerCase();
}
