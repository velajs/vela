import { describe, expect, it } from 'vitest';
import { Module, VelaFactory, defineProvider, type VelaApplication } from '../index';
import type { RuntimeAdapter } from '../module-kit';
import {
  Gateways,
  WS_ROOM_REGISTRY,
  WS_SERVER,
  WS_TRANSPORT,
  WebSocketGateway,
  WebSocketModule,
  type GatewayDelivery,
  type WebSocketTransport,
  type WsClient,
} from '../websocket/index';

interface ChatEvents {
  message: { text: string };
  typing: undefined;
}

@WebSocketGateway({ path: '/rooms/:id/ws', roomParam: 'id', binding: 'ROOMS', maxFrameBytes: 256 })
class ChatGateway {}

@WebSocketGateway({ path: '/lobby' })
class LobbyGateway {}

class NotAGateway {}

class RoomClient implements WsClient {
  readonly rooms = new Set<string>();
  data: Record<string, unknown> = {};
  readonly raw = null;
  readonly frames: unknown[] = [];
  constructor(readonly id: string) {}
  send(): void {}
  sendRaw(payload: string): void {
    this.frames.push(JSON.parse(payload));
  }
  join(room: string): void {
    this.rooms.add(room);
  }
  leave(room: string): void {
    this.rooms.delete(room);
  }
  commit(): void {}
  close(): void {}
}

function transportAdapter(transport: WebSocketTransport): RuntimeAdapter {
  return {
    name: 'test-platform',
    configureContainer(container) {
      container.register(defineProvider(WS_TRANSPORT, { useValue: transport }));
      container.markGlobalToken(WS_TRANSPORT);
    },
  };
}

async function makeApp(adapters: RuntimeAdapter[] = []): Promise<VelaApplication> {
  @Module({ imports: [WebSocketModule.forRoot()], providers: [ChatGateway, LobbyGateway] })
  class AppModule {}
  return VelaFactory.create(AppModule, { adapters });
}

async function joined(app: VelaApplication, id: string, ...rooms: string[]): Promise<RoomClient> {
  const client = new RoomClient(id);
  const registry = app.get(WS_ROOM_REGISTRY);
  for (const room of rooms) {
    client.join(room);
    await registry.join(client, room);
  }
  return client;
}

describe('Gateways', () => {
  it("pushes to a gateway room's sockets in this process", async () => {
    const app = await makeApp();
    try {
      const inRoom = await joined(app, 'c1', 'general');
      const inBoth = await joined(app, 'c2', 'general', 'random');
      const elsewhere = await joined(app, 'c3', 'random');
      const chat = app.get(Gateways).of<ChatEvents>(ChatGateway);

      await chat.to('general').emit('message', { text: 'hello' });
      expect(inRoom.frames).toEqual([{ event: 'message', data: { text: 'hello' } }]);
      expect(inBoth.frames).toEqual([{ event: 'message', data: { text: 'hello' } }]);
      expect(elsewhere.frames).toEqual([]);

      await chat.to('general').in('random').emit('typing');
      expect(inBoth.frames).toHaveLength(2);
      expect(elsewhere.frames).toEqual([{ event: 'typing' }]);
    } finally {
      await app.close();
    }
  });

  it('refuses pushes that no room names, with guidance', async () => {
    const app = await makeApp();
    try {
      const chat = app.get(Gateways).of(ChatGateway);
      expect(() => chat.emit()).toThrow(/gateways\.of\(ChatGateway\)\.to\(room\)\.emit/);
      expect(() => chat.except('general')).toThrow(/every room it names/);
      expect(() => chat.to('general').except('random')).toThrow(/every room it names/);
      expect(() => chat.to('')).toThrow(/room ids/);
      expect(() => app.get(Gateways).of(NotAGateway)).toThrow(
        /NotAGateway is not a @WebSocketGateway/,
      );
    } finally {
      await app.close();
    }
  });

  it("bounds each push by the gateway's own frame limit", async () => {
    const app = await makeApp();
    try {
      const client = await joined(app, 'c1', 'general');
      const text = 'x'.repeat(300);
      const gateways = app.get(Gateways);
      await expect(
        gateways.of<ChatEvents>(ChatGateway).to('general').emit('message', { text }),
      ).rejects.toThrow(/256 frame bytes/);
      expect(client.frames).toEqual([]);

      await gateways.of<ChatEvents>(LobbyGateway).to('general').emit('message', { text });
      expect(client.frames).toEqual([{ event: 'message', data: { text } }]);
    } finally {
      await app.close();
    }
  });

  it('hands each gateway room to a transport that delivers pushes', async () => {
    const deliveries: GatewayDelivery[] = [];
    const transport: WebSocketTransport = {
      async deliver(delivery) {
        deliveries.push(delivery);
      },
    };
    const app = await makeApp([transportAdapter(transport)]);
    try {
      const client = await joined(app, 'c1', 'general');
      const gateways = app.get(Gateways);
      await gateways.of<ChatEvents>(ChatGateway).to('general').to('random').emit('typing');
      await gateways.of<ChatEvents>(LobbyGateway).to('a').to('b').emit('message', { text: 'hi' });

      const typing = JSON.stringify({ event: 'typing' });
      const message = JSON.stringify({ event: 'message', data: { text: 'hi' } });
      expect(deliveries).toEqual([
        {
          gatewayPath: '/rooms/:id/ws',
          binding: 'ROOMS',
          room: 'general',
          command: { rooms: ['general', 'random'], frame: typing },
        },
        {
          gatewayPath: '/rooms/:id/ws',
          binding: 'ROOMS',
          room: 'random',
          command: { rooms: ['general', 'random'], frame: typing },
        },
        // A gateway without roomParam holds every socket in the room its path names.
        {
          gatewayPath: '/lobby',
          room: '/lobby',
          command: { rooms: ['a', 'b'], frame: message },
        },
      ]);
      // The transport owns delivery: nothing reached this process's registry.
      expect(client.frames).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("points the injected server at Gateways when a transport's sockets live elsewhere", async () => {
    const transport: WebSocketTransport = { deliver: async () => {} };
    const app = await makeApp([transportAdapter(transport)]);
    try {
      const server = app.get(WS_SERVER);
      const guidance = /gateways\.of\(Gateway\)\.to\(room\)\.emit\(event, data\)/;
      expect(() => server.emit('ping')).toThrow(guidance);
      expect(() => server.to('general')).toThrow(guidance);
      expect(() => server.in('general')).toThrow(guidance);
      expect(() => server.except('general')).toThrow(guidance);
    } finally {
      await app.close();
    }
  });
});

// Type-level contract: the event map types each push.
export async function typedPushes(gateways: Gateways): Promise<void> {
  const chat = gateways.of<ChatEvents>(ChatGateway);
  await chat.to('general').emit('message', { text: 'hello' });
  await chat.to('general').emit('typing');
  // @ts-expect-error An event outside the map is rejected.
  await chat.to('general').emit('unknown', {});
  // @ts-expect-error The payload follows the event map.
  await chat.to('general').emit('message', { text: 1 });
  // @ts-expect-error An event with a payload requires it.
  await chat.to('general').emit('message');
  // @ts-expect-error A push names its rooms first.
  chat.emit('message', { text: 'hello' });
  const untyped = gateways.of(LobbyGateway);
  await untyped.to('lobby').emit('anything', { free: true });
}
