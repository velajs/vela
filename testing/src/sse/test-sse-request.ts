// Adapted from @stratal/testing (MIT, © Temitayo Fadojutimi). Auth uses the
// generic resolver seam instead of a hard AuthService import.
import { expect } from 'vitest';
import type { ActingAsResolver, TestPrincipal, TestingModule } from '../testing-module.js';
import { TestSseConnection } from './test-sse-connection.js';

/**
 * TestSseRequest
 *
 * Builder for a Server-Sent Events connection. `connect()` issues a GET through
 * `module.fetch()`, asserts a `text/event-stream` 200, and wraps the streaming
 * body in a {@link TestSseConnection}.
 *
 * @example
 * ```ts
 * const sse = await module.sse('/stream/events').connect();
 * await sse.assertEvent({ event: 'message', data: 'hello' });
 * ```
 */
export class TestSseRequest {
  private readonly requestHeaders = new Headers();
  private principal: TestPrincipal | null = null;
  private resolver: ActingAsResolver | null = null;

  constructor(
    private readonly path: string,
    private readonly module: TestingModule,
  ) {}

  /** Merge additional headers onto the SSE request. */
  withHeaders(headers: Record<string, string>): this {
    for (const [key, value] of Object.entries(headers)) {
      this.requestHeaders.set(key, value);
    }
    return this;
  }

  /** Authenticate the connection (see {@link TestHttpRequest.actingAs}). */
  actingAs(principal: TestPrincipal, resolver?: ActingAsResolver): this {
    this.principal = principal;
    this.resolver = resolver ?? null;
    return this;
  }

  /** Open the stream and return a live {@link TestSseConnection}. */
  async connect(): Promise<TestSseConnection> {
    await this.applyAuthentication();

    this.requestHeaders.set('Accept', 'text/event-stream');

    const url = new URL(this.path, 'http://localhost');
    const request = new Request(url.toString(), { headers: this.requestHeaders });

    const response = await this.module.fetch(request);

    expect(response.status, `Expected status 200, got ${response.status}`).toBe(200);

    const contentType = response.headers.get('content-type') ?? '';
    expect(
      contentType.includes('text/event-stream'),
      `Expected content-type "text/event-stream", got "${contentType}"`,
    ).toBe(true);

    return new TestSseConnection(response);
  }

  private async applyAuthentication(): Promise<void> {
    if (!this.principal) return;

    const resolver = this.resolver ?? this.module.getAuthResolver();
    if (!resolver) {
      throw new Error(
        'actingAs() requires an auth resolver. Pass one explicitly or register ' +
          'a default with module.setAuthResolver(resolver).',
      );
    }

    const headers = await resolver(this.module, this.principal);
    for (const [key, value] of headers.entries()) {
      this.requestHeaders.set(key, value);
    }
  }
}
