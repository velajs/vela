import { Inject, Injectable, InjectionToken, Optional } from '../container/index';
import {
  isValidationSchema,
  parseSchemaAsync,
  type SchemaOutput,
  type ValidationSchema,
} from '../validation/parse-schema';
import type {
  HttpClientObserver,
  HttpClientRequestObserver,
  HttpModuleOptions,
  HttpRequestConfig,
  HttpResponse,
  HttpTransport,
  RequestConfig,
} from './fetch.types';
import {
  abortable,
  composeSignal,
  readResponse,
  validateLimit,
  validateTransport,
} from './fetch.utils';

export const HTTP_MODULE_OPTIONS = /* @__PURE__ */ new InjectionToken<HttpModuleOptions>(
  'HTTP_MODULE_OPTIONS',
);

export class HttpRequestException extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly response: Response,
  ) {
    super(`HTTP ${status} ${statusText}`);
    this.name = 'HttpRequestException';
  }
}

type SchemaConfig<S extends ValidationSchema> = RequestConfig<S> & { schema: S };
type SchemaHttpConfig<S extends ValidationSchema> = HttpRequestConfig<S> & { schema: S };
type AnyConfig = RequestConfig<ValidationSchema | undefined>;

/** Instrumentation must never change an HTTP result, including rejected async hooks. */
function notify(callback: () => void): void {
  try {
    void Promise.resolve(callback()).catch(() => {});
  } catch {
    // Observers own reporting their own failures.
  }
}

@Injectable()
export class HttpService {
  private readonly baseURL: string;
  private readonly defaultHeaders: Headers;
  private readonly defaultTimeout: number | undefined;
  private readonly maxResponseBytes: number | undefined;
  private readonly transport: HttpTransport | undefined;
  private readonly observer: HttpClientObserver | undefined;

  constructor(@Optional() @Inject(HTTP_MODULE_OPTIONS) options: HttpModuleOptions) {
    const opts = options ?? {};
    validateLimit('timeout', opts.timeout, 2_147_483_647);
    validateLimit('maxResponseBytes', opts.maxResponseBytes);
    validateTransport(opts.transport);
    this.baseURL = opts.baseURL ?? '';
    this.defaultHeaders = new Headers(opts.headers);
    this.defaultTimeout = opts.timeout;
    this.maxResponseBytes = opts.maxResponseBytes;
    this.transport = opts.transport;
    this.observer = opts.observer;
  }

  get<S extends ValidationSchema>(
    url: string,
    config: SchemaConfig<S>,
  ): Promise<HttpResponse<SchemaOutput<S>>>;
  get<T = unknown>(url: string, config?: RequestConfig): Promise<HttpResponse<T>>;
  get(url: string, config?: AnyConfig): Promise<HttpResponse> {
    return this.request({ method: 'GET', url, ...config });
  }

  post<S extends ValidationSchema>(
    url: string,
    body: unknown,
    config: SchemaConfig<S>,
  ): Promise<HttpResponse<SchemaOutput<S>>>;
  post<T = unknown>(url: string, body?: unknown, config?: RequestConfig): Promise<HttpResponse<T>>;
  post(url: string, body?: unknown, config?: AnyConfig): Promise<HttpResponse> {
    return this.request({ method: 'POST', url, body, ...config });
  }

  put<S extends ValidationSchema>(
    url: string,
    body: unknown,
    config: SchemaConfig<S>,
  ): Promise<HttpResponse<SchemaOutput<S>>>;
  put<T = unknown>(url: string, body?: unknown, config?: RequestConfig): Promise<HttpResponse<T>>;
  put(url: string, body?: unknown, config?: AnyConfig): Promise<HttpResponse> {
    return this.request({ method: 'PUT', url, body, ...config });
  }

  patch<S extends ValidationSchema>(
    url: string,
    body: unknown,
    config: SchemaConfig<S>,
  ): Promise<HttpResponse<SchemaOutput<S>>>;
  patch<T = unknown>(url: string, body?: unknown, config?: RequestConfig): Promise<HttpResponse<T>>;
  patch(url: string, body?: unknown, config?: AnyConfig): Promise<HttpResponse> {
    return this.request({ method: 'PATCH', url, body, ...config });
  }

  delete<S extends ValidationSchema>(
    url: string,
    config: SchemaConfig<S>,
  ): Promise<HttpResponse<SchemaOutput<S>>>;
  delete<T = unknown>(url: string, config?: RequestConfig): Promise<HttpResponse<T>>;
  delete(url: string, config?: AnyConfig): Promise<HttpResponse> {
    return this.request({ method: 'DELETE', url, ...config });
  }

  head<S extends ValidationSchema>(
    url: string,
    config: SchemaConfig<S>,
  ): Promise<HttpResponse<SchemaOutput<S>>>;
  head(url: string, config?: RequestConfig): Promise<HttpResponse<void>>;
  head(url: string, config?: AnyConfig): Promise<HttpResponse> {
    return this.request({ method: 'HEAD', url, ...config });
  }

  request<S extends ValidationSchema>(
    config: SchemaHttpConfig<S>,
  ): Promise<HttpResponse<SchemaOutput<S>>>;
  request<T = unknown>(config: HttpRequestConfig): Promise<HttpResponse<T>>;
  request(config: HttpRequestConfig<ValidationSchema | undefined>): Promise<HttpResponse>;
  request(config: HttpRequestConfig<ValidationSchema | undefined>): Promise<HttpResponse> {
    return this.execute(config);
  }

  private async execute(
    config: HttpRequestConfig<ValidationSchema | undefined>,
  ): Promise<HttpResponse> {
    const { method, schema } = config;
    const timeout = config.timeout ?? this.defaultTimeout;
    const maxResponseBytes = config.maxResponseBytes ?? this.maxResponseBytes;
    validateLimit('timeout', config.timeout, 2_147_483_647);
    validateLimit('maxResponseBytes', config.maxResponseBytes);
    validateTransport(config.transport);
    if (config.signal !== undefined && !(config.signal instanceof AbortSignal)) {
      throw new TypeError('signal must be an AbortSignal');
    }
    if (schema !== undefined && !isValidationSchema(schema)) {
      throw new TypeError('schema must be a parser, Standard Schema, or schema descriptor');
    }

    const url = this.buildUrl(config.url, config.params);
    const headers = new Headers(this.defaultHeaders);
    new Headers(config.headers).forEach((value, key) => headers.set(key, value));
    const init: RequestInit & { duplex?: 'half' } = { method, headers };
    const body = config.body;
    if (body !== undefined) {
      if (isBodyInit(body)) {
        init.body = body;
        if (body instanceof FormData) headers.delete('content-type');
        if (body instanceof ReadableStream) init.duplex = 'half';
      } else {
        init.body = JSON.stringify(body);
        if (init.body === undefined) throw new TypeError('Request body is not JSON serializable');
        if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      }
    }

    const { signal, dispose } = composeSignal(config.signal, timeout);
    if (signal) init.signal = signal;
    let observer: HttpClientRequestObserver | void = undefined;
    try {
      observer = this.observer?.onRequest({ method, url, headers });
    } catch {
      // Instrumentation is optional and cannot prevent a request.
    }
    try {
      signal?.throwIfAborted();
      const transport = config.transport ?? this.transport;
      const pending = transport
        ? typeof transport === 'function'
          ? transport(url, init)
          : transport.fetch(url, init)
        : globalThis.fetch(url, init);
      // A custom transport may ignore cancellation. Dispose a response that arrives late.
      void pending.then(
        (response) => {
          if (signal?.aborted) void response.body?.cancel(signal.reason).catch(() => {});
          return undefined;
        },
        () => {},
      );
      const response = await abortable(pending, signal);
      notify(() =>
        observer?.onResponse?.({
          status: response.status,
          statusText: response.statusText,
          headers: new Headers(response.headers),
        }),
      );
      if (!response.ok) {
        throw new HttpRequestException(response.status, response.statusText, response);
      }

      const decoded = await readResponse(response, method, maxResponseBytes, signal);
      const data =
        schema === undefined ? decoded : await abortable(parseSchemaAsync(schema, decoded), signal);
      signal?.throwIfAborted();
      return {
        data,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      };
    } catch (error) {
      notify(() => observer?.onError?.(error));
      throw error;
    } finally {
      dispose();
      notify(() => observer?.onEnd?.());
    }
  }

  private buildUrl(url: string, params?: Record<string, string | number | boolean>): string {
    const base = `${this.baseURL}${url}`;
    if (!params || Object.keys(params).length === 0) return base;
    const fragmentIndex = base.indexOf('#');
    const path = fragmentIndex === -1 ? base : base.slice(0, fragmentIndex);
    const fragment = fragmentIndex === -1 ? '' : base.slice(fragmentIndex);
    const query = new URLSearchParams(
      Object.entries(params).map(([key, value]) => [key, String(value)]),
    ).toString();
    const separator = path.includes('?')
      ? path.endsWith('?') || path.endsWith('&')
        ? ''
        : '&'
      : '?';
    return `${path}${separator}${query}${fragment}`;
  }
}

function isBodyInit(value: unknown): value is BodyInit {
  return (
    typeof value === 'string' ||
    value instanceof FormData ||
    value instanceof URLSearchParams ||
    value instanceof Blob ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    value instanceof ReadableStream
  );
}
