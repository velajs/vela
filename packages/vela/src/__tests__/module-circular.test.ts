import { describe, it, expect, beforeEach } from 'vitest';
import { VelaFactory, Module, Injectable, MetadataRegistry } from '../index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

describe('Module circular detection', () => {
  it('should throw on direct circular module dependency (A imports B, B imports A)', async () => {
    // We need to define both modules before decorating to create the cycle.
    // Use a forward reference pattern.

    // ModuleA imports ModuleB
    @Module({ providers: [] })
    class ModuleB {}

    @Module({ imports: [ModuleB] })
    class ModuleA {}

    // Now patch ModuleB to import ModuleA — creating a cycle
    // We need to re-set the module options in the registry
    MetadataRegistry.setModuleOptions(ModuleB, { imports: [ModuleA] });

    await expect(VelaFactory.create(ModuleA)).rejects.toThrow(
      /Circular module dependency detected/,
    );
  });

  it('should throw on indirect circular dependency (A → B → C → A)', async () => {
    @Module({})
    class ModuleC {}

    @Module({ imports: [ModuleC] })
    class ModuleB {}

    @Module({ imports: [ModuleB] })
    class ModuleA {}

    // Close the cycle: C imports A
    MetadataRegistry.setModuleOptions(ModuleC, { imports: [ModuleA] });

    await expect(VelaFactory.create(ModuleA)).rejects.toThrow(
      /Circular module dependency detected/,
    );
  });

  it('should throw when a non-module class is imported', async () => {
    class NotAModule {}

    @Module({ imports: [NotAModule] })
    class AppModule {}

    await expect(VelaFactory.create(AppModule)).rejects.toThrow(/NotAModule is not a module/);
  });

  it('should handle diamond dependencies without error (A → B, A → C, B → D, C → D)', async () => {
    @Injectable()
    class SharedService {
      value = 'shared';
    }

    @Module({ providers: [SharedService], exports: [SharedService] })
    class ModuleD {}

    @Module({ imports: [ModuleD] })
    class ModuleB {}

    @Module({ imports: [ModuleD] })
    class ModuleC {}

    @Module({ imports: [ModuleB, ModuleC] })
    class AppModule {}

    // Should not throw — D is processed once and cached
    const app = await VelaFactory.create(AppModule);
    const shared = app.get(SharedService);
    expect(shared.value).toBe('shared');
  });

  it('should handle duplicate imports gracefully', async () => {
    @Injectable()
    class CountService {
      count = 0;
    }

    @Module({ providers: [CountService], exports: [CountService] })
    class SharedModule {}

    // Import the same module twice
    @Module({ imports: [SharedModule, SharedModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const svc = app.get(CountService);
    expect(svc.count).toBe(0);
  });
});
