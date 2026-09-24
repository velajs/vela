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
  CLOUDFLARE_WORKER,
  createCloudflareWorker,
  type CloudflareWorkerDescriptor,
} from '../index';

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
    // Workers read the handlers only; the descriptor stays out of enumeration.
    expect(Object.keys(worker).sort()).toEqual(['fetch', 'queue', 'scheduled']);
  });

  it('builds the same application for an environment as the Worker does', async () => {
    const worker = createCloudflareWorker(AppModule, { globalPrefix: '/api' });
    const env = { GREETING: 'from the descriptor' };
    const { rootModule, createOptions } = worker[CLOUDFLARE_WORKER];
    const app = await VelaFactory.create(rootModule, createOptions(env));
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
});
