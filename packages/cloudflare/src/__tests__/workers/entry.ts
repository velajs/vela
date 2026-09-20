import { VelaWebSocketDurableObject } from '../../durable-objects';
import { InjectionToken, Module } from '@velajs/vela';
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
class TestGateway implements OnGatewayConnection {
  constructor(@WebSocketServer() private readonly server: WsServer) {}

  async handleConnection(client: WsClient): Promise<void> {
    // Make the connection hook asynchronous so an immediate client frame also
    // exercises the pending -> active race in the real runtime.
    await Promise.resolve();
    if (client.rooms.has('reject')) throw new Error('connection rejected');
    client.send('ready', { rooms: [...client.rooms] });
  }

  @SubscribeMessage('echo')
  echo(@MessageBody() body: unknown, @ConnectedSocket() client: WsClient) {
    return { event: 'echo', data: { body, tenantId: client.data.tenantId } };
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
  CACHE: KVNamespace;
  DB: D1Database;
  FILES: R2Bucket;
}
export const TEST_ENV = new InjectionToken<TestEnv>('Worker bindings');
export class TestRoom extends VelaWebSocketDurableObject(TestModule, { envToken: TEST_ENV }) {}

export default createCloudflareWorker(TestModule, { envToken: TEST_ENV });
