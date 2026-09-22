import { VelaWebSocketDurableObject } from '../../durable-objects';
import { InjectionToken, Module, Injectable, Scope } from '@velajs/vela';
import {
  CloudflareWebSocketModule,
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  createCloudflareWorker,
  type OnGatewayConnection,
  type WsClient,
  type WsServer,
} from '../../index';

const allowedOrigin = 'https://app.test';

@WebSocketGateway({
  path: '/rooms/:room/ws',
  roomParam: 'room',
  binding: 'TEST_ROOM',
  allowedOrigins: [allowedOrigin],
  authorizeUpgrade: (request) => request.headers.get('x-test-auth') === 'allowed',
  authenticateUpgrade: (request) => {
    const match = /(?:^|;\s*)session=([^;]+)/.exec(request.headers.get('cookie') ?? '');
    if (!match) return false;
    const ttlMs = Number(match[1]);
    if (!Number.isSafeInteger(ttlMs)) return false;
    return {
      principal: { issuer: 'workerd-test', subject: 'user-1', principalType: 'user' },
      tenantId: 'tenant-1',
      expiresAtMs: Date.now() + ttlMs,
    };
  },
})
@Injectable({ scope: Scope.REQUEST })
class TestGateway implements OnGatewayConnection {
  #messageCount = 0;
  constructor(@WebSocketServer() private readonly server: WsServer) {}

  async handleConnection(client: WsClient): Promise<void> {
    // Make the connection hook asynchronous so an immediate client frame also
    // exercises the pending -> active race in the real runtime.
    await Promise.resolve();
    if (client.rooms.has('reject')) throw new Error('connection rejected');
    client.data.connected = true;
    client.commit();
    client.send('ready', { rooms: [...client.rooms] });
  }

  @SubscribeMessage('echo')
  echo(@MessageBody() body: unknown, @ConnectedSocket() client: WsClient) {
    return { event: 'echo', data: { body, tenantId: client.data.tenantId } };
  }

  @SubscribeMessage('scope')
  scope(@ConnectedSocket() client: WsClient) {
    client.data.messages = Number(client.data.messages ?? 0) + 1;
    client.commit();
    return {
      invocationCalls: ++this.#messageCount,
      connectionCalls: client.data.messages,
      connected: client.data.connected,
    };
  }

  @SubscribeMessage('attachment-limit')
  attachmentLimit(@ConnectedSocket() client: WsClient) {
    // Bypass the library precheck to exercise workerd's structured-clone ceiling.
    if (!(client.raw instanceof WebSocket)) throw new Error('Expected native WebSocket');
    try {
      client.raw.serializeAttachment({ oversized: 'x'.repeat(32 * 1024) });
    } catch {
      return { rejected: true };
    }
    return { rejected: false };
  }

  @SubscribeMessage('room')
  async room(@MessageBody() body: unknown): Promise<void> {
    await this.server.emit('room', body);
  }
}

@Module({ imports: [CloudflareWebSocketModule.forRoot()], providers: [TestGateway] })
class TestModule {}

export interface TestEnv {
  TEST_ROOM: DurableObjectNamespace<TestRoom>;
  COUNTING_ROOM: DurableObjectNamespace<CountingRoom>;
  CACHE: KVNamespace;
  DB: D1Database;
  FILES: R2Bucket;
}
export const TEST_ENV = new InjectionToken<TestEnv>('Worker bindings');
export class TestRoom extends VelaWebSocketDurableObject(TestModule, { envToken: TEST_ENV }) {}

// Every Durable Object instance in this isolate constructs from the same root.
let rootResolutions = 0;
const countingRoot = {
  create: () => {
    rootResolutions++;
    return { module: TestModule };
  },
};
export class CountingRoom extends VelaWebSocketDurableObject(countingRoot, {
  envToken: TEST_ENV,
}) {
  /** Test-only RPC: how many times this isolate ran the root factory. */
  async rootResolutions(): Promise<number> {
    return rootResolutions;
  }
}

export default createCloudflareWorker(TestModule, { envToken: TEST_ENV });
