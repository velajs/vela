import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import {
  ConfigModule,
  ConfigService,
  Controller,
  ENV,
  Get,
  Inject,
  Injectable,
  InjectEnv,
  InjectionToken,
  MetadataRegistry,
  Module,
  defineProvider,
  registerAs,
  type RuntimeAdapter,
  type VelaEnv,
} from '@velajs/vela';
import { Test } from '../test.js';

beforeEach(() => MetadataRegistry.clear());

function probe(env: VelaEnv): string | undefined {
  const value: unknown = Reflect.get(env, 'PROBE');
  return typeof value === 'string' ? value : undefined;
}

function featureModule() {
  @Injectable()
  class EnvReader {
    constructor(@InjectEnv() readonly env: VelaEnv) {}
    probe(): string | undefined {
      return probe(this.env);
    }
  }
  // ENV is global: this feature module injects it without importing anything.
  @Module({ providers: [EnvReader], exports: [EnvReader] })
  class FeatureModule {}
  return { FeatureModule, EnvReader };
}

describe('TestingModuleBuilder env and adapters', () => {
  it('seeds ENV from the env option through the production bootstrap', async () => {
    const { FeatureModule, EnvReader } = featureModule();
    const env = { PROBE: 'seeded' };
    const moduleRef = await Test.createTestingModule(
      { imports: [FeatureModule] },
      { env },
    ).compile();

    expect(moduleRef.get(ENV)).toBe(env);
    expectTypeOf(moduleRef.get(ENV)).toEqualTypeOf<VelaEnv>();
    expect(moduleRef.get(EnvReader).probe()).toBe('seeded');
    await moduleRef.close();
  });

  it('overrides ENV for providers in imported modules, with or without a seeded env', async () => {
    const { FeatureModule, EnvReader } = featureModule();
    const replaced = await Test.createTestingModule(
      { imports: [FeatureModule] },
      { env: { PROBE: 'seeded' } },
    )
      .overrideProvider(ENV)
      .useValue({ PROBE: 'overridden' })
      .compile();
    const unseeded = await Test.createTestingModule({ imports: [featureModule().FeatureModule] })
      .overrideProvider(ENV)
      .useValue({ PROBE: 'override only' })
      .compile();

    expect(replaced.get(EnvReader).probe()).toBe('overridden');
    expect(probe(unseeded.get(ENV))).toBe('override only');
    await Promise.all([replaced.close(), unseeded.close()]);
  });

  it('feeds the testing ENV to registerAs namespaces', async () => {
    const appConfig = registerAs('app', (env) => ({ probe: probe(env) ?? 'unset' }));
    @Injectable()
    class Reader {
      constructor(@Inject(appConfig.KEY) readonly config: { probe: string }) {}
    }
    const moduleRef = await Test.createTestingModule(
      {
        imports: [ConfigModule.forRoot({ load: [appConfig], isGlobal: true })],
        providers: [Reader],
      },
      { env: { PROBE: 'config' } },
    ).compile();

    expect(moduleRef.get(Reader).config).toEqual({ probe: 'config' });
    expect(moduleRef.get(ConfigService).get('app.probe')).toBe('config');
    await moduleRef.close();
  });

  it('binds runtime adapters like VelaFactory.create', async () => {
    const MARKER = new InjectionToken<string>('adapter marker');
    const hooks: string[] = [];
    const adapter: RuntimeAdapter = {
      name: 'synthetic-runtime',
      configureContainer: (container) => {
        container.register(defineProvider(ENV, { useValue: { PROBE: 'from adapter' } }));
        container.register(defineProvider(MARKER, { useValue: 'marker' }));
      },
      requestMiddleware: [
        async (context, next) => {
          await next();
          context.res.headers.set('x-runtime', 'synthetic');
        },
      ],
      onBootstrap: () => {
        hooks.push('bootstrap');
      },
      onRoutesBuilt: () => {
        hooks.push('routes');
      },
    };
    @Controller('/probe')
    class ProbeController {
      constructor(@InjectEnv() private readonly env: VelaEnv) {}
      @Get()
      read() {
        return { probe: probe(this.env) ?? null };
      }
    }

    const moduleRef = await Test.createTestingModule(
      { controllers: [ProbeController] },
      { adapters: [adapter] },
    ).compile();
    const app = await moduleRef.createApplication();
    const response = await app.getHonoApp().request('/probe');

    expect(moduleRef.get(MARKER)).toBe('marker');
    expect(hooks).toEqual(['bootstrap', 'routes']);
    expect(response.headers.get('x-runtime')).toBe('synthetic');
    expect(await response.json()).toEqual({ probe: 'from adapter' });
    await moduleRef.close();
  });
});
