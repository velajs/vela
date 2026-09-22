import { ReliabilityError } from '../types';
import { fingerprint, integer, object, text } from '../validation';

export interface StoredHttpResult {
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
}
export interface HttpResultOptions {
  readonly maxBodyBytes?: number;
  readonly maxHeaderBytes?: number;
  readonly maxHeaderCount?: number;
  readonly headers?: readonly string[];
}
const MAX_BODY = 262_144;
const excluded = new Set([
  'set-cookie',
  'connection',
  'transfer-encoding',
  'content-length',
  'content-encoding',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
]);
function unavailable(message: string): never {
  throw new ReliabilityError('RESULT_UNAVAILABLE', message);
}
function selectedHeaders(headers: Headers, options: HttpResultOptions): [string, string][] {
  const byteLimit = integer(options.maxHeaderBytes ?? 8192, 'maxHeaderBytes', 1, 65_536);
  const countLimit = integer(options.maxHeaderCount ?? 32, 'maxHeaderCount', 1, 256);
  const allow = new Set(
    (options.headers ?? ['content-type', 'cache-control', 'etag', 'location']).map((key) =>
      text(key, 'header name', 256).toLowerCase(),
    ),
  );
  const connection = new Set(
    (headers.get('connection') ?? '').split(',').map((key) => key.trim().toLowerCase()),
  );
  const result: [string, string][] = [];
  let bytes = 0;
  for (const [key, value] of headers) {
    if (!allow.has(key) || excluded.has(key) || connection.has(key)) continue;
    bytes += new TextEncoder().encode(key + value).byteLength;
    if (bytes > byteLimit || result.length >= countLimit)
      unavailable('Replay header limit exceeded');
    result.push([key, value]);
  }
  return result;
}
async function boundedBody(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Stream reads are ordered and stop at the byte bound.
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) unavailable('Replay body is not a byte stream');
      size += value.byteLength;
      if (size > limit) unavailable('Replay body byte limit exceeded');
      chunks.push(value);
    }
  } catch (error) {
    // A tee branch may never resolve cancellation until its sibling is read.
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}
function base64(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}
/** Consumes response.body. Persist the result before returning replayHttpResult(result). */
export async function captureHttpResult(
  response: Response,
  options: HttpResultOptions = {},
): Promise<StoredHttpResult> {
  if (!(response instanceof Response) || response.status < 200 || response.status > 599)
    unavailable('Response cannot be replayed');
  if (
    response.headers.has('content-encoding') &&
    response.headers.get('content-encoding') !== 'identity'
  )
    unavailable('Capture the response before content encoding');
  const max = integer(options.maxBodyBytes ?? 32_768, 'maxBodyBytes', 0, MAX_BODY);
  const headers = selectedHeaders(response.headers, options);
  const body = await boundedBody(response.body, max);
  if ([204, 205, 304].includes(response.status) && body.length)
    unavailable('Bodyless response status has a body');
  return Object.freeze({
    status: response.status,
    headers: Object.freeze(headers.map((pair) => Object.freeze(pair))),
    body: base64(body),
  });
}
/** Validates persisted data without trusting a JSON cast. */
export function parseHttpResult(value: unknown): StoredHttpResult {
  const record = object(value);
  const status = integer(record.status, 'HTTP status', 200, 599);
  if (!Array.isArray(record.headers) || record.headers.length > 256)
    unavailable('Invalid stored headers');
  const headers: [string, string][] = [];
  let size = 0;
  for (const pair of record.headers) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== 'string' ||
      typeof pair[1] !== 'string'
    )
      unavailable('Invalid stored header');
    const key = text(pair[0], 'header name', 256).toLowerCase();
    if (
      excluded.has(key) ||
      pair[1].includes('\r') ||
      pair[1].includes('\n') ||
      pair[1].includes('\0')
    )
      unavailable('Unsafe stored header');
    size += new TextEncoder().encode(key + pair[1]).byteLength;
    if (size > 65_536) unavailable('Stored header limit exceeded');
    // Native validation checks HTTP token syntax as well.
    const validated = new Headers([[key, pair[1]]]);
    headers.push([key, validated.get(key)!]);
  }
  if (
    typeof record.body !== 'string' ||
    record.body.length > Math.ceil(MAX_BODY / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(record.body)
  )
    unavailable('Invalid stored body');
  const decoded = atob(record.body);
  if (decoded.length > MAX_BODY || ([204, 205, 304].includes(status) && decoded.length))
    unavailable('Invalid stored body length');
  return Object.freeze({
    status,
    headers: Object.freeze(headers.map((pair) => Object.freeze(pair))),
    body: record.body,
  });
}
export function replayHttpResult(value: unknown): Response {
  const result = parseHttpResult(value);
  const body = Uint8Array.from(atob(result.body), (char) => char.charCodeAt(0));
  return new Response([204, 205, 304].includes(result.status) ? null : body, {
    status: result.status,
    headers: result.headers.map(([key, header]) => [key, header]),
  });
}
/** Reads a clone. Authentication supplies principal; the URL and selected headers enter the digest. */
export async function fingerprintRequest(
  request: Request,
  options: HttpResultOptions & { readonly operation: string; readonly principal: string },
): Promise<string> {
  const operation = text(options.operation, 'operation', 256);
  const principal = text(options.principal, 'principal');
  const body = await boundedBody(
    request.clone().body,
    integer(options.maxBodyBytes ?? 32_768, 'maxBodyBytes', 0, MAX_BODY),
  );
  return fingerprint(
    {
      operation,
      principal,
      method: request.method,
      url: request.url,
      headers: selectedHeaders(request.headers, {
        ...options,
        headers: options.headers ?? ['content-type'],
      }),
      body: base64(body),
    },
    1_048_576,
  );
}
