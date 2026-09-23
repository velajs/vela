import { describe, it, expect, beforeEach } from 'vitest';
import { Module, MetadataRegistry } from '@velajs/vela';
import {
  WebSocketModule,
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  type UpgradeAuthenticator,
  type WebSocketUpgradeIdentity,
} from '@velajs/vela/websocket';
import { Test } from '../test.js';
// Side-effect import: registers the Node WebSocket transport connector. Safe to
// import even without the optional peers — they load lazily at connect() time.
import '../websocket-node/index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

// Gate the live-connect suite on the optional Node peers being installed.
let peersAvailable = false;
try {
  await import('@hono/node-ws');
  await import('@hono/node-server');
  // This header-free client path uses the runtime's WebSocket (Node >=22).
  peersAvailable = typeof WebSocket !== 'undefined';
} catch {
  peersAvailable = false;
}

describe.skipIf(!peersAvailable)('module.ws (Node transport)', () => {
  it('echoes a framed message over a real socket', async () => {
    class TestUpgradeAuthenticator implements UpgradeAuthenticator {
      authenticate(): WebSocketUpgradeIdentity {
        return {
          principal: { issuer: 'test', subject: 'u1', principalType: 'user' },
          tenantId: 't1',
          expiresAtMs: Date.now() + 60_000,
        };
      }
    }

    @WebSocketGateway({
      path: '/rooms/:id/ws',
      roomParam: 'id',
      authenticator: TestUpgradeAuthenticator,
    })
    class RoomGateway {
      @SubscribeMessage('echo')
      onEcho(@MessageBody() body: { text: string }) {
        return { event: 'echo', data: body.text.toUpperCase() };
      }
    }

    @Module({ imports: [WebSocketModule.forRoot({})], providers: [RoomGateway] })
    class AppModule {}

    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();

    const ws = await module.ws('/rooms/room1/ws').connect();
    ws.send(JSON.stringify({ event: 'echo', data: { text: 'hi' } }));

    const reply = await ws.waitForMessage();
    const parsed: unknown = JSON.parse(typeof reply === 'string' ? reply : '');
    expect(parsed).toEqual({ event: 'echo', data: 'HI' });

    const url = new URL(ws.raw.url);
    url.protocol = 'http:';
    const closed = ws.waitForClose();
    await Promise.all([module.close(), module.close()]);
    await closed;
    await expect(fetch(url)).rejects.toThrow();
    await expect(module.ws('/rooms/room1/ws').connect()).rejects.toThrow(/closed/);
  });
});
