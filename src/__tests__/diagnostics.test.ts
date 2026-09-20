import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Injectable,
  MetadataRegistry,
  Module,
  ModuleVisibilityError,
  VelaFactory,
} from '../index.js';
import { Container } from '../internal.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Diagnostics', () => {
  it("default 'log': provider construction failures abort bootstrap", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    @Injectable()
    class FailsInCtor {
      constructor() {
        throw new Error('intentional ctor failure');
      }
    }

    @Module({ providers: [FailsInCtor] })
    class App {}

    await expect(VelaFactory.create(App)).rejects.toThrow('intentional ctor failure');
    expect(warn).not.toHaveBeenCalled();
  });

  it("'silent' suppresses diagnostics but still rejects a partial application", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    @Injectable()
    class FailsInCtor {
      constructor() {
        throw new Error('intentional ctor failure');
      }
    }

    @Module({ providers: [FailsInCtor] })
    class App {}

    await expect(VelaFactory.create(App, { diagnostics: 'silent' })).rejects.toThrow('intentional ctor failure');
    const velaWarnings = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('[vela]'));
    expect(velaWarnings).toEqual([]);
  });

  it("'throw' propagates discovery errors during bootstrap", async () => {
    @Injectable()
    class FailsInCtor {
      constructor() {
        throw new Error('intentional ctor failure');
      }
    }

    @Module({ providers: [FailsInCtor] })
    class App {}

    await expect(VelaFactory.create(App, { diagnostics: 'throw' })).rejects.toThrow(
      /intentional ctor failure/,
    );
  });

  it('ModuleVisibilityError ALWAYS propagates regardless of diagnostics mode', async () => {
    @Injectable()
    class ServiceA {}
    @Injectable()
    class ServiceB {
      constructor(public a: ServiceA) {}
    }

    @Module({ providers: [ServiceA] })
    class ModA {}
    @Module({ imports: [ModA], providers: [ServiceB] })
    class ModB {}

    // Even with 'silent', module-visibility violations must throw.
    await expect(VelaFactory.create(ModB, { diagnostics: 'silent' })).rejects.toThrow(
      ModuleVisibilityError,
    );

    MetadataRegistry.clear();

    @Module({ providers: [ServiceA] })
    class ModA2 {}
    @Module({ imports: [ModA2], providers: [ServiceB] })
    class ModB2 {}

    // Same with 'log'.
    await expect(VelaFactory.create(ModB2, { diagnostics: 'log' })).rejects.toThrow(
      ModuleVisibilityError,
    );
  });

  it('Container.getDiagnostics returns the configured mode', () => {
    const c1 = new Container();
    expect(c1.getDiagnostics()).toBe('log');

    const c2 = new Container({ diagnostics: 'silent' });
    expect(c2.getDiagnostics()).toBe('silent');

    const c3 = new Container({ diagnostics: 'throw' });
    expect(c3.getDiagnostics()).toBe('throw');
  });
});
