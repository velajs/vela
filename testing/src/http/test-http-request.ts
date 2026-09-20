// Adapted from @stratal/testing (MIT, © Temitayo Fadojutimi): stratal's hard
// AuthService import is replaced by a generic auth-resolver seam so
// @velajs/testing stays free of optional-package dependencies.
import type { ActingAsResolver, TestPrincipal, TestingModule } from '../testing-module.js';
import { TestResponse } from './test-response.js';

/**
 * TestHttpRequest
 *
 * Fluent builder for a single test HTTP request. `send()` builds a `Request`
 * and drives it through `module.fetch()` (the full Hono pipeline).
 *
 * @example
 * ```ts
 * const res = await module.http
 *   .post('/users')
 *   .withBody({ name: 'A' })
 *   .withHeaders({ 'X-Trace': '1' })
 *   .send();
 * res.assertCreated();
 * ```
 */
export class TestHttpRequest {
  private body: unknown = undefined;
  private readonly requestHeaders: Headers;
  private principal: TestPrincipal | null = null;
  private resolver: ActingAsResolver | null = null;

  constructor(
    private readonly method: string,
    private readonly path: string,
    headers: Headers,
    private readonly module: TestingModule,
    private readonly host: string | null = null,
  ) {
    this.requestHeaders = new Headers(headers);
  }

  /** Set the request body (JSON-serialized on send). */
  withBody(data: unknown): this {
    this.body = data;
    return this;
  }

  /** Merge additional headers. */
  withHeaders(headers: Record<string, string>): this {
    for (const [key, value] of Object.entries(headers)) {
      this.requestHeaders.set(key, value);
    }
    return this;
  }

  /** Set `Content-Type: application/json`. */
  asJson(): this {
    this.requestHeaders.set('Content-Type', 'application/json');
    return this;
  }

  /**
   * Authenticate the request as `principal`. The `resolver` (or a default one
   * registered via `module.setAuthResolver`) turns the principal into request
   * headers. The resolver signature `(module, principal) => Promise<Headers>`
   * is the cross-package contract sibling packages (e.g. `@velajs/better-auth`)
   * build against.
   */
  actingAs(principal: TestPrincipal, resolver?: ActingAsResolver): this {
    this.principal = principal;
    this.resolver = resolver ?? null;
    return this;
  }

  /** Build the `Request` and send it through `module.fetch()`. */
  async send(): Promise<TestResponse> {
    await this.applyAuthentication();

    const hasBody = this.body !== undefined && this.body !== null;
    if (hasBody && !this.requestHeaders.has('Content-Type')) {
      this.requestHeaders.set('Content-Type', 'application/json');
    }

    const url = new URL(this.path, `http://${this.host ?? 'localhost'}`);
    const request = new Request(url.toString(), {
      method: this.method,
      headers: this.requestHeaders,
      body: hasBody ? JSON.stringify(this.body) : null,
    });

    const response = await this.module.fetch(request);
    return new TestResponse(response);
  }

  private async applyAuthentication(): Promise<void> {
    if (!this.principal) return;

    const resolver = this.resolver ?? this.module.getAuthResolver();
    if (!resolver) {
      throw new Error(
        'actingAs() requires an auth resolver. Pass one explicitly — ' +
          'actingAs(principal, resolver) — or register a default with ' +
          'module.setAuthResolver(resolver). For better-auth: ' +
          'import { actingAs } from "@velajs/better-auth/testing".',
      );
    }

    const headers = await resolver(this.module, this.principal);
    for (const [key, value] of headers.entries()) {
      this.requestHeaders.set(key, value);
    }
  }
}
