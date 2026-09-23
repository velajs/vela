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
