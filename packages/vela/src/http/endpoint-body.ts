import type { Context } from 'hono';
import {
  BadRequestException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '../errors/http-exception';
import type { EndpointBodyContract } from '../openapi/endpoint-body';

/** Bound raw bytes before invoking a native parser, after the endpoint's guards. */
export async function limitEndpointBody(context: Context, maxBytes: number): Promise<ArrayBuffer> {
  const request = context.req;
  if (request.raw.bodyUsed) {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > maxBytes)
      throw new PayloadTooLargeException('Endpoint body exceeds maxBytes');
    return bytes;
  }
  const read = async (): Promise<ArrayBuffer> => {
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
          throw new PayloadTooLargeException('Endpoint body exceeds maxBytes');
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
  };
  return read();
}

export async function extractEndpointForm(
  context: Context,
  body: Exclude<EndpointBodyContract, { contentType: 'application/json' }>,
): Promise<Record<string, FormDataEntryValue | FormDataEntryValue[]> | undefined> {
  if (context.req.raw.body === null) return undefined;
  const contentType = context.req.header('content-type');
  const media = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (!contentType || media !== body.contentType)
    throw new UnsupportedMediaTypeException(`Expected ${body.contentType} body`);
  const bytes = await limitEndpointBody(context, body.maxBytes);
  let form: FormData;
  try {
    form = await new Response(bytes, {
      headers: { 'content-type': contentType },
    }).formData();
  } catch (error) {
    if (error instanceof TypeError || error instanceof SyntaxError)
      throw new BadRequestException('Malformed form body');
    throw error;
  }
  const result: Record<string, FormDataEntryValue | FormDataEntryValue[]> = {};
  const fields = new Map(body.fields.map((field) => [field.name, field]));
  let textCount = 0;
  let fileCount = 0;
  const encoder = new TextEncoder();
  for (const [name, value] of form) {
    const file = typeof value !== 'string';
    if (file) {
      if (++fileCount > body.maxFiles) throw new PayloadTooLargeException('Form exceeds maxFiles');
      if (value.size > body.maxFileBytes)
        throw new PayloadTooLargeException('Form file exceeds maxFileBytes');
    } else {
      if (++textCount > body.maxFields)
        throw new PayloadTooLargeException('Form exceeds maxFields');
      if (encoder.encode(name).byteLength + encoder.encode(value).byteLength > body.maxFieldBytes)
        throw new PayloadTooLargeException('Form field exceeds maxFieldBytes');
    }
    const field = fields.get(name);
    if (!field) throw new BadRequestException(`Unknown form field: ${name}`);
    if (file !== field.file)
      throw new BadRequestException(`Form field ${name} must be ${field.file ? 'a file' : 'text'}`);
    if (Object.hasOwn(result, name)) {
      const previous = result[name];
      if (!field.multiple || !Array.isArray(previous))
        throw new BadRequestException(`Form field ${name} must not be repeated`);
      previous.push(value);
    } else {
      Object.defineProperty(result, name, {
        value: field.multiple ? [value] : value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return result;
}
