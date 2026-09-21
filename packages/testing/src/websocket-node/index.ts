/**
 * `@velajs/testing/websocket-node`
 *
 * Node transport adapter for `module.ws(path).connect()`. Importing this module
 * (for its side effect) registers a WebSocket connector that:
 *   1. builds the app's Hono instance and a `@hono/node-ws` upgrade factory,
 *   2. registers every `@WebSocketGateway` via `@velajs/vela/websocket-node`,
 *   3. serves it on an ephemeral loopback port, and
 *   4. opens a real client `WebSocket` against it.
 *
 * `@hono/node-ws` and `@hono/node-server` are OPTIONAL peers, imported
 * dynamically — this module loads without them and only errs at `connect()`
 * time with an actionable message. Their types are declared locally so the
 * package typechecks without the peers installed. Cloudflare Durable-Object
 * WebSockets are exercised via `@velajs/cloudflare` + the workerd pool, not
 * this adapter.
 */
import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import type { VelaApplication } from '@velajs/vela';
import type { UpgradeWebSocket } from 'hono/ws';
import type { TestingModule } from '../testing-module.js';
import { TestWsConnection } from '../ws/test-ws-connection.js';
import { registerWsConnector } from '../ws/test-ws-request.js';

// Minimal shapes for the optional peers (avoids `typeof import(...)` which would
// fail to resolve when the peers are not installed).
interface NodeServerModule {
  serve: (
    options: { fetch: unknown; port: number },
    onListening?: (info: { port: number }) => void,
  ) => Server;
}
interface NodeWsModule {
  createNodeWebSocket: (options: { app: unknown }) => {
    injectWebSocket: (server: unknown) => void;
    upgradeWebSocket: UpgradeWebSocket;
    wss?: { close(callback: (error?: Error) => void): void };
  };
}
interface VelaWsNodeModule {
  registerWebSocketGateways: (app: VelaApplication, upgradeWebSocket: UpgradeWebSocket) => void;
}
interface WsPackage {
  default: new (
    url: string,
    protocols?: unknown,
    options?: { headers: Record<string, string> },
  ) => WebSocket;
}

interface RunningServer {
  port: number;
}

// One backing HTTP server per module; gateways are registered exactly once.
const serversByModule = new WeakMap<TestingModule, Promise<RunningServer>>();

async function importOptional<T>(specifier: string): Promise<T> {
  try {
    return (await import(specifier)) as T;
  } catch (error) {
    throw new Error(
      `[@velajs/testing/websocket-node] "${specifier}" is required for WebSocket ` +
        'connect() on Node but is not installed. Install the optional peers: ' +
        '`npm i -D @hono/node-ws @hono/node-server`.',
      { cause: error },
    );
  }
}

async function ensureServer(module: TestingModule): Promise<RunningServer> {
  const existing = serversByModule.get(module);
  if (existing) return existing;

  const started = (async (): Promise<RunningServer> => {
    const { serve } = await importOptional<NodeServerModule>('@hono/node-server');
    const { createNodeWebSocket } = await importOptional<NodeWsModule>('@hono/node-ws');
    const { registerWebSocketGateways } = await importOptional<VelaWsNodeModule>(
      '@velajs/vela/websocket-node',
    );

    const app = await module.createApplication();
    const hono = app.getHonoApp();

    const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({ app: hono });
    registerWebSocketGateways(app, upgradeWebSocket);

    const sockets = new Set<Socket>();
    let server: Server | undefined;
    const cleanup = async (): Promise<void> => {
      serversByModule.delete(module);
      // Upgraded sockets are not closed by HTTP server.close(). Track all sockets.
      for (const socket of sockets) socket.destroy();
      const outcomes = await Promise.allSettled([
        new Promise<void>((resolve, reject) => {
          if (!server?.listening) return resolve();
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
        new Promise<void>((resolve, reject) => {
          if (!wss) return resolve();
          wss.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
      ]);
      const failures = outcomes.flatMap((outcome) =>
        outcome.status === 'rejected' ? [outcome.reason] : [],
      );
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, 'WebSocket server cleanup failed');
    };
    try {
      const port = await new Promise<number>((resolve, reject) => {
        server = serve({ fetch: hono.fetch, port: 0 }, (info) => resolve(info.port));
        server.on('error', reject);
        server.on('connection', (socket) => {
          sockets.add(socket);
          socket.on('close', () => sockets.delete(socket));
        });
      });
      if (!server) throw new Error('WebSocket test server did not start');
      injectWebSocket(server);
      // Guard a close racing the asynchronous server startup; never orphan the listener.
      module.onClose(cleanup);
      server.unref();
      return { port };
    } catch (error) {
      await cleanup();
      throw error;
    }
  })();

  serversByModule.set(module, started);
  try {
    return await started;
  } catch (error) {
    serversByModule.delete(module);
    throw error;
  }
}

async function openClient(url: string, headers: Headers): Promise<WebSocket> {
  const headerEntries = [...headers.entries()];

  // The standard WebSocket client cannot set arbitrary upgrade headers. When
  // headers are needed (e.g. auth cookies), fall back to the `ws` package which
  // supports them; otherwise use the runtime's global WebSocket.
  if (headerEntries.length > 0) {
    const wsSpecifier = 'ws';
    try {
      const wsModule = (await import(wsSpecifier)) as WsPackage;
      return new wsModule.default(url, undefined, {
        headers: Object.fromEntries(headerEntries),
      });
    } catch {
      // `ws` not installed — proceed with the global client (headers dropped).
    }
  }

  if (typeof WebSocket === 'undefined') {
    throw new Error(
      '[@velajs/testing/websocket-node] No global WebSocket. Use Node >=22 or ' +
        'install the `ws` package.',
    );
  }
  return new WebSocket(url);
}

registerWsConnector(async (module, path, headers) => {
  const { port } = await ensureServer(module);
  const url = `ws://127.0.0.1:${port}${path}`;
  const ws = await openClient(url, headers);

  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError as EventListener);
    };
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (event: unknown): void => {
      cleanup();
      reject(new Error(`WebSocket failed to open: ${String(event)}`));
    };
    ws.addEventListener('open', onOpen);
    ws.addEventListener('error', onError as EventListener);
  });

  return new TestWsConnection(ws);
});
