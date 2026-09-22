import type { ValidationSchema } from '../validation/parse-schema';

/** A fetch function; the client supplies a URL string and standard request options. */
export type HttpFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Accepts native fetch functions and objects such as Workers service bindings. */
export type HttpTransport = HttpFetch | { fetch: HttpFetch };

export interface HttpClientRequest {
  readonly method: string;
  readonly url: string;
  /** Mutable request headers, for propagation before the transport runs. */
  readonly headers: Headers;
}

export interface HttpClientResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
}

/** Per-request hooks. Errors from observers never replace the request outcome. */
export interface HttpClientRequestObserver {
  onResponse?(response: HttpClientResponse): void;
  onError?(error: unknown): void;
  onEnd?(): void;
}

/** Optional instrumentation seam. onRequest runs synchronously before transport. */
export interface HttpClientObserver {
  onRequest(request: HttpClientRequest): HttpClientRequestObserver | void;
}

export interface HttpModuleOptions {
  /** Literal prefix prepended to all request URLs (not URL-relative resolution). */
  baseURL?: string;
  /** Default headers sent with every request. */
  headers?: HeadersInit;
  /** Default timeout in milliseconds, through response reading and validation. */
  timeout?: number;
  /** Default maximum buffered response bytes. Omit for no limit. */
  maxResponseBytes?: number;
  /** Defaults to globalThis.fetch; objects retain their fetch receiver. */
  transport?: HttpTransport;
  observer?: HttpClientObserver;
}

export interface RequestConfig<S extends ValidationSchema | undefined = undefined> {
  headers?: HeadersInit;
  params?: Record<string, string | number | boolean>;
  timeout?: number;
  signal?: AbortSignal;
  maxResponseBytes?: number;
  transport?: HttpTransport;
  /** Validate the decoded response and infer its transformed output. */
  schema?: S;
}

export interface HttpRequestConfig<
  S extends ValidationSchema | undefined = undefined,
> extends RequestConfig<S> {
  method: string;
  url: string;
  /** Web BodyInit values are forwarded; other defined values are JSON serialized. */
  body?: unknown;
}

export interface HttpResponse<T = unknown> {
  data: T;
  status: number;
  statusText: string;
  headers: Headers;
}
