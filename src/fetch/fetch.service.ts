import { Inject, Injectable, InjectionToken, Optional } from '../container/index';
import type { HttpModuleOptions, HttpRequestConfig, HttpResponse, RequestConfig } from './fetch.types';

export const HTTP_MODULE_OPTIONS = new InjectionToken<HttpModuleOptions>('HTTP_MODULE_OPTIONS');

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

@Injectable()
export class HttpService {
  private readonly baseURL: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly defaultTimeout: number | undefined;

  constructor(@Optional() @Inject(HTTP_MODULE_OPTIONS) options: HttpModuleOptions) {
    const opts = options ?? {};
    this.baseURL = opts.baseURL ?? '';
    this.defaultHeaders = opts.headers ?? {};
    this.defaultTimeout = opts.timeout;
  }

  get<T = unknown>(url: string, config?: RequestConfig): Promise<HttpResponse<T>> {
    return this.request<T>({ method: 'GET', url, ...config });
  }

  post<T = unknown>(url: string, body?: unknown, config?: RequestConfig): Promise<HttpResponse<T>> {
    return this.request<T>({ method: 'POST', url, body, ...config });
  }

  put<T = unknown>(url: string, body?: unknown, config?: RequestConfig): Promise<HttpResponse<T>> {
    return this.request<T>({ method: 'PUT', url, body, ...config });
  }

  patch<T = unknown>(url: string, body?: unknown, config?: RequestConfig): Promise<HttpResponse<T>> {
    return this.request<T>({ method: 'PATCH', url, body, ...config });
  }

  delete<T = unknown>(url: string, config?: RequestConfig): Promise<HttpResponse<T>> {
    return this.request<T>({ method: 'DELETE', url, ...config });
  }

  head(url: string, config?: RequestConfig): Promise<HttpResponse<void>> {
    return this.request<void>({ method: 'HEAD', url, ...config });
  }

  async request<T = unknown>(config: HttpRequestConfig): Promise<HttpResponse<T>> {
    const fullUrl = this.buildUrl(config.url, config.params);
    const headers: Record<string, string> = { ...this.defaultHeaders, ...config.headers };

    const init: RequestInit = { method: config.method, headers };

    if (config.body !== undefined) {
      if (typeof config.body === 'string' || config.body instanceof FormData) {
        init.body = config.body as string | FormData;
      } else {
        init.body = JSON.stringify(config.body);
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }
      }
    }

    const timeout = config.timeout ?? this.defaultTimeout;
    if (timeout !== undefined) {
      init.signal = AbortSignal.timeout(timeout);
    }

    const response = await fetch(fullUrl, init);

    if (!response.ok) {
      throw new HttpRequestException(response.status, response.statusText, response);
    }

    const data = await this.parseBody<T>(response);

    return {
      data,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    };
  }

  private buildUrl(url: string, params?: Record<string, string | number | boolean>): string {
    const base = this.baseURL ? `${this.baseURL}${url}` : url;
    if (!params || Object.keys(params).length === 0) return base;
    const searchParams = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)] as [string, string]),
    );
    return `${base}?${searchParams.toString()}`;
  }

  private async parseBody<T>(response: Response): Promise<T> {
    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return undefined as T;
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      return response.json() as Promise<T>;
    }
    return response.text() as Promise<T>;
  }
}
