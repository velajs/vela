import { InjectionToken, Module, VelaFactory, defineProvider } from '@velajs/vela';
import { runInEntrypointScope } from '@velajs/vela/module-kit';
import { Test } from '@velajs/testing';
import { describe, expect, it } from 'vitest';
import {
  FEATURE_FLAG_TOKENS,
  FeatureFlagDriverRegistry,
  FeatureFlagGuard,
  FeatureFlagsModule,
  FeatureFlagsService,
  memoryFlagDriver,
} from '../index';

describe('FeatureFlagsModule', () => {
  it('forRoot: resolves the service at root/global scope (no request needed)', async () => {
    // This is the proof the service works in queue / scheduled / global scope:
    // resolving it via module.get() (root, no request) must not throw.
    const moduleRef = await Test.createTestingModule({
      imports: [
        FeatureFlagsModule.forRoot({
          drivers: [memoryFlagDriver({ values: { 'new-checkout': true } })],
          manifest: { 'new-checkout': false, layout: 'v1' },
        }),
      ],
    }).compile();

    const flags = moduleRef.get(FEATURE_FLAG_TOKENS.Service);
    expect(flags).toBeInstanceOf(FeatureFlagsService);
    expect(await flags.getBooleanValue('new-checkout')).toBe(true); // driver value
    expect(await flags.getStringValue('layout')).toBe('v1'); // manifest default
  });

  it('resolves and evaluates inside an entrypoint (queue/cron) scope — no request', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        FeatureFlagsModule.forRoot({ drivers: [memoryFlagDriver({ values: { job: true } })] }),
      ],
    }).compile();
    const app = await moduleRef.createApplication();

    // runInEntrypointScope deliberately does NOT seed REQUEST_CONTEXT; the
    // service must still resolve and evaluate there.
    const value = await runInEntrypointScope(app.getContainer(), async (scope) => {
      const flags = scope.resolve(FEATURE_FLAG_TOKENS.Service);
      return flags.getBooleanValue('job');
    });
    expect(value).toBe(true);
  });

  it('forRoot: defaults to a single in-memory driver when none are configured', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FeatureFlagsModule.forRoot({ manifest: { flag: true } })],
    }).compile();

    const registry = moduleRef.get(FEATURE_FLAG_TOKENS.DriverRegistry);
    expect(registry).toBeInstanceOf(FeatureFlagDriverRegistry);
    expect(registry.names()).toEqual(['memory']);
    expect(await moduleRef.get(FEATURE_FLAG_TOKENS.Service).getBooleanValue('flag')).toBe(true);
  });

  it('forRootAsync: builds options from an injected dependency', async () => {
    const CONFIG = new InjectionToken<{ enabled: boolean }>('test:config');

    @Module({
      providers: [defineProvider(CONFIG, { useValue: { enabled: true } })],
      exports: [CONFIG],
    })
    class ConfigModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule,
        FeatureFlagsModule.forRootAsync({
          imports: [ConfigModule],
          inject: [CONFIG],
          useFactory: (config: { enabled: boolean }) => ({
            drivers: [memoryFlagDriver({ values: { beta: config.enabled } })],
          }),
        }),
      ],
    }).compile();

    expect(await moduleRef.get(FEATURE_FLAG_TOKENS.Service).getBooleanValue('beta')).toBe(true);
  });

  it('exports the driver registry and options token', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FeatureFlagsModule.forRoot({ default: 'memory' })],
    }).compile();

    expect(moduleRef.get(FEATURE_FLAG_TOKENS.DriverRegistry).defaultName).toBe('memory');
    expect(moduleRef.get(FEATURE_FLAG_TOKENS.Options)).toMatchObject({ default: 'memory' });
  });

  it('registers one instance, and one app-wide guard, for registrations that spell out defaults', async () => {
    const manifest = { beta: false };
    // `guard` defaults to 'global' and the module is lazy by default.
    const registrations = [
      FeatureFlagsModule.forRoot({ manifest }),
      FeatureFlagsModule.forRoot({ manifest, guard: 'global' }),
      FeatureFlagsModule.forRoot({ manifest, lazy: true }),
    ];
    expect(new Set(registrations.map((registration) => registration.key)).size).toBe(1);

    @Module({ imports: registrations })
    class AppModule {}
    const app = await VelaFactory.create(AppModule, { diagnostics: 'throw' });
    expect(app.getContainer().getOwnerModuleIds(FeatureFlagGuard)).toHaveLength(1);
    expect(app.getContainer().getOwnerModuleIds(FEATURE_FLAG_TOKENS.Options)).toHaveLength(1);
    await app.close();
  });
});
