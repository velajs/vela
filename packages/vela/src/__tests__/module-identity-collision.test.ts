import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InjectionToken,
  Module,
  VelaFactory,
  defineModule,
  defineProvider,
  sideEffectModule,
} from '../index';

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
  it('reports a repeated (class, key) whose options differ', async () => {
    @Module({
      imports: [RegionModule.forRoot({ region: 'eu' }), RegionModule.forRoot({ region: 'us' })],
    })
    class AppModule {}

    await expect(VelaFactory.create(AppModule, { diagnostics: 'throw' })).rejects.toThrow(
      /RegionModule#shared was imported again with different options/,
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = await VelaFactory.create(AppModule);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/RegionModule#shared was imported again with different options/),
    );
    // The first import still wins, exactly as before the diagnostic.
    expect(app.get(REGION)).toBe('eu');
    await app.close();

    warn.mockClear();
    const silent = await VelaFactory.create(AppModule, { diagnostics: 'silent' });
    expect(warn).not.toHaveBeenCalled();
    await silent.close();
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

  it('treats closures a shared helper rebuilds from the same source as one input', async () => {
    // Each call builds a new useFactory closure with the same source text.
    const sharedRegion = () =>
      RegionModule.forRootAsync({
        key: 'shared',
        inject: [],
        useFactory: () => ({ region: 'eu' }),
      });
    @Module({ imports: [sharedRegion(), sharedRegion()] })
    class Rebuilt {}
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = await VelaFactory.create(Rebuilt, { diagnostics: 'throw' });
    expect(app.get(REGION)).toBe('eu');
    expect(app.getContainer().getOwnerModuleIds(MODULE_OPTIONS_TOKEN)).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    await app.close();

    @Module({
      imports: [
        RegionModule.forRootAsync({
          key: 'shared',
          inject: [],
          useFactory: () => ({ region: 'eu' }),
        }),
        RegionModule.forRootAsync({
          key: 'shared',
          inject: [],
          useFactory: () => ({ region: 'us' }),
        }),
      ],
    })
    class DifferentSource {}
    await expect(VelaFactory.create(DifferentSource, { diagnostics: 'throw' })).rejects.toThrow(
      /RegionModule#shared was imported again with different options/,
    );
  });

  it('compares object instances by reference', async () => {
    const REGION_SOURCE = new InjectionToken<string>('identity test region source');
    @Module({
      providers: [defineProvider(REGION_SOURCE, { useValue: 'eu' })],
      exports: [REGION_SOURCE],
    })
    class SourceModule {}
    const fromSource = (source: InjectionToken<string>) =>
      RegionModule.forRootAsync({
        key: 'shared',
        imports: [SourceModule],
        inject: [source],
        useFactory: (region: string) => ({ region }),
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
      '[vela] RegionModule#shared was imported again with different options; the repeated ' +
      "import's providers were ignored in favor of the first. Import one shared definition " +
      'instead of building it twice, or give each configuration its own key ' +
      "(e.g. forRoot({ ..., key: 'secondary' })).";
    await expect(VelaFactory.create(DistinctInstances, { diagnostics: 'throw' })).rejects.toThrow(
      message,
    );
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
