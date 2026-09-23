import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  Controller,
  ENV,
  Get,
  Injectable,
  InjectEnv,
  InjectionToken,
  Module,
  defineProvider,
  type VelaEnv,
} from '@velajs/vela';
import type { RuntimeAdapter } from '@velajs/vela/module-kit';
import { Test } from '@velajs/testing';
import * as cloudflare from '../index';
import {
  createCloudflareApp,
  createCloudflareWorker,
  type CloudflareWorkerOptions,
  type CreateCloudflareAppOptions,
} from '../cloudflare-factory';
import { buildDoRuntime } from '../websocket/do-bootstrap';
import { CloudflareWebSocketModule } from '../websocket/cloudflare-websocket.module';
import type { DoStateLike, WsLike } from '../websocket/do-state';

const context = { waitUntil: (_promise: Promise<unknown>): void => {} };
const httpContext = { ...context, passThroughOnException() {}, props: {} };

function probe(env: VelaEnv): string | undefined {
  const value: unknown = Reflect.get(env, 'PROBE');
  return typeof value === 'string' ? value : undefined;
}

function fixture() {
  @Injectable()
  class EnvProbe {
    constructor(@InjectEnv() readonly env: VelaEnv) {}
  }
  @Controller('/probe')
  class ProbeController {
    constructor(private readonly probes: EnvProbe) {}
    @Get()
    read() {
      return { probe: probe(this.probes.env) ?? null };
    }
  }
  // A feature module: ENV reaches it without an import because it is global.
  @Module({ providers: [EnvProbe], controllers: [ProbeController], exports: [EnvProbe] })
  class ProbeModule {}
  @Module({ imports: [ProbeModule] })
  class AppModule {}
  return { AppModule, EnvProbe };
}

class EmptyDoState implements DoStateLike {
  readonly id = { toString: () => 'do-1', name: 'room-1' };
  acceptWebSocket(): void {}
  getWebSockets(): WsLike[] {
    return [];
  }
}

describe('Cloudflare runtime ENV', () => {
  it('seeds the platform environment as the global ENV', async () => {
    const { AppModule, EnvProbe } = fixture();
    const env = { PROBE: 'worker' };
    const app = await createCloudflareApp(AppModule, { env });

    expect(app.get(ENV)).toBe(env);
    expect(app.get(EnvProbe).env).toBe(env);
    expect(await (await app.getHonoApp().request('/probe', undefined, env)).json()).toEqual({
      probe: 'worker',
    });
    await app.close();
  });

  it('builds a distinct application and ENV for every environment identity', async () => {
    const { AppModule } = fixture();
    const worker = createCloudflareWorker(AppModule);
    const a = { PROBE: 'a' };
    const b = { PROBE: 'b' };
    const read = async (env: object) =>
      (await worker.fetch(new Request('https://worker.test/probe'), env, httpContext)).json();

    const [first, second] = await Promise.all([read(a), read(b)]);
    expect(first).toEqual({ probe: 'a' });
    expect(second).toEqual({ probe: 'b' });
    expect(await read(a)).toEqual({ probe: 'a' });
  });

  it('seeds ENV in a Durable Object runtime before providers construct', async () => {
    const seen: VelaEnv[] = [];
    @Injectable()
    class RoomProbe {
      constructor(@InjectEnv() env: VelaEnv) {
        seen.push(env);
      }
    }
    @Module({ imports: [CloudflareWebSocketModule.forRoot()], providers: [RoomProbe] })
    class RoomModule {}
    const env = { PROBE: 'durable-object' };

    const runtime = await buildDoRuntime(RoomModule, new EmptyDoState(), { env });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(env);
    await runtime.close();
  });

  it('passes extra runtime adapters through createCloudflareApp and createCloudflareWorker', async () => {
    const { AppModule } = fixture();
    const MARKER = new InjectionToken<string>('adapter marker');
    const booted: string[] = [];
    const adapter: RuntimeAdapter = {
      name: 'marker',
      configureContainer: (container) => {
        container.register(defineProvider(MARKER, { useValue: 'from adapter' }));
      },
      onBootstrap: ({ container }) => {
        booted.push(container.resolve(MARKER));
      },
    };

    const app = await createCloudflareApp(AppModule, { env: { PROBE: 'x' }, adapters: [adapter] });
    expect(app.get(MARKER)).toBe('from adapter');
    await app.close();

    const worker = createCloudflareWorker(AppModule, { adapters: [adapter] });
    await worker.fetch(new Request('https://worker.test/probe'), { PROBE: 'y' }, httpContext);
    expect(booted).toEqual(['from adapter', 'from adapter']);
  });

  it('takes no environment token and exports no environment parameter decorator', () => {
    // ENV is framework-owned: the entry options carry no application token.
    expectTypeOf<keyof CloudflareWorkerOptions>().toEqualTypeOf<
      'globalPrefix' | 'security' | 'middleware' | 'adapters'
    >();
    expectTypeOf<keyof CreateCloudflareAppOptions>().toEqualTypeOf<
      keyof CloudflareWorkerOptions | 'env'
    >();
    expect(Object.keys(cloudflare)).not.toContain('Env');
    expectTypeOf(createCloudflareApp).parameter(1).toHaveProperty('env').toEqualTypeOf<VelaEnv>();
  });

  it('composes cloudflareAdapter({ env }) with a testing module and its HTTP builder', async () => {
    const { AppModule } = fixture();
    const env = { PROBE: 'tested' };
    const moduleRef = await Test.createTestingModule(
      { imports: [AppModule] },
      { env, adapters: [cloudflare.cloudflareAdapter({ env })] },
    ).compile();

    const response = await moduleRef.http.get('/probe').send();
    response.assertOk();
    await response.assertJson({ probe: 'tested' });
    await moduleRef.close();
  });
});
