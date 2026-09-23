import { LiveInvalidation, LiveModule, type InvalidationCommand } from '@velajs/vela/live';
import { CloudflareWebSocketModule } from '../websocket/cloudflare-websocket.module';
import { durableObjectLive, type LiveNamespace } from '../websocket/do-live';
import type { ExecutionContext } from 'hono';
import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import {
  defineProvider,
  Controller,
  Get,
  Inject,
  Injectable,
  InjectionToken,
  MetadataRegistry,
  Module,
  Scope,
} from '@velajs/vela';
import { createCloudflareApp, createCloudflareWorker } from '../cloudflare-factory';
import { QueueConsumer } from '../decorators/queue-consumer';
import { Scheduled } from '../decorators/scheduled';

beforeEach(() => MetadataRegistry.clear());
const context = { waitUntil: (_promise: Promise<unknown>): void => {} };
const httpContext: ExecutionContext = {
  ...context,
  passThroughOnException() {},
  props: {},
};

function fixture() {
  interface Bindings {
    NAME: string;
    CACHE: { get(key: string): Promise<string> };
    pause?: Promise<void>;
    fail?: boolean;
  }
  const ENV = new InjectionToken<Bindings>('native Worker environment');
  const CONFIG = new InjectionToken<string>('constructed from native env');
  const seen: Array<{ name: string; value: string; scope: string }> = [];
  const initialized: string[] = [];
  let constructions = 0;

  @Injectable({ scope: Scope.REQUEST })
  class EventScope {
    readonly id = crypto.randomUUID();
  }

  @Injectable()
  class Lifecycle {
    constructor(@Inject(ENV) private readonly env: Bindings) {
      constructions++;
    }
    onModuleInit() {
      initialized.push(this.env.NAME);
    }
  }

  @Injectable()
  class Jobs {
    constructor(
      @Inject(ENV) private readonly env: Bindings,
      @Inject(CONFIG) private readonly name: string,
      private readonly scope: EventScope,
    ) {}
    @QueueConsumer('jobs')
    @Scheduled('* * * * *')
    async run(): Promise<void> {
      await this.env.pause;
      seen.push({ name: this.name, value: await this.env.CACHE.get('key'), scope: this.scope.id });
    }
  }
  @Controller('/bindings')
  class BindingsController {
    constructor(private readonly jobs: Jobs) {}
    @Get()
    async read() {
      await this.jobs.run();
      return { ok: true };
    }
  }
  @Module({
    providers: [
      Lifecycle,
      Jobs,
      EventScope,
      defineProvider(CONFIG, {
        inject: [ENV],
        useFactory: (env: Bindings) => {
          if (env.fail) throw new Error('configuration unavailable');
          return env.NAME;
        },
      }),
    ],
    controllers: [BindingsController],
  })
  class AppModule {}
  const environment = (name: string): Bindings => ({
    NAME: name,
    CACHE: { get: async () => `cached:${name}` },
  });
  return {
    ENV,
    CONFIG,
    AppModule,
    seen,
    initialized,
    environment,
    constructions: () => constructions,
  };
}

describe('native application environments', () => {
  it('builds a root graph once per environment, sharing concurrent cold events', async () => {
    const f = fixture();
    const created: object[] = [];
    const worker = createCloudflareWorker(
      {
        create(env) {
          created.push(env);
          return f.AppModule;
        },
      },
      { envToken: f.ENV },
    );
    const a = f.environment('a');
    const b = f.environment('b');
    await Promise.all([
      worker.queue({ queue: 'jobs', messages: [] }, a, context),
      worker.scheduled({ cron: '* * * * *' }, a, context),
      worker.queue({ queue: 'jobs', messages: [] }, b, context),
    ]);
    await worker.queue({ queue: 'jobs', messages: [] }, a, context);
    expect(created).toEqual([a, b]);
    expect(f.constructions()).toBe(2);
    expect(f.seen.map((row) => row.name).sort()).toEqual(['a', 'a', 'a', 'b']);
  });

  it('makes bindings available to factories and lifecycle before the first handler', async () => {
    const f = fixture();
    const env = f.environment('eager');
    const app = await createCloudflareApp(f.AppModule, { env, envToken: f.ENV });
    expect(app.get(f.ENV)).toBe(env);
    expectTypeOf(app.get(f.ENV)).toEqualTypeOf(env);
    expectTypeOf(app.get(f.CONFIG)).toEqualTypeOf<string>();
    expect(f.initialized).toEqual(['eager']);
    expect(app.get(f.CONFIG)).toBe('eager');
    await app.close();
  });

  it.each(['queue', 'scheduled'] as const)(
    'boots on a cold %s event and reuses only that env application',
    async (kind) => {
      const f = fixture();
      const worker = createCloudflareWorker(f.AppModule, { envToken: f.ENV });
      const env = f.environment(kind);
      if (kind === 'queue') await worker.queue({ queue: 'jobs', messages: [] }, env, context);
      else await worker.scheduled({ cron: '* * * * *' }, env, context);
      expect(f.seen[0]).toMatchObject({ name: kind, value: `cached:${kind}` });
      expect(
        (await worker.fetch(new Request('https://worker/bindings'), env, httpContext)).status,
      ).toBe(200);
      expect(f.constructions()).toBe(1);
      expect(f.seen[0]?.scope).not.toBe(f.seen[1]?.scope);
    },
  );

  it('isolates concurrent events for different environments using the SAME root module', async () => {
    const f = fixture();
    const worker = createCloudflareWorker(f.AppModule, { envToken: f.ENV });
    const a = f.environment('a');
    const b = f.environment('b');
    let release = () => {};
    a.pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = worker.queue({ queue: 'jobs', messages: [] }, a, context);
    await worker.scheduled({ cron: '* * * * *' }, b, context);
    release();
    await first;
    await worker.queue({ queue: 'jobs', messages: [] }, a, context);
    expect(f.seen.map(({ name, value }) => ({ name, value }))).toEqual([
      { name: 'b', value: 'cached:b' },
      { name: 'a', value: 'cached:a' },
      { name: 'a', value: 'cached:a' },
    ]);
    expect(f.constructions()).toBe(2);
    expect(new Set(f.seen.map((entry) => entry.scope)).size).toBe(3);
  });

  it('shares concurrent bootstrap for the same environment and preserves fresh event scopes', async () => {
    const f = fixture();
    const worker = createCloudflareWorker(f.AppModule, { envToken: f.ENV });
    const env = f.environment('same');
    await Promise.all([
      worker.queue({ queue: 'jobs', messages: [] }, env, context),
      worker.scheduled({ cron: '* * * * *' }, env, context),
    ]);
    expect(f.constructions()).toBe(1);
    expect(f.seen).toHaveLength(2);
    expect(f.seen[0]?.scope).not.toBe(f.seen[1]?.scope);
  });

  it('evicts rejected bootstrap and retries the same environment identity', async () => {
    const f = fixture();
    const worker = createCloudflareWorker(f.AppModule, { envToken: f.ENV });
    const env = f.environment('retry');
    env.fail = true;
    await expect(worker.queue({ queue: 'jobs', messages: [] }, env, context)).rejects.toThrow(
      'configuration unavailable',
    );
    expect(f.seen).toEqual([]);
    env.fail = false;
    await worker.queue({ queue: 'jobs', messages: [] }, env, context);
    expect(f.seen[0]?.name).toBe('retry');
  });

  it('rejects accidentally reusing an explicitly built app with a different environment', async () => {
    const f = fixture();
    const app = await createCloudflareApp(f.AppModule, {
      env: f.environment('a'),
      envToken: f.ENV,
    });
    const b = f.environment('b');
    await expect(app.queue({ queue: 'jobs', messages: [] }, b, context)).rejects.toThrow(
      'different environment',
    );
    await expect(app.scheduled({ cron: '* * * * *' }, b, context)).rejects.toThrow(
      'different environment',
    );
    await expect(app.fetch(new Request('https://worker/bindings'), b, httpContext)).rejects.toThrow(
      'different environment',
    );
    expect((await app.getHonoApp().request('/bindings', undefined, b)).status).toBe(500);
    expect(f.seen).toEqual([]);
    await app.close();
  });

  it('answers unmatched routes with the framework JSON 404', async () => {
    const f = fixture();
    const worker = createCloudflareWorker(f.AppModule, { envToken: f.ENV });
    const env = f.environment('unmatched');
    const response = await worker.fetch(new Request('https://worker/unknown'), env, httpContext);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({
      error: { code: 'not_found', message: 'Route not found' },
    });
    const matched = await worker.fetch(new Request('https://worker/bindings'), env, httpContext);
    expect(matched.status).toBe(200);
  });
});

describe('per-application native live namespaces', () => {
  it('keeps a shared module definition isolated across two environments', async () => {
    const LIVE_ENV = new InjectionToken<{ ROOMS: LiveNamespace }>('live native env');
    const dispatched: string[] = [];
    const namespace = (name: string): LiveNamespace => ({
      idFromName(room): DurableObjectId {
        return { name: room, toString: () => room, equals: (other) => other.toString() === room };
      },
      get() {
        return {
          invalidate: async (_command: InvalidationCommand) => {
            dispatched.push(name);
            return { cursor: 1, epoch: name };
          },
        };
      },
    });
    @Module({
      imports: [
        CloudflareWebSocketModule.forRoot(),
        LiveModule.forRootAsync({
          inject: [LIVE_ENV],
          useFactory: (env) => ({
            driver: () =>
              durableObjectLive({ namespace: env.ROOMS, gatewayPath: '/rooms/:room/ws' }),
          }),
        }),
      ],
    })
    class App {}
    const a = await createCloudflareApp(App, {
      env: { ROOMS: namespace('a') },
      envToken: LIVE_ENV,
    });
    const b = await createCloudflareApp(App, {
      env: { ROOMS: namespace('b') },
      envToken: LIVE_ENV,
    });
    await a.get(LiveInvalidation).invalidate({ tags: ['todos'] });
    await b.get(LiveInvalidation).invalidate({ tags: ['todos'] });
    await a.get(LiveInvalidation).invalidate({ tags: ['todos'] });
    expect(dispatched).toEqual(['a', 'b', 'a']);
    await Promise.all([a.close(), b.close()]);
  });
});

// Compile-time contract checks: generated Workers types stay intact through DI.
interface NativeBindings {
  CACHE: KVNamespace;
  DB: D1Database;
  FILES: R2Bucket;
  JOBS: Queue<{ taskId: string }>;
  SECRET: string;
}
const NATIVE_ENV = new InjectionToken<NativeBindings>('typed native contract');
function nativeTypeContract(env: NativeBindings, root: Parameters<typeof createCloudflareApp>[0]) {
  const worker: ExportedHandler<NativeBindings> = createCloudflareWorker(root, {
    envToken: NATIVE_ENV,
  });
  void worker;
  return createCloudflareApp(root, {
    env,
    envToken: NATIVE_ENV,
    middleware: (bindings) => [
      async (context, next) => {
        expectTypeOf(bindings).toEqualTypeOf<NativeBindings>();
        // @ts-expect-error Hono itself cannot infer native bindings from runtime registration.
        context.env.DB.prepare('select 1');
        await next();
      },
    ],
  }).then((app) => {
    const bindings = app.get(NATIVE_ENV);
    // @ts-expect-error get infers the value from the token; callers cannot select a result type
    app.get<NativeBindings>(NATIVE_ENV);
    expectTypeOf(app.get('runtime-only-token')).toEqualTypeOf<unknown>();
    expectTypeOf(bindings.CACHE).toEqualTypeOf<KVNamespace>();
    expectTypeOf(bindings.DB).toEqualTypeOf<D1Database>();
    expectTypeOf(bindings.FILES).toEqualTypeOf<R2Bucket>();
    expectTypeOf(bindings.JOBS).toEqualTypeOf<Queue<{ taskId: string }>>();
    expectTypeOf(bindings.SECRET).toEqualTypeOf<string>();
    // @ts-expect-error binding names come from the native environment type
    bindings.MISSING;
    // @ts-expect-error preserve the queue's body generic
    bindings.JOBS.send({ taskId: 123 });
    // @ts-expect-error supplied environment must satisfy the token's entire contract
    createCloudflareApp(root, { env: { SECRET: 'incomplete' }, envToken: NATIVE_ENV });
  });
}
void nativeTypeContract;
