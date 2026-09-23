import { VelaWebSocketDurableObject } from '../../durable-objects';
import { Cron, Inject, InjectEnv, Module, Injectable, Scope, type VelaEnv } from '@velajs/vela';
import {
  CloudflareWebSocketModule,
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  createCloudflareWorker,
  CLOUDFLARE_SCHEDULED_EVENT,
  type CloudflareScheduledEvent,
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
  constructor(
    @WebSocketServer() private readonly server: WsServer,
    @InjectEnv() private readonly env: VelaEnv,
  ) {}

  /** Reports what the Durable Object's ENV carries (see env-runtime.test.ts). */
  @SubscribeMessage('env')
  probeEnv() {
    const probe: unknown = Reflect.get(this.env, 'ENV_PROBE');
    return { event: 'env', data: { probe: typeof probe === 'string' ? probe : null } };
  }

  async handleConnection(client: WsClient): Promise<void> {
    // Make the connection hook asynchronous so an immediate client frame also
    // exercises the pending -> active race in the real runtime.
    await Promise.resolve();
    if (client.rooms.has('reject')) throw new Error('connection rejected');
    client.data.connected = true;
    client.commit();
    // Announce the connection to its room while this socket is still admitted.
    if (client.rooms.has('announce')) await this.server.emit('joined', { id: client.id });
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

export class TestRoom extends VelaWebSocketDurableObject(TestModule) {}

// Every Durable Object instance in this isolate constructs from the same root.
let rootResolutions = 0;
const countingRoot = {
  create: () => {
    rootResolutions++;
    return { module: TestModule };
  },
};
export class CountingRoom extends VelaWebSocketDurableObject(countingRoot) {
  /** Test-only RPC: how many times this isolate ran the root factory. */
  async rootResolutions(): Promise<number> {
    return rootResolutions;
  }
}

// A cron job beside the gateway: the Durable Object builds the same graph
// without the Worker adapter, so the job must stay out of its bootstrap.
@Injectable()
class NightlyReports {
  constructor(
    @Inject(CLOUDFLARE_SCHEDULED_EVENT) private readonly trigger: CloudflareScheduledEvent,
  ) {}

  @Cron('30 2 * * *', { dialect: 'cloudflare' })
  nightly(): void {
    this.trigger.noRetry();
  }
}

@Module({ imports: [CloudflareWebSocketModule.forRoot()], providers: [NightlyReports] })
class CronRoomModule {}

export class CronRoom extends VelaWebSocketDurableObject(CronRoomModule) {}

export default createCloudflareWorker(TestModule);
