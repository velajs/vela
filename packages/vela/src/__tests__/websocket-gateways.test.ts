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
  WebSocketServer,
  type BroadcastCommand,
  type GatewayDelivery,
  type SyncDriver,
  type WebSocketModuleOptions,
  type WebSocketTransport,
  type WsClient,
  type WsServer,
} from '../websocket/index';

interface ChatEvents {
  message: { text: string };
  typing: undefined;
}

@WebSocketGateway({ path: '/rooms/:id/ws', roomParam: 'id', binding: 'ROOMS', maxFrameBytes: 256 })
class ChatGateway {
  constructor(@WebSocketServer() readonly server: WsServer) {}
}

@WebSocketGateway({ path: '/lobby' })
class LobbyGateway {}

@WebSocketGateway({ path: '/admin/:id/ws', roomParam: 'id' })
class AdminGateway {
  constructor(@WebSocketServer() readonly server: WsServer) {}
}

const CHAT = '/rooms/:id/ws';

class NotAGateway {}

class RoomClient implements WsClient {
  readonly rooms = new Set<string>();
  data: Record<string, unknown> = {};
  readonly raw = null;
  readonly frames: unknown[] = [];
  constructor(
    readonly id: string,
    readonly path: string,
  ) {}
  send(): void {}
  trySendRaw(payload: string): 'accepted' {
    this.sendRaw(payload);
    return 'accepted';
  }

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

async function makeApp(
  adapters: RuntimeAdapter[] = [],
  options: WebSocketModuleOptions = {},
): Promise<VelaApplication> {
  @Module({
    imports: [WebSocketModule.forRoot(options)],
    providers: [ChatGateway, LobbyGateway, AdminGateway],
  })
  class AppModule {}
  return VelaFactory.create(AppModule, { adapters });
}

/** A cross-instance sync driver that records each command it would fan out. */
function recordingBus(commands: BroadcastCommand[]): SyncDriver {
  return {
    kind: 'bus',
    bind() {},
    dispatch(command) {
      commands.push(command);
    },
  };
}

/** A socket of the gateway served on `path`, joined to `rooms` in this process. */
async function joined(
  app: VelaApplication,
  id: string,
  path: string,
  ...rooms: string[]
): Promise<RoomClient> {
  const client = new RoomClient(id, path);
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
      const inRoom = await joined(app, 'c1', CHAT, 'general');
      const inBoth = await joined(app, 'c2', CHAT, 'general', 'random');
      const elsewhere = await joined(app, 'c3', CHAT, 'random');
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

  it("reaches only the named gateway's sockets when gateways share a room id", async () => {
    const app = await makeApp();
    try {
      const chatMember = await joined(app, 'c1', CHAT, 'org-1');
      const admin = await joined(app, 'c2', '/admin/:id/ws', 'org-1');
      const lobbyMember = await joined(app, 'c3', '/lobby', 'org-1');
      const gateways = app.get(Gateways);

      await gateways.of(AdminGateway).to('org-1').emit('audit', { action: 'role.granted' });
      expect(admin.frames).toEqual([{ event: 'audit', data: { action: 'role.granted' } }]);
      expect(chatMember.frames).toEqual([]);
      expect(lobbyMember.frames).toEqual([]);

      await gateways.of<ChatEvents>(ChatGateway).to('org-1').emit('typing');
      expect(chatMember.frames).toEqual([{ event: 'typing' }]);
      expect(admin.frames).toHaveLength(1);
      expect(lobbyMember.frames).toEqual([]);
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
      const chatMember = await joined(app, 'c1', CHAT, 'general');
      const lobbyMember = await joined(app, 'c2', '/lobby', 'general');
      const text = 'x'.repeat(300);
      const gateways = app.get(Gateways);
      await expect(
        gateways.of<ChatEvents>(ChatGateway).to('general').emit('message', { text }),
      ).rejects.toThrow(/256 frame bytes/);
      expect(chatMember.frames).toEqual([]);

      await gateways.of<ChatEvents>(LobbyGateway).to('general').emit('message', { text });
      expect(lobbyMember.frames).toEqual([{ event: 'message', data: { text } }]);
      expect(chatMember.frames).toEqual([]);
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
      const client = await joined(app, 'c1', CHAT, 'general');
      const gateways = app.get(Gateways);
      await gateways.of<ChatEvents>(ChatGateway).to('general').to('random').emit('typing');
      await gateways.of<ChatEvents>(LobbyGateway).to('a').to('b').emit('message', { text: 'hi' });

      const typing = {
        rooms: ['general', 'random'],
        gatewayPath: CHAT,
        frame: '{"event":"typing"}',
      };
      const message = JSON.stringify({ event: 'message', data: { text: 'hi' } });
      expect(deliveries).toEqual([
        { gatewayPath: CHAT, binding: 'ROOMS', room: 'general', command: typing },
        { gatewayPath: CHAT, binding: 'ROOMS', room: 'random', command: typing },
        // A gateway without roomParam holds every socket in the room its path names.
        {
          gatewayPath: '/lobby',
          room: '/lobby',
          command: { rooms: ['a', 'b'], gatewayPath: '/lobby', frame: message },
        },
      ]);
      // The transport owns delivery: nothing reached this process's registry.
      expect(client.frames).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('names the rooms a multi-room push failed to reach', async () => {
    const delivered: string[] = [];
    const outages = new Map([
      ['b', new Error('room b is unavailable')],
      ['c', new Error('room c is unavailable')],
    ]);
    const transport: WebSocketTransport = {
      async deliver({ room }) {
        const outage = outages.get(room);
        if (outage) throw outage;
        delivered.push(room);
      },
    };
    const app = await makeApp([transportAdapter(transport)]);
    try {
      const chat = app.get(Gateways).of<ChatEvents>(ChatGateway);
      const failure: unknown = await chat
        .to('a')
        .to('b')
        .to('c')
        .emit('typing')
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) return;
      expect(failure.message).toBe('2 of 3 ChatGateway room pushes failed: "b", "c"');
      expect(failure.errors.map((error: Error) => [error.message, error.cause])).toEqual([
        ['ChatGateway push to room "b" failed', outages.get('b')],
        ['ChatGateway push to room "c" failed', outages.get('c')],
      ]);
      expect(delivered).toEqual(['a']);

      // One failed room of two is still named.
      await expect(chat.to('a').to('b').emit('typing')).rejects.toThrow(
        '1 of 2 ChatGateway room pushes failed: "b"',
      );
      // A push to one room fails with the transport's own error.
      await expect(chat.to('c').emit('typing')).rejects.toBe(outages.get('c'));
    } finally {
      await app.close();
    }
  });

  it('refuses to push to a forwarded gateway when the transport cannot deliver pushes', async () => {
    const transport: WebSocketTransport = {
      forwardUpgrade: async () => new Response('forwarded'),
    };
    const app = await makeApp([transportAdapter(transport)]);
    try {
      // ChatGateway names a binding, so its upgrades and sockets live elsewhere.
      await expect(
        app.get(Gateways).of<ChatEvents>(ChatGateway).to('general').emit('typing'),
      ).rejects.toThrow(
        /ChatGateway's upgrades are forwarded[\s\S]*local\(\) sync driver[\s\S]*WebSocketTransport\.deliver\(\)/,
      );
      // Its own @WebSocketServer() refuses the same way instead of reaching no one.
      const { server } = app.get(ChatGateway);
      const guidance =
        /ChatGateway's @WebSocketServer\(\) cannot reach its sockets[\s\S]*forwarded[\s\S]*local\(\) sync driver[\s\S]*WebSocketTransport\.deliver\(\)[\s\S]*createServer\(\)/;
      expect(() => server.emit('typing')).toThrow(guidance);
      expect(() => server.to('general')).toThrow(guidance);
      expect(() => server.in('general')).toThrow(guidance);
      expect(() => server.except('general')).toThrow(guidance);

      // A gateway without a binding keeps its sockets in this process.
      const member = await joined(app, 'a1', '/admin/:id/ws', 'ops');
      await app.get(Gateways).of<ChatEvents>(AdminGateway).to('ops').emit('typing');
      await app.get(AdminGateway).server.to('ops').emit('audit', 1);
      expect(member.frames).toEqual([{ event: 'typing' }, { event: 'audit', data: 1 }]);
    } finally {
      await app.close();
    }
  });

  it("carries a forwarded gateway's pushes through a cross-instance sync driver", async () => {
    const commands: BroadcastCommand[] = [];
    const transport: WebSocketTransport = {
      forwardUpgrade: async () => new Response('forwarded'),
    };
    const app = await makeApp([transportAdapter(transport)], { sync: recordingBus(commands) });
    try {
      // The bus may reach the isolate the upgrade was forwarded to: both push
      // paths hand it the command instead of refusing.
      await app.get(Gateways).of<ChatEvents>(ChatGateway).to('general').emit('typing');
      await app.get(ChatGateway).server.to('general').emit('typing');
      const typing = { rooms: ['general'], gatewayPath: CHAT, frame: '{"event":"typing"}' };
      expect(commands).toEqual([typing, typing]);
    } finally {
      await app.close();
    }
  });

  it('bounds the message of a multi-room push failure whatever the room ids', async () => {
    const transport: WebSocketTransport = {
      async deliver() {
        throw new Error('the platform is unavailable');
      },
    };
    const app = await makeApp([transportAdapter(transport)]);
    try {
      // Room ids reach 512 bytes; the message shortens each one it names.
      const rooms = Array.from({ length: 12 }, (_, index) => `${'r'.repeat(508)}${index}`);
      let push = app
        .get(Gateways)
        .of<ChatEvents>(ChatGateway)
        .to(rooms[0] ?? '');
      for (const room of rooms.slice(1)) push = push.to(room);
      const failure: unknown = await push.emit('typing').then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) return;
      const shortened = `"${'r'.repeat(32)}…"`;
      expect(failure.message).toBe(
        `12 of 12 ChatGateway room pushes failed: ${Array(10).fill(shortened).join(', ')} and 2 more`,
      );
      expect(failure.message.length).toBeLessThan(512);
      // Each failed room's own error names it in full.
      expect(failure.errors.map((error: Error) => error.message)).toEqual(
        rooms.map((room) => `ChatGateway push to room "${room}" failed`),
      );
    } finally {
      await app.close();
    }
  });

  it('names at most ten failed rooms in the message of a multi-room push', async () => {
    const outage = new Error('the platform is unavailable');
    const transport: WebSocketTransport = {
      async deliver() {
        throw outage;
      },
    };
    const app = await makeApp([transportAdapter(transport)]);
    try {
      const rooms = Array.from({ length: 13 }, (_, index) => `r${index}`);
      let push = app.get(Gateways).of<ChatEvents>(ChatGateway).to('r0');
      for (const room of rooms) push = push.to(room);
      const failure: unknown = await push.emit('typing').then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) return;
      expect(failure.message).toBe(
        '13 of 13 ChatGateway room pushes failed: ' +
          '"r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9" and 3 more',
      );
      // Every failed room keeps its own error.
      expect(failure.errors.map((error: Error) => error.message)).toEqual(
        rooms.map((room) => `ChatGateway push to room "${room}" failed`),
      );
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
