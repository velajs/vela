import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ENV,
  InjectionToken,
  Module,
  VelaFactory,
  defineModule,
  defineProvider,
  type VelaEnv,
} from '../index';
import { sideEffectModule } from '../module-kit';

afterEach(() => {
  vi.restoreAllMocks();
});

interface RegionOptions {
  region: string;
}

const REGION = new InjectionToken<string>('identity test region');

// A deliberately coarse key: every call lands on the same (class, key)
// identity, so only the call-time inputs tell the instances apart.
const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = defineModule<RegionOptions>({
  name: 'Region',
  key: () => 'shared',
  setup: ({ OPTIONS }) => ({
    providers: [
      defineProvider(REGION, { useFactory: (options) => options.region, inject: [OPTIONS] }),
    ],
    exports: [REGION, OPTIONS],
  }),
});
class RegionModule extends ConfigurableModuleClass {}

describe('module identity collisions', () => {
  it('fails bootstrap on a repeated (class, key) whose options differ, in every mode', async () => {
    @Module({
      imports: [RegionModule.forRoot({ region: 'eu' }), RegionModule.forRoot({ region: 'us' })],
    })
    class AppModule {}

    // Keeping the first configuration would run the second import's consumers
    // on options they never asked for, so no diagnostics policy downgrades it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const diagnostics of ['throw', 'log', 'silent'] as const) {
      await expect(VelaFactory.create(AppModule, { diagnostics })).rejects.toThrow(
        /RegionModule#shared was imported again with different options/,
      );
    }
    await expect(VelaFactory.create(AppModule)).rejects.toThrow(/different options/);
    expect(warn).not.toHaveBeenCalled();
  });

  it('still deduplicates identical repeats', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    @Module({
      imports: [RegionModule.forRoot({ region: 'eu' }), RegionModule.forRoot({ region: 'eu' })],
    })
    class AppModule {}
    const app = await VelaFactory.create(AppModule, { diagnostics: 'throw' });
    expect(app.getContainer().getOwnerModuleIds(MODULE_OPTIONS_TOKEN)).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    await app.close();
  });

  it('tells distinct closures with identical source apart', async () => {
    const regional = (region: string) =>
      RegionModule.forRootAsync({ key: 'shared', inject: [], useFactory: () => ({ region }) });
    @Module({ imports: [regional('eu'), regional('us')] })
    class Distinct {}
    await expect(VelaFactory.create(Distinct, { diagnostics: 'throw' })).rejects.toThrow(
      /RegionModule#shared was imported again with different options/,
    );

    const useFactory = () => ({ region: 'eu' });
    @Module({
      imports: [
        RegionModule.forRootAsync({ key: 'shared', inject: [], useFactory }),
        RegionModule.forRootAsync({ key: 'shared', inject: [], useFactory }),
      ],
    })
    class Shared {}
    const app = await VelaFactory.create(Shared, { diagnostics: 'throw' });
    expect(app.get(REGION)).toBe('eu');
    await app.close();
  });

  it('reports a parameterized helper whose closures read different bindings', async () => {
    // One helper, two configurations: the factories share their source text
    // and differ only in the binding name each closure captured.
    const region = (binding: string) =>
      RegionModule.forRootAsync({
        key: 'shared',
        inject: [ENV],
        useFactory: (env: VelaEnv) => {
          const value: unknown = Reflect.get(env, binding);
          return { region: typeof value === 'string' ? value : 'unset' };
        },
      });
    @Module({ imports: [region('PRIMARY_REGION'), region('BACKUP_REGION')] })
    class TwoBindings {}
    const env = { PRIMARY_REGION: 'eu', BACKUP_REGION: 'us' };

    await expect(VelaFactory.create(TwoBindings, { diagnostics: 'throw', env })).rejects.toThrow(
      /RegionModule#shared was imported again with different options/,
    );
    // The default policy never serves the backup binding's consumers the primary region.
    await expect(VelaFactory.create(TwoBindings, { env })).rejects.toThrow(
      /RegionModule#shared was imported again with different options/,
    );
  });

  it('asks a helper that rebuilds one configuration to share a single definition', async () => {
    // Calling the helper twice builds two closures, so the repeat is reported;
    // exporting one definition (or a key per configuration) resolves it.
    const rebuild = () =>
      RegionModule.forRootAsync({
        key: 'shared',
        inject: [],
        useFactory: () => ({ region: 'eu' }),
      });
    @Module({ imports: [rebuild(), rebuild()] })
    class Rebuilt {}
    await expect(VelaFactory.create(Rebuilt, { diagnostics: 'throw' })).rejects.toThrow(
      /Import one shared definition \(e\.g\. export a const of the DynamicModule\)/,
    );

    const regionModule = rebuild();
    @Module({ imports: [regionModule, regionModule] })
    class SharedDefinition {}
    const app = await VelaFactory.create(SharedDefinition, { diagnostics: 'throw' });
    expect(app.get(REGION)).toBe('eu');
    expect(app.getContainer().getOwnerModuleIds(MODULE_OPTIONS_TOKEN)).toHaveLength(1);
    await app.close();
  });

  it('compares object instances by reference', async () => {
    const REGION_SOURCE = new InjectionToken<string>('identity test region source');
    @Module({
      providers: [defineProvider(REGION_SOURCE, { useValue: 'eu' })],
      exports: [REGION_SOURCE],
    })
    class SourceModule {}
    // One shared factory, so only the injected token instance varies.
    const useFactory = (region: string) => ({ region });
    const fromSource = (source: InjectionToken<string>) =>
      RegionModule.forRootAsync({
        key: 'shared',
        imports: [SourceModule],
        inject: [source],
        useFactory,
      });

    @Module({ imports: [fromSource(REGION_SOURCE), fromSource(REGION_SOURCE)] })
    class SameInstance {}
    const app = await VelaFactory.create(SameInstance, { diagnostics: 'throw' });
    expect(app.get(REGION)).toBe('eu');
    expect(app.getContainer().getOwnerModuleIds(MODULE_OPTIONS_TOKEN)).toHaveLength(1);
    await app.close();

    // Equal-looking but distinct token instances are different inputs.
    @Module({
      imports: [
        fromSource(new InjectionToken<string>('identity test region source')),
        fromSource(new InjectionToken<string>('identity test region source')),
      ],
    })
    class DistinctInstances {}
    const message =
      '[vela] RegionModule#shared was imported again with different options, and one module ' +
      'instance has one configuration. Import one shared definition (e.g. export a const of ' +
      'the DynamicModule) instead of building it twice, or give each configuration its own ' +
      "key (e.g. forRoot({ ..., key: 'secondary' })).";
    await expect(VelaFactory.create(DistinctInstances, { diagnostics: 'throw' })).rejects.toThrow(
      message,
    );
  });

  it('compares symbol-keyed options', async () => {
    const TIER: unique symbol = Symbol('identity test tier');
    interface TieredOptions {
      region: string;
      [TIER]: string;
    }
    const { ConfigurableModuleClass: TieredBase } = defineModule<TieredOptions>({
      name: 'Tiered',
      key: () => 'shared',
      setup: () => ({}),
    });
    class TieredModule extends TieredBase {}

    @Module({
      imports: [
        TieredModule.forRoot({ region: 'eu', [TIER]: 'gold' }),
        TieredModule.forRoot({ region: 'eu', [TIER]: 'silver' }),
      ],
    })
    class Conflicting {}
    await expect(VelaFactory.create(Conflicting, { diagnostics: 'throw' })).rejects.toThrow(
      /TieredModule#shared was imported again with different options/,
    );

    @Module({
      imports: [
        TieredModule.forRoot({ region: 'eu', [TIER]: 'gold' }),
        TieredModule.forRoot({ region: 'eu', [TIER]: 'gold' }),
      ],
    })
    class Repeated {}
    const app = await VelaFactory.create(Repeated, { diagnostics: 'throw' });
    await app.close();
  });

  it('reports side-effect contributions that differ under a stable owner', async () => {
    const MESSAGES = new InjectionToken<string>('identity test messages');
    class Messages {}
    const contribute = (value: string) =>
      sideEffectModule(Messages, {
        providers: [defineProvider(MESSAGES, { useValue: value })],
        exports: [MESSAGES],
      });

    @Module({ imports: [contribute('hello'), contribute('bonjour')] })
    class Conflicting {}
    await expect(VelaFactory.create(Conflicting, { diagnostics: 'throw' })).rejects.toThrow(
      /Messages#[0-9a-f]+ was imported again with different options/,
    );

    @Module({ imports: [contribute('hello'), contribute('hello')] })
    class Repeated {}
    const app = await VelaFactory.create(Repeated, { diagnostics: 'throw' });
    expect(app.get(MESSAGES)).toBe('hello');
    await app.close();
  });
});
