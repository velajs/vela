import { defineProvider } from '../container/types';
import { describe, expect, it } from 'vitest';
import { Inject, Injectable, InjectionToken } from '../index.js';
import { ROOT_MODULE_ID } from '../internal.js';
import { Container, ModuleVisibilityError, MultipleProvidersFoundError } from '../module-kit.js';

const TOKEN = new InjectionToken<string>('BUCKET_TOKEN');

describe('Container per-module buckets', () => {
  it('isolates registrations under their declaring module ids', () => {
    const c = new Container({ diagnostics: 'silent' });
    c.registerScope({
      moduleId: 'A',
      localProviders: new Set([TOKEN]),
      importedModules: new Set(),
      exportedTokens: new Set([TOKEN]),
      global: false,
    });
    c.registerScope({
      moduleId: 'B',
      localProviders: new Set([TOKEN]),
      importedModules: new Set(),
      exportedTokens: new Set([TOKEN]),
      global: false,
    });

    c.register(defineProvider(TOKEN, { useValue: 'from-A' }), 'A');
    c.register(defineProvider(TOKEN, { useValue: 'from-B' }), 'B');

    expect(c.resolve(TOKEN, 'A')).toBe('from-A');
    expect(c.resolve(TOKEN, 'B')).toBe('from-B');
    expect(c.hasInScope(TOKEN, 'A')).toBe(true);
    expect(c.hasInScope(TOKEN, 'B')).toBe(true);
    expect(c.hasInScope(TOKEN, 'C')).toBe(false);
  });

  it('throws MultipleProvidersFoundError when imports walk yields >1 candidate', () => {
    const c = new Container({ diagnostics: 'silent' });
    c.registerScope({
      moduleId: 'A',
      localProviders: new Set([TOKEN]),
      importedModules: new Set(),
      exportedTokens: new Set([TOKEN]),
      global: false,
    });
    c.registerScope({
      moduleId: 'B',
      localProviders: new Set([TOKEN]),
      importedModules: new Set(),
      exportedTokens: new Set([TOKEN]),
      global: false,
    });
    c.registerScope({
      moduleId: 'Consumer',
      localProviders: new Set(),
      importedModules: new Set(['A', 'B']),
      exportedTokens: new Set(),
      global: false,
    });
    c.register(defineProvider(TOKEN, { useValue: 'a' }), 'A');
    c.register(defineProvider(TOKEN, { useValue: 'b' }), 'B');

    expect(() => c.resolve(TOKEN, 'Consumer')).toThrow(MultipleProvidersFoundError);
  });

  it('honors transitive re-exports via the imports walk', () => {
    const c = new Container({ diagnostics: 'silent' });
    c.registerScope({
      moduleId: 'leaf',
      localProviders: new Set([TOKEN]),
      importedModules: new Set(),
      exportedTokens: new Set([TOKEN]),
      global: false,
    });
    c.registerScope({
      moduleId: 'mid',
      localProviders: new Set(),
      importedModules: new Set(['leaf']),
      exportedTokens: new Set([TOKEN]),
      global: false,
    });
    c.registerScope({
      moduleId: 'top',
      localProviders: new Set(),
      importedModules: new Set(['mid']),
      exportedTokens: new Set(),
      global: false,
    });
    c.register(defineProvider(TOKEN, { useValue: 'leaf-value' }), 'leaf');

    expect(c.resolve(TOKEN, 'top')).toBe('leaf-value');
  });

  it("emits ModuleVisibilityError when token exists but isn't imported", () => {
    const c = new Container({ diagnostics: 'silent' });
    c.registerScope({
      moduleId: 'private',
      localProviders: new Set([TOKEN]),
      importedModules: new Set(),
      exportedTokens: new Set(),
      global: false,
    });
    c.registerScope({
      moduleId: 'consumer',
      localProviders: new Set(),
      importedModules: new Set(),
      exportedTokens: new Set(),
      global: false,
    });
    c.register(defineProvider(TOKEN, { useValue: 'hidden' }), 'private');

    expect(() => c.resolve(TOKEN, 'consumer')).toThrow(ModuleVisibilityError);
  });

  it('global tokens are visible from any module', () => {
    const c = new Container({ diagnostics: 'silent' });
    c.registerScope({
      moduleId: 'global',
      localProviders: new Set([TOKEN]),
      importedModules: new Set(),
      exportedTokens: new Set([TOKEN]),
      global: true,
    });
    c.registerScope({
      moduleId: 'consumer',
      localProviders: new Set(),
      importedModules: new Set(),
      exportedTokens: new Set(),
      global: false,
    });
    c.register(defineProvider(TOKEN, { useValue: 'globally-visible' }), 'global');

    expect(c.resolve(TOKEN, 'consumer')).toBe('globally-visible');
  });

  it('createChild shares buckets by reference (request-scope semantics)', () => {
    const c = new Container({ diagnostics: 'silent' });
    c.register(defineProvider(TOKEN, { useValue: 'shared' }));
    const child = c.createChild();
    expect(child.resolve(TOKEN)).toBe('shared');

    // Mutating parent is visible in child.
    c.register(defineProvider(TOKEN, { useValue: 'mutated' }));
    expect(child.resolve(TOKEN)).toBe('mutated');
  });

  it('register without a moduleId lands in __root__ bucket', () => {
    const c = new Container({ diagnostics: 'silent' });
    c.register(defineProvider(TOKEN, { useValue: 'rooted' }));
    expect(c.hasInScope(TOKEN, ROOT_MODULE_ID)).toBe(true);
    expect(c.resolve(TOKEN)).toBe('rooted');
  });

  it("class deps resolve from the registration's declaring module POV", () => {
    @Injectable()
    class Dep {
      label() {
        return 'dep-from-A';
      }
    }
    @Injectable()
    class WithDep {
      constructor(public dep: Dep) {}
    }

    const c = new Container({ diagnostics: 'silent' });
    c.registerScope({
      moduleId: 'A',
      localProviders: new Set([Dep, WithDep]),
      importedModules: new Set(),
      exportedTokens: new Set([Dep, WithDep]),
      global: false,
    });
    c.register(Dep, 'A');
    c.register(WithDep, 'A');

    const instance = c.resolve(WithDep, 'A');
    expect(instance.dep.label()).toBe('dep-from-A');
  });

  it("useExisting alias delegates to its declaring module's target", () => {
    @Injectable()
    class Real {}
    const ALIAS = new InjectionToken<Real>('ALIAS');

    const c = new Container({ diagnostics: 'silent' });
    c.registerScope({
      moduleId: 'A',
      localProviders: new Set([Real, ALIAS]),
      importedModules: new Set(),
      exportedTokens: new Set([Real, ALIAS]),
      global: false,
    });
    c.register(Real, 'A');
    c.register(defineProvider(ALIAS, { useExisting: Real }), 'A');

    expect(c.resolve(ALIAS, 'A')).toBeInstanceOf(Real);
  });

  it('resolveAll across buckets returns every reachable registration', () => {
    @Injectable()
    class Item {
      constructor(public label: string) {}
    }

    const ITEM = new InjectionToken<Item>('ITEM');
    const c = new Container({ diagnostics: 'silent' });
    c.registerScope({
      moduleId: 'A',
      localProviders: new Set([ITEM]),
      importedModules: new Set(),
      exportedTokens: new Set([ITEM]),
      global: true,
    });
    c.registerScope({
      moduleId: 'B',
      localProviders: new Set([ITEM]),
      importedModules: new Set(),
      exportedTokens: new Set([ITEM]),
      global: true,
    });
    c.register(defineProvider(ITEM, { useValue: new Item('a') }), 'A');
    c.register(defineProvider(ITEM, { useValue: new Item('b') }), 'B');

    const all = c.resolveAll(ITEM);
    expect(all.map((i) => i.label).sort()).toEqual(['a', 'b']);
  });
});
