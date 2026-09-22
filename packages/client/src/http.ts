import type { Hono } from 'hono';
import type { BlankEnv, Schema } from 'hono/types';

// Keep HTTP opt-in: importing the live client does not load Hono's client.
export { hc, parseResponse, DetailedError } from 'hono/client';
export type {
  ApplyGlobalResponse,
  ClientRequestOptions,
  ClientResponse,
  InferRequestType,
  InferResponseType,
  PickResponseByStatusCode,
} from 'hono/client';
export type { StatusCode as HttpStatus } from 'hono/utils/http-status';

/** A generated HTTP contract. This imports no server code at runtime. */
export type HttpApp<Routes extends Schema> = Hono<BlankEnv, Routes>;

/** Generated form route metadata. Paths include prefixes and use :param segments. */
export interface HttpFormEncoding {
  readonly path: string;
  readonly method: string;
  readonly contentType: 'multipart/form-data' | 'application/x-www-form-urlencoded';
}

/**
 * Adapt hc's FormData to the route's declared encoding before calling fetch.
 * Supply the result as hc's fetch option; wrap per-call fetch overrides as well.
 * The transport receives the original signal, credentials and other init options.
 */
export function withFormEncoding(
  routes: readonly HttpFormEncoding[],
  transport: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  const matchers = routes.map((route) => ({
    ...route,
    segments: route.path.split('/'),
    method: route.method.toUpperCase(),
  }));
  return (input, init) => {
    const body = init?.body;
    if (!(body instanceof FormData)) return transport(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // hc permits relative base URLs in browsers. Only the path is used for matching.
    const segments = new URL(url, 'http://vela.invalid').pathname.split('/');
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const matches = matchers.filter(
      (candidate) =>
        candidate.method === method &&
        candidate.segments.length === segments.length &&
        candidate.segments.every((part, index) =>
          part.startsWith(':') ? segments[index] !== '' : part === segments[index],
        ),
    );
    const route = matches[0];
    if (!route) return transport(input, init);
    if (matches.some((candidate) => candidate.contentType !== route.contentType))
      throw new TypeError(
        'Ambiguous form route encodings; use disjoint paths or an explicit transport',
      );
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const contentType = headers.get('content-type');
    if (contentType && contentType.split(';', 1)[0]?.trim().toLowerCase() !== route.contentType)
      throw new TypeError(`Form Content-Type does not match ${route.contentType}`);
    if (route.contentType === 'multipart/form-data') {
      if (contentType)
        throw new TypeError('Let fetch set the multipart boundary; omit Content-Type');
      return transport(input, init);
    }
    const encoded = new URLSearchParams();
    for (const [name, value] of body) {
      if (typeof value !== 'string') throw new TypeError('URL-encoded forms cannot contain files');
      encoded.append(name, value);
    }
    headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
    return transport(input, { ...init, headers, body: encoded });
  };
}

/** Native fetch response with an honest unknown JSON boundary, including clones. */
export interface HttpResponse<Status extends number = number> extends Omit<
  Response,
  'json' | 'clone' | 'status'
> {
  readonly status: Status;
  json(): Promise<unknown>;
  clone(): HttpResponse<Status>;
}

/**
 * Select a native response consumption mode. Response/stream modes never read,
 * clone or buffer the body. Every HTTP status remains available to the caller;
 * use response mode to inspect status and headers before choosing a body reader.
 */
export function readHttpResponse<Status extends number>(
  response:
    | (Response & { readonly status: Status })
    | Promise<Response & { readonly status: Status }>,
  mode: 'response',
): Promise<HttpResponse<Status>>;
export function readHttpResponse(
  response: Response | Promise<Response>,
  mode: 'blob',
): Promise<Blob>;
export function readHttpResponse(
  response: Response | Promise<Response>,
  mode: 'stream',
): Promise<ReadableStream<Uint8Array> | null>;
export async function readHttpResponse(
  response: Response | Promise<Response>,
  mode: 'response' | 'blob' | 'stream',
): Promise<HttpResponse | Blob | ReadableStream<Uint8Array> | null> {
  const value = await response;
  if (mode === 'response') return value;
  if (mode === 'stream') return value.body;
  if (mode === 'blob') return value.blob();
  throw new TypeError('Unknown HTTP response consumption mode');
}
