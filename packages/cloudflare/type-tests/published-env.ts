import { ENV, Inject, InjectEnv, Injectable, registerAs, type VelaEnv } from '@velajs/vela';
import {
  createCloudflareApp,
  createCloudflareWorker,
  defineCloudflareApp,
  isEntrypointError,
  workflow,
  type CloudflareApp,
  type CloudflareRoot,
  type CloudflareWorker,
  type CloudflareWorkerOptions,
} from '@velajs/cloudflare';
import {
  DO_STORAGE,
  VelaDurableObject,
  VelaWebSocketDurableObject,
} from '@velajs/cloudflare/durable-objects';
import { OnEmail } from '@velajs/cloudflare/email';
import { ENTRYPOINT_PROPS, VelaEntrypoint } from '@velajs/cloudflare/entrypoints';
import { OnTail } from '@velajs/cloudflare/tail';
import { VelaWorkflow, type WorkflowParams } from '@velajs/cloudflare/workflows';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

// These import only the emitted packages: the published @velajs/cloudflare
// declarations must extend VelaEnv with Cloudflare.Env, so ENV carries the
// bindings `wrangler types` generated (worker-configuration.d.ts) through DI.
export async function verifyPublishedEnvironment(
  env: Cloudflare.Env,
  root: CloudflareRoot,
): Promise<void> {
  const bindings: VelaEnv = env;
  const cache: KVNamespace = bindings.CACHE;
  const db: D1Database = bindings.DB;
  const files: R2Bucket = bindings.FILES;
  const secret: string = bindings.SECRET;
  void [cache, db, files, secret];
  // @ts-expect-error binding names come from the generated environment
  void bindings.MISSING;
  // @ts-expect-error a queue binding keeps its message body type
  void bindings.JOBS.send({ taskId: 123 });
  // @ts-expect-error a variable keeps its declared literal union
  const production: 'production' = bindings.MODE;
  void production;

  const appConfig = registerAs('app', (environment) => ({ mode: environment.MODE }));
  const mode: 'production' | 'staging' = appConfig.factory(env).mode;
  void mode;

  @Injectable()
  class Reader {
    constructor(@InjectEnv() readonly bindings: VelaEnv) {}
    database(): D1Database {
      return this.bindings.DB;
    }
  }
  void Reader;

  const worker: ExportedHandler<Cloudflare.Env> = createCloudflareWorker(root, {
    configure(configured, native) {
      const database: D1Database = native.DB;
      void database;
      configured.getHonoApp().get('/health', (context) => context.text('ok'));
    },
  });
  void worker;
  const app = await createCloudflareApp(root, { env });
  const fromDi = app.get(ENV);
  const kv: KVNamespace = fromDi.CACHE;
  void kv;
  // @ts-expect-error get infers the value from the token; callers cannot select a result type
  app.get<Cloudflare.Env>(ENV);
  const runtimeOnly: unknown = app.get('runtime-only-token');
  void runtimeOnly;
  // @ts-expect-error the supplied environment must satisfy the generated contract
  void createCloudflareApp(root, { env: { SECRET: 'incomplete' } });
  // ENV is framework-owned: the published Worker options carry no environment token.
  const workerOptions: Record<keyof CloudflareWorkerOptions, true> = {
    globalPrefix: true,
    globalPrefixOptions: true,
    versioning: true,
    security: true,
    cors: true,
    adapters: true,
    configure: true,
  };
  void workerOptions;

  class Room extends VelaWebSocketDurableObject(root) {
    database(): D1Database {
      return this.env.DB;
    }
  }
  void Room;
}

// The published Durable Object host: its RPC methods reach the stub types.
@Injectable()
class CounterHost {
  constructor(@Inject(DO_STORAGE) private readonly storage: DurableObjectStorage) {}
  async increment(by: number): Promise<number> {
    const value = ((await this.storage.get<number>('value')) ?? 0) + by;
    await this.storage.put('value', value);
    return value;
  }
  label(): string {
    return 'counter';
  }
  // Public, but left out of the rpc list: not on the stub.
  audit(): string {
    return 'audit';
  }
  private wipe(): Promise<void> {
    return this.storage.deleteAll();
  }
  name(): string {
    return 'counter';
  }
  dispose(): void {}
  onModuleInit(): void {}
}

export async function verifyPublishedDurableObjects(
  root: CloudflareRoot,
  namespace: DurableObjectNamespace<Counter>,
): Promise<void> {
  const app: CloudflareApp = defineCloudflareApp(root);
  const worker: CloudflareWorker = app.worker;
  void worker;
  const stub = namespace.getByName('orders');
  const count: number = await stub.increment(1);
  const label: string = await stub.label();
  void [count, label];
  // @ts-expect-error RPC arguments keep the host's parameter types
  void stub.increment('one');
  // @ts-expect-error lifecycle hooks are not RPC methods
  void stub.onModuleInit;
  // @ts-expect-error a public method the rpc list leaves out is not an RPC method
  void stub.audit;
  // @ts-expect-error neither is a TypeScript-private helper
  void stub.wipe;
  try {
    await stub.increment(1);
  } catch (error) {
    if (isEntrypointError(error)) {
      const failure: { status: number; code: string; message: string } = error;
      void failure;
    }
  }
}

declare const counterApp: CloudflareApp;
class Counter extends VelaDurableObject(counterApp, CounterHost, { rpc: ['increment', 'label'] }) {}

// The rpc list names public host methods only: never a private helper, a
// disposal or lifecycle hook, or a name the Durable Object stub owns.
// @ts-expect-error a TypeScript-private helper cannot be listed
void VelaDurableObject(counterApp, CounterHost, { rpc: ['wipe'] });
// @ts-expect-error dispose() is the container's disposal hook
void VelaDurableObject(counterApp, CounterHost, { rpc: ['dispose'] });
// @ts-expect-error a stub's name property shadows a method of that name
void VelaDurableObject(counterApp, CounterHost, { rpc: ['name'] });
// @ts-expect-error lifecycle hooks are not RPC methods
void VelaDurableObject(counterApp, CounterHost, { rpc: ['onModuleInit'] });

// A published Workflow host: run's event payload types the Workflow's params.
interface SignupParams {
  email: string;
}

@Injectable()
class SignupHost {
  async run(event: WorkflowEvent<SignupParams>, step: WorkflowStep): Promise<{ id: string }> {
    const id = await step.do('create user', async () => `user:${event.payload.email}`);
    await step.sleep('grace period', '1 day');
    return { id };
  }
}

class SignupWorkflow extends VelaWorkflow(counterApp, SignupHost) {}

export async function verifyPublishedWorkflows(
  env: VelaEnv,
  step: WorkflowStep,
  event: WorkflowEvent<SignupParams>,
  ctx: ExecutionContext,
): Promise<void> {
  const params: WorkflowParams<typeof SignupWorkflow> = { email: 'ada@example.com' };
  const fromHost: WorkflowParams<SignupHost> = params;
  void fromHost;
  // @ts-expect-error the params come from run's event payload
  const wrong: WorkflowParams<SignupHost> = { mail: 'ada@example.com' };
  void wrong;
  const signups = workflow<WorkflowParams<typeof SignupWorkflow>>({ binding: 'SIGNUPS' });
  const instance = await signups(env).create({ params });
  const status: InstanceStatus = await instance.status();
  void status;
  // @ts-expect-error the binding takes the Workflow's params
  void signups(env).create({ params: { email: 1 } });
  const output: { id: string } = await new SignupWorkflow(ctx, env).run(event, step);
  void output;
  // `wrangler types` types a Workflow binding by the exported class's run.
  const generated: Workflow<Parameters<SignupWorkflow['run']>[0]['payload']> = signups(env);
  await generated.create({ params: { email: 'grace@example.com' } });
  // @ts-expect-error a host without run(event, step) is no Workflow host
  void VelaWorkflow(counterApp, CounterHost);
}

// A published service entrypoint host: its RPC methods reach Service<typeof Billing>.
@Injectable()
class BillingHost {
  constructor(@Inject(ENTRYPOINT_PROPS) private readonly props: unknown) {}
  async charge(customerId: string, cents: number): Promise<{ invoice: string }> {
    return { invoice: `${customerId}:${cents}:${String(this.props)}` };
  }
  audit(): string {
    return 'audit';
  }
}

class Billing extends VelaEntrypoint(counterApp, BillingHost, { rpc: ['charge'] }) {}

export async function verifyPublishedEntrypoints(billing: Service<typeof Billing>): Promise<void> {
  const invoice: { invoice: string } = await billing.charge('customer-1', 500);
  void invoice;
  // @ts-expect-error RPC arguments keep the host's parameter types
  void billing.charge('customer-1', '500');
  // @ts-expect-error a public method the rpc list leaves out is not an RPC method
  void billing.audit;
  try {
    await billing.charge('customer-1', 500);
  } catch (error) {
    if (isEntrypointError(error)) {
      const failure: { status: number; code: string } = error;
      void failure;
    }
  }
}

// @ts-expect-error fetch is the entrypoint's own handler, never an RPC method
void VelaEntrypoint(counterApp, BillingHost, { rpc: ['fetch'] });
// @ts-expect-error then would make every stub a thenable
void VelaEntrypoint(counterApp, BillingHost, { rpc: ['then'] });

// Email and tail handlers: typed method decorators on providers.
@Injectable()
export class Inbox {
  @OnEmail({ to: 'support@example.com' })
  async receive(message: ForwardableEmailMessage): Promise<void> {
    await message.forward('team@example.com');
  }

  @OnTail()
  observe(events: TraceItem[]): number {
    return events.length;
  }
}

export class WrongInbox {
  // @ts-expect-error an @OnEmail() handler receives the email message
  @OnEmail()
  receive(message: number): number {
    return message;
  }
}
