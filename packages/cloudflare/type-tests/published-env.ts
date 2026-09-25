import { ENV, Inject, InjectEnv, Injectable, registerAs, type VelaEnv } from '@velajs/vela';
import {
  createCloudflareApp,
  createCloudflareWorker,
  defineCloudflareApp,
  type CloudflareApp,
  type CloudflareRoot,
  type CloudflareWorker,
  type CloudflareWorkerOptions,
} from '@velajs/cloudflare';
import {
  DO_STORAGE,
  VelaDurableObject,
  VelaWebSocketDurableObject,
  isDurableObjectError,
} from '@velajs/cloudflare/durable-objects';

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
    if (isDurableObjectError(error)) {
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
