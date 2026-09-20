// Adapted from @stratal/testing (MIT, © Temitayo Fadojutimi). Stratal's i18n
// `withLocale` is dropped (vela i18n differs — optional follow-up).
import type { TestingModule } from '../testing-module.js';
import { TestHttpRequest } from './test-http-request.js';

/**
 * TestHttpClient
 *
 * Fluent entry point for test HTTP requests. `forHost`/`withHeaders` return a
 * new immutable client; the verb methods start a {@link TestHttpRequest}.
 *
 * @example
 * ```ts
 * const res = await module.http
 *   .forHost('example.com')
 *   .post('/users')
 *   .withBody({ name: 'A' })
 *   .send();
 * res.assertCreated();
 * ```
 */
export class TestHttpClient {
  constructor(
    private readonly module: TestingModule,
    private readonly host: string | null = null,
    private readonly defaultHeaders: Headers = new Headers(),
  ) {}

  /**
   * Return a new client bound to `host`. Also sets the `Host` header so domain
   * routing works even when the runtime reads the header rather than the URL.
   */
  forHost(host: string): TestHttpClient {
    const headers = new Headers(this.defaultHeaders);
    headers.set('Host', host);
    return new TestHttpClient(this.module, host, headers);
  }

  /** Return a new client with additional default headers on every request. */
  withHeaders(headers: Record<string, string>): TestHttpClient {
    const next = new Headers(this.defaultHeaders);
    for (const [key, value] of Object.entries(headers)) {
      next.set(key, value);
    }
    return new TestHttpClient(this.module, this.host, next);
  }

  get(path: string): TestHttpRequest {
    return this.createRequest('GET', path);
  }

  post(path: string): TestHttpRequest {
    return this.createRequest('POST', path);
  }

  put(path: string): TestHttpRequest {
    return this.createRequest('PUT', path);
  }

  patch(path: string): TestHttpRequest {
    return this.createRequest('PATCH', path);
  }

  delete(path: string): TestHttpRequest {
    return this.createRequest('DELETE', path);
  }

  private createRequest(method: string, path: string): TestHttpRequest {
    return new TestHttpRequest(method, path, this.defaultHeaders, this.module, this.host);
  }
}
