export interface HttpModuleOptions {
  /** Base URL prepended to all requests. */
  baseURL?: string;
  /** Default headers sent with every request. */
  headers?: Record<string, string>;
  /** Default timeout in milliseconds (uses AbortSignal.timeout). */
  timeout?: number;
}

export interface RequestConfig {
  headers?: Record<string, string>;
  params?: Record<string, string | number | boolean>;
  timeout?: number;
}

export interface HttpRequestConfig extends RequestConfig {
  method: string;
  url: string;
  body?: unknown;
}

export interface HttpResponse<T = unknown> {
  data: T;
  status: number;
  statusText: string;
  headers: Headers;
}
