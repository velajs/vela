import { ENV, InjectEnv, Injectable, registerAs, type VelaEnv } from '@velajs/vela';
import {
  createCloudflareApp,
  createCloudflareWorker,
  type CloudflareRoot,
  type CloudflareWorkerOptions,
} from '@velajs/cloudflare';
import { VelaWebSocketDurableObject } from '@velajs/cloudflare/durable-objects';

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
