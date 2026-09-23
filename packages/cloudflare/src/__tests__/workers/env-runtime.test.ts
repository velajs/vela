// @ts-expect-error virtual module supplied by @cloudflare/vitest-plugin
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  ConfigModule,
  Controller,
  ENV,
  Get,
  Inject,
  InjectEnv,
  Module,
  SignedUrl,
  UrlGeneratorService,
  registerAs,
  type ConfigType,
  type VelaEnv,
} from '@velajs/vela';
import { createCloudflareApp, createCloudflareWorker } from '../../cloudflare-factory';

// The Worker and Durable Object runtimes seed the native environment as the
// framework ENV under real workerd, typed by the bindings `wrangler types`
// declares (see worker-configuration.d.ts).

const probeConfig = registerAs('probe', (bindings) => ({ value: bindings.ENV_PROBE }));

@Controller('/env')
class EnvController {
  constructor(
    @InjectEnv() private readonly bindings: VelaEnv,
    @Inject(probeConfig.KEY) private readonly probe: ConfigType<typeof probeConfig>,
    @Inject(UrlGeneratorService) private readonly urls: UrlGeneratorService,
  ) {}

  @Get('probe')
  read() {
    // Test-only: a variable the synthetic environments below override.
    const probe: unknown = Reflect.get(this.bindings, 'ENV_PROBE');
    return { probe, config: this.probe.value };
  }

  @Get('sign')
  async sign() {
    return { url: await this.urls.signedUrl('env.download', {}, { expiresIn: 60 }) };
  }

  @Get('download', { name: 'env.download' })
  @SignedUrl()
  download() {
    return { downloaded: true };
  }
}

@Module({
  imports: [ConfigModule.forRoot({ load: [probeConfig], isGlobal: true })],
  controllers: [EnvController],
})
class EnvApp {}

const context = {
  waitUntil: (_promise: Promise<unknown>): void => {},
  passThroughOnException() {},
  props: {},
};

async function json(response: Response): Promise<unknown> {
  expect(response.status).toBe(200);
  return response.json();
}

describe('framework ENV under workerd', () => {
  it('seeds the Worker environment as ENV for providers and config namespaces', async () => {
    const app = await createCloudflareApp(EnvApp, { env });
    expect(app.get(ENV)).toBe(env);
    expect(app.get(ENV).ENV_PROBE).toBe('workerd-env');
    expect(await json(await app.fetch(new Request('https://worker.test/env/probe'), env))).toEqual({
      probe: 'workerd-env',
      config: 'workerd-env',
    });
    await app.close();
  });

  it('signs and verifies URLs with the URL_SIGNING_SECRET variable from ENV', async () => {
    const worker = createCloudflareWorker(EnvApp);
    const request = (path: string, bindings: VelaEnv = env) =>
      worker.fetch(new Request(`https://worker.test${path}`), bindings, context);
    const signed = await json(await request('/env/sign'));
    if (typeof signed !== 'object' || signed === null || !('url' in signed)) {
      throw new Error('Expected a signed URL');
    }
    const url = String(signed.url);

    expect(await json(await request(url))).toEqual({ downloaded: true });
    // Another environment identity carries another secret: the signature fails there.
    const rotated = { ...env, URL_SIGNING_SECRET: 'rotated-signing-secret' };
    expect((await request(url, rotated)).status).toBe(403);
  });

  it('builds one application and ENV per environment identity', async () => {
    const worker = createCloudflareWorker(EnvApp);
    const a = { ...env, ENV_PROBE: 'a' };
    const b = { ...env, ENV_PROBE: 'b' };
    const read = async (bindings: VelaEnv) =>
      json(await worker.fetch(new Request('https://worker.test/env/probe'), bindings, context));

    const [first, second] = await Promise.all([read(a), read(b)]);
    expect(first).toEqual({ probe: 'a', config: 'a' });
    expect(second).toEqual({ probe: 'b', config: 'b' });
    expect(await read(a)).toEqual({ probe: 'a', config: 'a' });
  });

  it('seeds the Durable Object environment as ENV', async () => {
    const response: Response = await SELF.fetch('https://worker.test/rooms/env-probe/ws', {
      headers: {
        upgrade: 'websocket',
        origin: 'https://app.test',
        'x-test-auth': 'allowed',
        cookie: 'session=60000',
      },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error('Expected a WebSocket');
    const frames: unknown[] = [];
    const reply = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for env')), 2_000);
      socket.addEventListener('message', (event) => {
        const frame: unknown = JSON.parse(String(event.data));
        frames.push(frame);
        if (typeof frame === 'object' && frame !== null && Reflect.get(frame, 'event') === 'env') {
          clearTimeout(timeout);
          resolve(frame);
        }
      });
    });
    socket.accept();
    socket.send(JSON.stringify({ event: 'env' }));

    expect(await reply).toEqual({ event: 'env', data: { probe: 'workerd-env' } });
    socket.close(1000, 'done');
  });
});
