import { describe, it, expect } from 'vitest';
import { Module } from '@velajs/vela';
import {
  WS_SERVER,
  WebSocketGateway,
  WebSocketModule,
  WebSocketServer,
  type BroadcastOperator,
  type WsServer,
} from '@velajs/vela/websocket';
import { Test } from '../test.js';
import { TestWsConnection } from '../ws/test-ws-connection.js';

/** Minimal EventTarget-backed stand-in for a WebSocket. */
class MockSocket extends EventTarget {
  readonly sent: (string | ArrayBufferLike | ArrayBufferView)[] = [];
  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(data);
  }
  close(code = 1000, reason = ''): void {
    const evt = new Event('close') as Event & { code: number; reason: string };
    evt.code = code;
    evt.reason = reason;
    this.dispatchEvent(evt);
  }
  emit(data: string | ArrayBuffer): void {
    const evt = new Event('message') as Event & { data: unknown };
    evt.data = data;
    this.dispatchEvent(evt);
  }
}

describe('TestWsConnection', () => {
  it('queues messages and assertMessage reads them in order', async () => {
    const socket = new MockSocket();
    const conn = new TestWsConnection(socket as unknown as WebSocket);
    socket.emit('echo:hi');
    socket.emit('echo:bye');
    await conn.assertMessage('echo:hi');
    await conn.assertMessage('echo:bye');
  });

  it('waitForMessage resolves on a later message', async () => {
    const socket = new MockSocket();
    const conn = new TestWsConnection(socket as unknown as WebSocket);
    const pending = conn.waitForMessage();
    socket.emit('later');
    expect(await pending).toBe('later');
  });

  it('send delegates to the underlying socket', () => {
    const socket = new MockSocket();
    const conn = new TestWsConnection(socket as unknown as WebSocket);
    conn.send('ping');
    expect(socket.sent).toEqual(['ping']);
  });

  it('assertClosed matches the close code and runs cleanup', async () => {
    const socket = new MockSocket();
    let cleaned = false;
    const conn = new TestWsConnection(socket as unknown as WebSocket, () => {
      cleaned = true;
    });
    setTimeout(() => socket.close(4000, 'bye'), 0);
    await conn.assertClosed(4000);
    expect(cleaned).toBe(true);
  });
});

describe('module.ws without a transport adapter', () => {
  it('connect() throws an actionable error', async () => {
    @Module({})
    class EmptyModule {}
    const module = await Test.createTestingModule({ imports: [EmptyModule] }).compile();
    await expect(module.ws('/ws/chat').connect()).rejects.toThrow(
      /transport adapter|websocket-node/i,
    );
  });
});

describe("a gateway's @WebSocketServer() in a testing module", () => {
  interface Push {
    rooms: string[];
    event: string;
    data: unknown;
  }

  function recordingServer(pushes: Push[]): WsServer {
    const operator = (rooms: string[]): BroadcastOperator => ({
      to: (room) => operator([...rooms, room]),
      in: (room) => operator([...rooms, room]),
      except: () => operator(rooms),
      emit(event, data) {
        pushes.push({ rooms, event, data });
      },
    });
    return {
      emit(event, data) {
        pushes.push({ rooms: [], event, data });
      },
      to: (room) => operator([room]),
      in: (room) => operator([room]),
      except: () => operator([]),
    };
  }

  @WebSocketGateway({ path: '/rooms' })
  class RoomGateway {
    constructor(@WebSocketServer() readonly server: WsServer) {}
  }

  it('pushes to a WS_SERVER overridden next to WebSocketModule.forRoot()', async () => {
    const pushes: Push[] = [];
    const module = await Test.createTestingModule({
      imports: [WebSocketModule.forRoot()],
      providers: [RoomGateway],
    })
      .overrideProvider(WS_SERVER)
      .useValue(recordingServer(pushes))
      .compile();
    try {
      const { server } = module.get(RoomGateway);
      server.emit('everyone', 1);
      server.to('r1').emit('room', 2);
      expect(pushes).toEqual([
        { rooms: [], event: 'everyone', data: 1 },
        { rooms: ['r1'], event: 'room', data: 2 },
      ]);
    } finally {
      await module.close();
    }
  });

  it('pushes to a WS_SERVER overridden with an async factory', async () => {
    const pushes: Push[] = [];
    const module = await Test.createTestingModule({
      imports: [WebSocketModule.forRoot()],
      providers: [RoomGateway],
    })
      .overrideProvider(WS_SERVER)
      .useFactory({
        factory: async () => {
          await Promise.resolve();
          return recordingServer(pushes);
        },
      })
      .compile();
    try {
      module.get(RoomGateway).server.to('r1').emit('room', 2);
      expect(pushes).toEqual([{ rooms: ['r1'], event: 'room', data: 2 }]);
    } finally {
      await module.close();
    }
  });

  it('connects nothing when the override stands in for WebSocketModule, and says what to do', async () => {
    const pushes: Push[] = [];
    const module = await Test.createTestingModule({ providers: [RoomGateway] })
      .overrideProvider(WS_SERVER)
      .useValue(recordingServer(pushes))
      .compile();
    try {
      expect(() => module.get(RoomGateway).server.emit('everyone', 1)).toThrow(
        /is not connected[\s\S]*keep that import[\s\S]*override WS_SERVER in the testing module/,
      );
      expect(pushes).toEqual([]);
    } finally {
      await module.close();
    }
  });
});
