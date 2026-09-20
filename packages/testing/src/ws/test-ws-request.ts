// Adapted from @stratal/testing (MIT, © Temitayo Fadojutimi). Vela's WebSocket
// transport is pluggable and NOT reachable through a plain in-memory fetch, so
// the actual upgrade is delegated to a registered connector — provided by
// `@velajs/testing/websocket-node` for Node. The core harness never promises a
// universal `connect()`.
import type { ActingAsResolver, TestPrincipal, TestingModule } from '../testing-module.js';
import type { TestWsConnection } from './test-ws-connection.js';

/**
 * A transport adapter that performs the WebSocket upgrade and returns a live
 * connection. Registered by a platform package (e.g. websocket-node).
 */
export type WsConnector = (
  module: TestingModule,
  path: string,
  headers: Headers,
) => Promise<TestWsConnection>;

let registeredConnector: WsConnector | null = null;

/**
 * Register the transport that {@link TestWsRequest.connect} uses. Called by a
 * platform adapter's side-effect import (e.g. `@velajs/testing/websocket-node`).
 */
export function registerWsConnector(connector: WsConnector): void {
  registeredConnector = connector;
}

/** The currently registered WebSocket connector, if any. */
export function getWsConnector(): WsConnector | null {
  return registeredConnector;
}

/**
 * TestWsRequest
 *
 * Builder for a WebSocket connection. `connect()` requires a transport adapter
 * to be registered; without one it throws a clear, actionable error.
 *
 * @example
 * ```ts
 * import '@velajs/testing/websocket-node';
 * const ws = await module.ws('/ws/chat').connect();
 * ws.send('hi');
 * await ws.assertMessage('echo:hi');
 * ```
 */
export class TestWsRequest {
  private readonly requestHeaders = new Headers();
  private principal: TestPrincipal | null = null;
  private resolver: ActingAsResolver | null = null;

  constructor(
    private readonly path: string,
    private readonly module: TestingModule,
  ) {}

  /** Merge additional headers onto the upgrade request. */
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

  /** Open the socket via the registered transport adapter. */
  async connect(): Promise<TestWsConnection> {
    const connector = getWsConnector();
    if (!connector) {
      throw new Error(
        'WebSocket connect() requires a transport adapter. Import ' +
          '"@velajs/testing/websocket-node" (Node). Cloudflare Durable-Object ' +
          'WebSockets are exercised via @velajs/cloudflare + the workerd pool, ' +
          'not the core harness.',
      );
    }

    await this.applyAuthentication();

    return connector(this.module, this.path, this.requestHeaders);
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
