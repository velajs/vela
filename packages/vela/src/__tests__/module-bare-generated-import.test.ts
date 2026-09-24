import { describe, expect, it } from 'vitest';
import {
  ConfigurableModuleBuilder,
  Controller,
  Get,
  Module,
  VelaFactory,
  defineModule,
  type CanActivate,
  type ModuleImport,
} from '../index.js';

// A policy module that installs a global guard, as the integration packages do.
class DenyAll implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

function policyModule() {
  const { ConfigurableModuleClass } = defineModule<{ realm: string }, 'realm'>({
    name: 'Policy',
    structural: ['realm'],
    setup: () => ({ global: { guards: [DenyAll] } }),
  });
  class PolicyModule extends ConfigurableModuleClass {}
  return PolicyModule;
}

@Controller('/items')
class ItemsController {
  @Get()
  list() {
    return [];
  }
}

function appImporting(...imports: ModuleImport[]) {
  @Module({ imports, controllers: [ItemsController] })
  class AppModule {}
  return AppModule;
}

const NOT_A_MODULE =
  'PolicyModule is not a module: import PolicyModule.forRoot(...) or PolicyModule.forRootAsync(...)';

describe('a bare import of a generated module class without @Module', () => {
  it('fails bootstrap before any configured import loaded the class', async () => {
    const PolicyModule = policyModule();
    await expect(VelaFactory.create(appImporting(PolicyModule))).rejects.toThrow(NOT_A_MODULE);
  });

  it('still fails after an earlier bootstrap loaded a configured import', async () => {
    const PolicyModule = policyModule();
    const configured = await VelaFactory.create(appImporting(PolicyModule.forRoot({ realm: 'a' })));
    try {
      expect((await configured.getHonoApp().request('/items')).status).toBe(403);
    } finally {
      await configured.close();
    }
    await expect(VelaFactory.create(appImporting(PolicyModule))).rejects.toThrow(NOT_A_MODULE);
    // Twice, so the first failure leaves nothing behind either.
    await expect(VelaFactory.create(appImporting(PolicyModule))).rejects.toThrow(NOT_A_MODULE);
  });

  it('fails beside a configured import in the same application, in either order', async () => {
    const PolicyModule = policyModule();
    await expect(
      VelaFactory.create(appImporting(PolicyModule.forRoot({ realm: 'a' }), PolicyModule)),
    ).rejects.toThrow(NOT_A_MODULE);
    await expect(
      VelaFactory.create(appImporting(PolicyModule, PolicyModule.forRoot({ realm: 'a' }))),
    ).rejects.toThrow(NOT_A_MODULE);
  });

  it('names the methods a ConfigurableModuleBuilder class generates', async () => {
    const { ConfigurableModuleClass } = new ConfigurableModuleBuilder<{ realm: string }>().build();
    class RealmModule extends ConfigurableModuleClass {}
    const configured = await VelaFactory.create(appImporting(RealmModule.register({ realm: 'a' })));
    await configured.close();
    await expect(VelaFactory.create(appImporting(RealmModule))).rejects.toThrow(
      'RealmModule is not a module: import RealmModule.register(...) or RealmModule.registerAsync(...)',
    );
  });

  it('boots a generated class that declares @Module itself when imported bare', async () => {
    const { ConfigurableModuleClass } = defineModule<{ realm?: string }>({ name: 'Declared' });
    @Module({})
    class DeclaredModule extends ConfigurableModuleClass {}
    const app = await VelaFactory.create(appImporting(DeclaredModule));
    try {
      expect((await app.getHonoApp().request('/items')).status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('keeps the message for a plain class without @Module', async () => {
    class Plain {}
    await expect(VelaFactory.create(appImporting(Plain))).rejects.toThrow(
      'Plain is not a module. Add @Module() decorator to the class.',
    );
  });
});
