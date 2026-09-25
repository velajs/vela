import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import {
  DO_ID,
  DO_STATE,
  DO_STORAGE,
  VelaDurableObject,
  VelaWebSocketDurableObject,
} from '../../durable-objects';
import { ENTRYPOINT_PROPS, VelaEntrypoint } from '../../entrypoints';
import { VelaWorkflow, type WorkflowParams } from '../../workflows';
import {
  APP_EXCEPTION_HANDLER,
  Controller,
  Get,
  Inject,
  InjectEnv,
  InjectionToken,
  Injectable,
  Module,
  Param,
  Post,
  Scope,
  UseGuards,
  defineProvider,
  type CanActivate,
  type VelaEnv,
} from '@velajs/vela';
import type { RuntimeAdapter } from '@velajs/vela/module-kit';
import { Cron } from '@velajs/vela/schedule';
import { LiveModule } from '@velajs/vela/live';
import { countRegisteredClasses } from '@velajs/vela/internal';
import {
  ConnectedSocket,
  Gateways,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketModule,
  WebSocketServer,
  type OnGatewayConnection,
  type UpgradeAuthenticator,
  type WebSocketUpgradeIdentity,
  type WsClient,
  type WsServer,
} from '@velajs/vela/websocket';
import {
  defineCloudflareApp,
  workflow,
  CLOUDFLARE_SCHEDULED_EVENT,
  type CloudflareScheduledEvent,
} from '../../index';

/** A string variable wrangler.test.toml seeds into ENV. */
function readVariable(env: VelaEnv, name: string): string {
  const value: unknown = Reflect.get(env, name);
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string variable`);
  return value;
}

/**
 * Resolved through DI from the gateway's module: the tenant comes from ENV, so
 * the authenticator exercises the Worker's per-environment container.
 */
@Injectable()
class CookieSessionAuthenticator implements UpgradeAuthenticator {
  readonly #tenantId: string;

  constructor(@InjectEnv() env: VelaEnv) {
    this.#tenantId = readVariable(env, 'WS_TENANT');
  }

  authenticate(request: Request): WebSocketUpgradeIdentity | false {
    const match = /(?:^|;\s*)session=([^;]+)/.exec(request.headers.get('cookie') ?? '');
    if (!match) return false;
    const ttlMs = Number(match[1]);
    if (!Number.isSafeInteger(ttlMs)) return false;
    return {
      principal: { issuer: 'workerd-test', subject: 'user-1', principalType: 'user' },
      tenantId: this.#tenantId,
      expiresAtMs: Date.now() + ttlMs,
    };
  }
}

@WebSocketGateway({
  path: '/rooms/:room/ws',
  roomParam: 'room',
  binding: 'TEST_ROOM',
  allowedOrigins: (env) => [readVariable(env, 'WS_ALLOWED_ORIGIN')],
  authorizeUpgrade: (request) => request.headers.get('x-test-auth') === 'allowed',
  authenticator: CookieSessionAuthenticator,
})
@Injectable({ scope: Scope.REQUEST })
class TestGateway implements OnGatewayConnection {
  #messageCount = 0;
  constructor(
    @WebSocketServer() private readonly server: WsServer,
    @InjectEnv() private readonly env: VelaEnv,
    @Inject(Gateways) private readonly gateways: Gateways,
  ) {}

  /** Pushes through Gateways from inside this room's Durable Object. */
  @SubscribeMessage('relay')
  async relay(@MessageBody() body: unknown): Promise<void> {
    const room = typeof body === 'object' && body !== null ? Reflect.get(body, 'room') : undefined;
    if (typeof room !== 'string') throw new Error('relay needs a room');
    await this.gateways.of<GatewayEvents>(TestGateway).to(room).emit('relayed', { room });
  }

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

/** The events TestGateway's rooms receive from server pushes. */
interface GatewayEvents {
  pushed: { room: string };
  relayed: { room: string };
}

/** Pushes to a gateway room from the Worker isolate. */
@Controller('/push')
class PushController {
  constructor(@Inject(Gateways) private readonly gateways: Gateways) {}

  @Post('/:room')
  async push(@Param('room') room: string): Promise<{ pushed: string }> {
    await this.gateways.of<GatewayEvents>(TestGateway).to(room).emit('pushed', { room });
    return { pushed: room };
  }
}

/** What each application (the Worker's, every Durable Object's) reported, by message. */
export const REPORTS = new InjectionToken<string[]>('workerd reports');

/**
 * A runtime adapter of the app definition: it configures the Worker's
 * application and every Durable Object context defined from the app.
 */
const reportingAdapter: RuntimeAdapter = {
  name: 'reports',
  configureContainer(container) {
    const reports: string[] = [];
    container.register(defineProvider(REPORTS, { useValue: reports }));
    container.markGlobalToken(REPORTS);
    container.register(
      defineProvider(APP_EXCEPTION_HANDLER, {
        useValue: {
          report: (error: unknown) =>
            void reports.push(error instanceof Error ? error.message : String(error)),
        },
      }),
    );
  },
};

/** One per Durable Object instance: its application context's singleton. */
@Injectable()
class CounterStore {
  readonly instanceId = crypto.randomUUID();
}

/** Request-scoped: built for each RPC call and event, disposed when it ends. */
@Injectable({ scope: Scope.REQUEST })
class CallTrace {
  readonly callId = crypto.randomUUID();
  closed = false;
  dispose(): void {
    this.closed = true;
  }
}

@Injectable()
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

/** The Counter Durable Object's host: the methods its rpc list names are the object's RPC methods. */
@Injectable()
export class CounterHost {
  constructor(
    @Inject(DO_STORAGE) private readonly storage: DurableObjectStorage,
    @Inject(DO_ID) private readonly id: DurableObjectId,
    @Inject(DO_STATE) private readonly state: DurableObjectState,
    @InjectEnv() private readonly env: VelaEnv,
    @Inject(CounterStore) private readonly store: CounterStore,
    @Inject(CallTrace) private readonly trace: CallTrace,
    @Inject(REPORTS) private readonly reports: string[],
  ) {}

  async increment(by: number): Promise<number> {
    const value = ((await this.storage.get<number>('value')) ?? 0) + by;
    await this.storage.put('value', value);
    return value;
  }

  snapshot(): {
    name: string | null;
    instanceId: string;
    callId: string;
    probe: string;
    storage: boolean;
  } {
    return {
      name: this.id.name ?? null,
      instanceId: this.store.instanceId,
      callId: this.trace.callId,
      probe: this.env.ENV_PROBE,
      storage: this.state.storage === this.storage,
    };
  }

  async scheduleAlarm(): Promise<void> {
    await this.storage.setAlarm(Date.now() + 60_000);
  }

  async alarms(): Promise<number> {
    return (await this.storage.get<number>('alarms')) ?? 0;
  }

  async alarm(): Promise<void> {
    await this.storage.put('alarms', (await this.alarms()) + 1);
  }

  leak(): never {
    throw new Error('secret database detail');
  }

  @UseGuards(DenyGuard)
  denied(): string {
    return 'never';
  }

  reported(): string[] {
    return [...this.reports];
  }

  /** Public, but left out of the rpc list. */
  audit(): string {
    return 'audit';
  }

  /** A TypeScript-private helper: never on the RPC surface. */
  private async wipe(): Promise<void> {
    await this.storage.deleteAll();
  }

  /** The container's disposal hook; the scope calls it, callers never can. */
  dispose(): void {}

  fetch(request: Request): Response {
    const path = new URL(request.url).pathname;
    if (path === '/stream') {
      // Request-scoped providers stay open until the streamed body finishes.
      const trace = this.trace;
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode(`first closed=${trace.closed}\n`));
            await new Promise((resolve) => setTimeout(resolve, 20));
            controller.enqueue(encoder.encode(`later closed=${trace.closed}\n`));
            controller.close();
          },
        }),
      );
    }
    return Response.json({ path, name: this.id.name ?? null });
  }
}

/** Calls the Counter Durable Object over RPC from the Worker. */
@Controller('/counters')
class CounterController {
  constructor(@InjectEnv() private readonly env: VelaEnv) {}

  @Post('/:name')
  async increment(@Param('name') name: string): Promise<{ count: number }> {
    return { count: await this.env.COUNTER.getByName(name).increment(1) };
  }
}

/** The params of a SignupWorkflow instance. */
export interface SignupParams {
  email: string;
  /** Fail the first attempt of the `create user` step, which then retries. */
  failFirstAttempt?: boolean;
  /** Fail the run with a NonRetryableError. */
  fatal?: boolean;
}

/**
 * The Worker application's singleton: Workflow runs, service entrypoint calls
 * and HTTP requests of one environment share it.
 */
@Injectable()
class Ledger {
  readonly users: string[] = [];
  readonly charges: string[] = [];
  readonly attempts = new Map<string, number>();
}

/** The SignupWorkflow body: a Workflow host resolved in the Worker application. */
@Injectable()
export class SignupHost {
  constructor(
    private readonly ledger: Ledger,
    @Inject(CallTrace) private readonly trace: CallTrace,
    @InjectEnv() private readonly env: VelaEnv,
  ) {}

  async run(
    event: WorkflowEvent<SignupParams>,
    step: WorkflowStep,
  ): Promise<{ email: string; attempt: number; probe: string; run: string }> {
    if (event.payload.fatal) throw new NonRetryableError('signup refused: secret policy detail');
    const user = await step.do(
      'create user',
      { retries: { limit: 2, delay: '10 seconds', backoff: 'constant' } },
      async () => {
        const attempt = (this.ledger.attempts.get(event.instanceId) ?? 0) + 1;
        this.ledger.attempts.set(event.instanceId, attempt);
        if (event.payload.failFirstAttempt && attempt === 1) throw new Error('transient failure');
        this.ledger.users.push(event.payload.email);
        return { email: event.payload.email, attempt };
      },
    );
    await step.sleep('grace period', '1 hour');
    return { ...user, probe: this.env.ENV_PROBE, run: this.trace.callId };
  }
}

/** Creates SignupWorkflow instances through a typed Workflow binding reference. */
const signups = workflow<WorkflowParams<SignupHost>>({ binding: 'SIGNUP_WORKFLOW' });

/** The Worker side of the Workflow and service entrypoint: same application. */
@Controller('/ledger')
class LedgerController {
  constructor(
    private readonly ledger: Ledger,
    @InjectEnv() private readonly env: VelaEnv,
  ) {}

  @Get()
  read(): { users: string[]; charges: string[] } {
    return { users: this.ledger.users, charges: this.ledger.charges };
  }

  @Post('/signups/:id')
  async signup(@Param('id') id: string): Promise<{ id: string }> {
    const instance = await signups(this.env).create({
      id,
      params: { email: `${id}@example.com` },
    });
    return { id: instance.id };
  }
}

@Injectable()
class TenantGuard implements CanActivate {
  constructor(@Inject(ENTRYPOINT_PROPS) private readonly props: unknown) {}

  canActivate(): boolean {
    return (
      typeof this.props === 'object' &&
      this.props !== null &&
      Reflect.get(this.props, 'tenant') === 'acme'
    );
  }
}

/** The Billing service entrypoint's host: the methods its rpc list names are RPC methods. */
@UseGuards(TenantGuard)
@Injectable()
export class BillingHost {
  constructor(
    private readonly ledger: Ledger,
    @Inject(CallTrace) private readonly trace: CallTrace,
    @Inject(ENTRYPOINT_PROPS) private readonly props: unknown,
    @Inject(REPORTS) private readonly reports: string[],
  ) {}

  charge(
    customer: string,
    cents: number,
  ): { invoice: string; tenant: string | null; call: string } {
    this.ledger.charges.push(`${customer}:${cents}`);
    const tenant: unknown =
      typeof this.props === 'object' && this.props !== null
        ? Reflect.get(this.props, 'tenant')
        : undefined;
    return {
      invoice: `inv-${this.ledger.charges.length}`,
      tenant: typeof tenant === 'string' ? tenant : null,
      call: this.trace.callId,
    };
  }

  leak(): never {
    throw new Error('secret billing detail');
  }

  @UseGuards(DenyGuard)
  denied(): string {
    return 'never';
  }

  reported(): string[] {
    return [...this.reports];
  }

  /** Public, but left out of the rpc list. */
  audit(): string[] {
    return this.ledger.charges;
  }
}

@Module({
  imports: [WebSocketModule.forRoot()],
  controllers: [PushController, CounterController, LedgerController],
  providers: [TestGateway, CounterStore, CallTrace, DenyGuard, Ledger, TenantGuard],
})
class TestModule {}

// One app definition: the Worker's default export and the Durable Object,
// Workflow and service entrypoint classes defined from it share its root
// module and runtime adapters.
const app = defineCloudflareApp(TestModule, { adapters: [reportingAdapter] });

export class SignupWorkflow extends VelaWorkflow(app, SignupHost) {}

export class Billing extends VelaEntrypoint(app, BillingHost, {
  rpc: ['charge', 'leak', 'denied', 'reported'],
}) {}

export class TestRoom extends VelaWebSocketDurableObject(app) {}

export class Counter extends VelaDurableObject(app, CounterHost, {
  rpc: ['increment', 'snapshot', 'scheduleAlarm', 'alarms', 'leak', 'denied', 'reported'],
}) {}

/** Its context fails to start: callers learn nothing about why. */
@Injectable()
class BrokenStart {
  onModuleInit(): void {
    throw new Error('secret startup detail');
  }
}

@Injectable()
class BrokenHost {
  ping(): string {
    return 'pong';
  }
}

@Module({ providers: [BrokenStart] })
class BrokenModule {}

export class BrokenCounter extends VelaDurableObject(BrokenModule, BrokenHost, { rpc: ['ping'] }) {}

// Every Durable Object instance in this isolate constructs from one static
// DynamicModule root declared at module scope.
const countingRoot = { module: TestModule, key: 'counting-room' };
export class CountingRoom extends VelaWebSocketDurableObject(countingRoot) {
  /** Test-only RPC: classes the isolate-global metadata registry holds once this instance is built. */
  async registeredClasses(): Promise<number> {
    return countRegisteredClasses();
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

@Module({ imports: [WebSocketModule.forRoot()], providers: [NightlyReports] })
class CronRoomModule {}

export class CronRoom extends VelaWebSocketDurableObject(CronRoomModule) {}

// Live queries in a Durable Object: one class declared with SQLite storage
// (new_sqlite_classes) and one without (new_classes), from the same module.
@Module({ imports: [WebSocketModule.forRoot(), LiveModule.forRoot()] })
class LiveRoomModule {}

export class SqliteLiveRoom extends VelaWebSocketDurableObject(LiveRoomModule) {}
export class KvLiveRoom extends VelaWebSocketDurableObject(LiveRoomModule) {}

export default app.worker;
