import { afterEach, describe, expect, it, vi } from 'vitest';
import { Module } from '@velajs/vela';
import { WebSocketModule } from '@velajs/vela/websocket';
import { LiveModule } from '@velajs/vela/live';
import { createCloudflareApp } from '../cloudflare-factory';
import { buildDoRuntime } from '../websocket/do-bootstrap';
import { CloudflareWebSocketModule } from '../websocket/cloudflare-websocket.module';
import { durableObjectLive } from '../websocket/do-live';
import type { LiveNamespace } from '../websocket/do-live';
import type { DoStateLike, WsLike } from '../websocket/do-state';

afterEach(() => {
  vi.restoreAllMocks();
});

class EmptyDoState implements DoStateLike {
  readonly id = { toString: () => 'do-1', name: 'room-1' };
  acceptWebSocket(): void {}
  getWebSockets(): WsLike[] {
    return [];
  }
}

const unusedNamespace: LiveNamespace = {
  idFromName(): DurableObjectId {
    throw new Error('not used');
  },
  get() {
    throw new Error('not used');
  },
};

describe('Durable Object WebSocket wiring', () => {
  it('rejects the core WebSocketModule inside a WebSocket Durable Object', async () => {
    @Module({ imports: [WebSocketModule.forRoot({})] })
    class CoreTransport {}

    await expect(buildDoRuntime(CoreTransport, new EmptyDoState(), { env: {} })).rejects.toThrow(
      /import CloudflareWebSocketModule\.forRoot\(\) instead of WebSocketModule/,
    );
  });

  it('binds the Cloudflare WebSocket server holder', async () => {
    @Module({ imports: [CloudflareWebSocketModule.forRoot()] })
    class CloudflareTransport {}

    const runtime = await buildDoRuntime(CloudflareTransport, new EmptyDoState(), {
      env: {},
    });
    await runtime.close();
  });
});

describe('Worker live driver wiring', () => {
  it('warns once when LiveModule delivers locally in the Worker isolate', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    @Module({ imports: [CloudflareWebSocketModule.forRoot(), LiveModule.forRoot({})] })
    class LocalLive {}

    const first = await createCloudflareApp(LocalLive, { env: {} });
    const second = await createCloudflareApp(LocalLive, { env: {} });
    const warnings = warn.mock.calls.filter(([message]) =>
      String(message).includes('localLive() in the Worker isolate'),
    );
    expect(warnings).toHaveLength(1);
    await Promise.all([first.close(), second.close()]);
  });

  it('stays quiet for the Durable Object live driver', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    @Module({
      imports: [
        CloudflareWebSocketModule.forRoot(),
        LiveModule.forRoot({
          driver: () =>
            durableObjectLive({ namespace: unusedNamespace, gatewayPath: '/rooms/:id/ws' }),
        }),
      ],
    })
    class RemoteLive {}

    const app = await createCloudflareApp(RemoteLive, { env: {} });
    expect(warn).not.toHaveBeenCalled();
    await app.close();
  });
});
