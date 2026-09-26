import { describe, expect, it } from 'vitest';
import { ConfigurableModuleBuilder, Inject, Injectable, Module, VelaFactory } from '../index';

describe('registration ownership', () => {
  it('shares a reused definition and lifecycle only within each application', async () => {
    const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = new ConfigurableModuleBuilder<{
      label: string;
    }>({ moduleName: 'Local' }).build();
    let initialized = 0;
    @Injectable()
    class LocalService {
      readonly state: string[] = [];
      constructor(@Inject(MODULE_OPTIONS_TOKEN) readonly options: { label: string }) {}
      onModuleInit() {
        initialized++;
      }
    }
    @Module({ providers: [LocalService], exports: [LocalService] })
    class LocalModule extends ConfigurableModuleClass {}
    const shared = LocalModule.register({ label: 'shared' });
    @Module({ imports: [shared] })
    class FirstFeature {}
    @Module({ imports: [shared] })
    class SecondFeature {}
    @Module({ imports: [FirstFeature, SecondFeature] })
    class Root {}
    const first = await VelaFactory.createApplicationContext(Root, { diagnostics: 'throw' });
    const second = await VelaFactory.createApplicationContext(Root, { diagnostics: 'throw' });
    try {
      expect(initialized).toBe(2);
      expect(first.getContainer().getOwnerModuleIds(LocalService)).toHaveLength(1);
      expect(second.get(LocalService)).not.toBe(first.get(LocalService));
      first.get(LocalService).state.push('first');
      expect(second.get(LocalService).state).toEqual([]);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });

  it('keeps method naming independent of the selected identity on builder branches', () => {
    const builder = new ConfigurableModuleBuilder<{ label: string }>({ identity: 'structural' });
    const { ConfigurableModuleClass: Shared } = builder.setClassMethodName('forRoot').build();
    const { ConfigurableModuleClass: Registered } = builder.build();
    expect(Shared.forRoot({ label: 'one' }).key).toBe(Shared.forRoot({ label: 'two' }).key);
    expect(Registered.register({ label: 'one' }).key).toBe(
      Registered.register({ label: 'two' }).key,
    );
    const { ConfigurableModuleClass: Local } = new ConfigurableModuleBuilder<{ label: string }>()
      .setClassMethodName('configure')
      .build();
    expect(Local.configure({ label: 'one' }).key).not.toBe(Local.configure({ label: 'one' }).key);
  });
});
