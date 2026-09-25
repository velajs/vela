import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  Controller,
  ENV,
  Get,
  Injectable,
  InjectEnv,
  Module,
  VelaFactory,
  type VelaEnv,
} from '@velajs/vela';
import type { RuntimeAdapter } from '@velajs/vela/module-kit';
import {
  CLOUDFLARE_DURABLE_OBJECT,
  CLOUDFLARE_WORKER,
  createCloudflareWorker,
  defineCloudflareApp,
  isCloudflareApp,
  type CloudflareApp,
  type CloudflareDurableObjectDescriptor,
  type CloudflareWorkerDescriptor,
} from '../index';
import { VelaDurableObject, VelaWebSocketDurableObject } from '../durable-objects';

@Injectable()
class Greeting {
  constructor(@InjectEnv() private readonly env: VelaEnv) {}
  text(): string {
    const value: unknown = Reflect.get(this.env, 'GREETING');
    return typeof value === 'string' ? value : 'unset';
  }
}

@Controller('/hello')
class HelloController {
  constructor(private readonly greeting: Greeting) {}
  @Get()
  hello() {
    return { message: this.greeting.text() };
  }
}

@Module({ controllers: [HelloController], providers: [Greeting] })
class AppModule {}

// Tools (the CLI, test harnesses) read what a Worker entry was built from
// without running a platform event.
describe('Worker descriptor', () => {
  it('attaches the root module and options under a well-known symbol', () => {
    const adapter: RuntimeAdapter = { name: 'probe' };
    const options = { globalPrefix: '/api', adapters: [adapter] };
    const worker = createCloudflareWorker(AppModule, options);
    const descriptor = worker[CLOUDFLARE_WORKER];

    expect(CLOUDFLARE_WORKER).toBe(Symbol.for('vela.cloudflare.worker'));
    expectTypeOf(descriptor).toEqualTypeOf<CloudflareWorkerDescriptor>();
    expect(descriptor.rootModule).toBe(AppModule);
    expect(descriptor.options).toBe(options);
    // Workers read the string-keyed handlers only. `email` and `tail` appear
    // once a module imports @OnEmail() or @OnTail() (worker-events.test.ts).
    expect(Object.keys(worker).sort()).toEqual(['fetch', 'queue', 'scheduled']);
    expect(descriptor.workflows).toEqual([]);
    expect(descriptor.entrypoints).toEqual([]);
  });

  it('keeps the descriptor when the Worker is spread into an entry with more handlers', () => {
    const worker = createCloudflareWorker(AppModule);
    const entry = {
      ...worker,
      async email() {},
    };
    expect(entry[CLOUDFLARE_WORKER]).toBe(worker[CLOUDFLARE_WORKER]);
    expect(Object.assign({}, worker)[CLOUDFLARE_WORKER]).toBe(worker[CLOUDFLARE_WORKER]);
  });

  it("leaves the configure hook to the Worker's own application", async () => {
    const configured: unknown[] = [];
    const worker = createCloudflareWorker(AppModule, {
      configure(app, env) {
        configured.push(env);
        app.getHonoApp().get('/extra', (c) => c.text('extra'));
      },
    });
    const env = { GREETING: 'hello' };
    const descriptor = worker[CLOUDFLARE_WORKER];
    expect(descriptor.createOptions(env)).not.toHaveProperty('configure');
    const app = await descriptor.createApplication(env);
    try {
      expect(configured).toEqual([]);
      expect((await app.fetch(new Request('http://worker/extra'), env)).status).toBe(404);
    } finally {
      await app.dispose();
    }
    const served = await worker.fetch(new Request('http://worker/extra'), env, {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    });
    expect(await served.text()).toBe('extra');
    expect(configured).toEqual([env]);
  });

  it('builds the same application for an environment as the Worker does', async () => {
    const worker = createCloudflareWorker(AppModule, { globalPrefix: '/api' });
    const env = { GREETING: 'from the descriptor' };
    const { rootModule, createOptions, createApplication } = worker[CLOUDFLARE_WORKER];
    // createOptions() feeds VelaFactory.create (and @velajs/cloudflare/testing) directly.
    expect(createOptions(env).env).toBe(env);
    const created = await VelaFactory.create(rootModule, createOptions(env));
    expect(created.get(ENV)).toBe(env);
    expect(created.getGlobalPrefix()).toBe('/api');
    await created.dispose();
    const app = await createApplication(env);
    try {
      expect(app.get(ENV)).toBe(env);
      expect(app.describeRoutes().map((route) => `${route.method} ${route.path}`)).toEqual([
        'GET /api/hello',
      ]);
      const response = await app.fetch(new Request('http://worker/api/hello'), env);
      expect(await response.json()).toEqual({ message: 'from the descriptor' });
      // The Cloudflare adapter binds requests to the environment it was built for.
      const foreign = await app.fetch(new Request('http://worker/api/hello'), {});
      expect(foreign.status).toBe(500);
    } finally {
      await app.dispose();
    }
    const served = await worker.fetch(new Request('http://worker/api/hello'), env, {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    });
    expect(await served.json()).toEqual({ message: 'from the descriptor' });
  });

  it('describes the Durable Object classes defined from the same app', () => {
    @Injectable()
    class CounterHost {
      increment(by: number): number {
        return by;
      }
      // Public, but not listed: not an RPC method.
      audit(): string {
        return 'audit';
      }
      alarm(): void {}
      onModuleInit(): void {}
    }
    const options = { globalPrefix: '/api' };
    const app = defineCloudflareApp(AppModule, options);
    expectTypeOf(app).toEqualTypeOf<CloudflareApp>();
    expect(isCloudflareApp(app)).toBe(true);
    expect(isCloudflareApp({ ...app })).toBe(false);
    expect(app.rootModule).toBe(AppModule);
    expect(app.options).toBe(options);
    expect(app.worker[CLOUDFLARE_WORKER].options).toBe(options);
    expect(app.worker[CLOUDFLARE_WORKER].durableObjects).toEqual([]);

    class Counter extends VelaDurableObject(app, CounterHost, { rpc: ['increment'] }) {}
    class Room extends VelaWebSocketDurableObject(app) {}
    // A class built from a bare root belongs to no app.
    class Standalone extends VelaDurableObject(AppModule, CounterHost) {}

    const described: CloudflareDurableObjectDescriptor[] = [
      ...app.worker[CLOUDFLARE_WORKER].durableObjects,
    ];
    expect(described.map(({ kind, methods, host }) => ({ kind, methods, host }))).toEqual([
      { kind: 'host', methods: ['increment'], host: CounterHost },
      {
        kind: 'websocket',
        methods: [
          'broadcast',
          'invalidate',
          'inspectLive',
          'pitrCurrentBookmark',
          'pitrBookmarkForTime',
          'pitrArmRestore',
        ],
        host: undefined,
      },
    ]);
    expect(app.durableObjects).toBe(app.worker[CLOUDFLARE_WORKER].durableObjects);
    // The exported subclass carries its descriptor statically, for tools.
    expect(Reflect.get(Counter, CLOUDFLARE_DURABLE_OBJECT)).toBe(described[0]);
    expect(Reflect.get(Room, CLOUDFLARE_DURABLE_OBJECT)).toBe(described[1]);
    // Without an rpc list, a host class has only its event handlers.
    expect(Reflect.get(Standalone, CLOUDFLARE_DURABLE_OBJECT)).toMatchObject({
      kind: 'host',
      rootModule: AppModule,
      methods: [],
    });
    expect(Reflect.get(Standalone.prototype, 'increment')).toBeUndefined();
    expect(described[0]?.durableObject.isPrototypeOf(Counter)).toBe(true);
    // The RPC methods and handlers are the class's prototype members.
    expect(typeof Reflect.get(Counter.prototype, 'increment')).toBe('function');
    expect(typeof Reflect.get(Counter.prototype, 'alarm')).toBe('function');
    expect(Reflect.get(Counter.prototype, 'audit')).toBeUndefined();
    expect(Reflect.get(Counter.prototype, 'fetch')).toBeUndefined();
    expect(Reflect.get(Counter.prototype, 'onModuleInit')).toBeUndefined();
  });

  it('builds createCloudflareWorker from the same app definition', () => {
    const options = { globalPrefix: '/api' };
    const worker = createCloudflareWorker(AppModule, options);
    expect(worker[CLOUDFLARE_WORKER].options).toBe(options);
    expect(worker[CLOUDFLARE_WORKER].durableObjects).toEqual([]);
  });
});
