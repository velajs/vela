import { describe, expect, it } from 'vitest';
import { Scope } from '../constants';
import { Container } from '../container/container';
import {
  defineProvider,
  InjectionToken,
  ModuleVisibilityError,
  type Token,
} from '../container/types';

function scope(container: Container, moduleId: string, tokens: Token[], imports: string[] = []) {
  container.registerScope({
    moduleId,
    localProviders: new Set(tokens),
    exportedTokens: new Set(tokens),
    importedModules: new Set(imports),
    isGlobal: false,
  });
}

describe('provider registration identity', () => {
  it.each(['sync', 'async'] as const)(
    'keeps same-token request providers separate (%s)',
    async (mode) => {
      const token = new InjectionToken<{ moduleId: string }>('shared');
      const container = new Container();
      for (const moduleId of ['A', 'B']) {
        scope(container, moduleId, [token]);
        container.register(
          defineProvider(token, {
            scope: Scope.REQUEST,
            inject: [],
            useFactory: () => ({ moduleId }),
          }),
          moduleId,
        );
      }
      const child = container.createChild();
      const resolve = (moduleId: string) =>
        mode === 'sync' ? child.resolve(token, moduleId) : child.resolveAsync(token, moduleId);
      const a = await resolve('A');
      const b = await resolve('B');
      expect([a.moduleId, b.moduleId]).toEqual(['A', 'B']);
      expect(await resolve('A')).toBe(a);
      expect(await resolve('B')).toBe(b);
      expect(child.resolveAll(token)).toEqual([a, b]);
      expect(container.createChild().resolve(token, 'A')).not.toBe(a);
    },
  );

  it('deduplicates concurrent requests per registration and retains both cached values', async () => {
    const token = new InjectionToken<{ moduleId: string }>('concurrent');
    const container = new Container();
    const calls: string[] = [];
    for (const moduleId of ['A', 'B']) {
      scope(container, moduleId, [token]);
      container.register(
        defineProvider(token, {
          scope: Scope.REQUEST,
          inject: [],
          useFactory: async () => {
            calls.push(moduleId);
            return { moduleId };
          },
        }),
        moduleId,
      );
    }
    const child = container.createChild();
    const [a, b, again] = await Promise.all([
      child.resolveAsync(token, 'A'),
      child.resolveAsync(token, 'B'),
      child.resolveAsync(token, 'A'),
    ]);
    expect(a).toBe(again);
    expect(a).not.toBe(b);
    expect(calls).toEqual(['A', 'B']);
    expect(child.resolve(token, 'A')).toBe(a);
    expect(child.resolve(token, 'B')).toBe(b);
  });

  it('does not reuse the request cache after replacing a registration', () => {
    const token = new InjectionToken<number>('replaced');
    const child = new Container().createChild();
    child.register(
      defineProvider(token, { scope: Scope.REQUEST, inject: [], useFactory: () => 1 }),
    );
    expect(child.resolve(token)).toBe(1);
    child.register(
      defineProvider(token, { scope: Scope.REQUEST, inject: [], useFactory: () => 2 }),
    );
    expect(child.resolve(token)).toBe(2);
  });

  it('preserves explicit token seeds without bypassing visibility or seeding other children', async () => {
    const token = new InjectionToken<string | undefined>('seed');
    const container = new Container();
    for (const moduleId of ['A', 'B']) {
      scope(container, moduleId, [token]);
      container.register(
        defineProvider(token, {
          scope: Scope.REQUEST,
          inject: [],
          useFactory: () => moduleId,
        }),
        moduleId,
      );
    }
    scope(container, 'private', []);
    const child = container.createChild();
    expect(child.resolve(token, 'A')).toBe('A');
    child.setRequestInstance(token, undefined);
    expect(child.resolve(token, 'A')).toBeUndefined();
    expect(await child.resolveAsync(token, 'B')).toBeUndefined();
    expect(() => child.resolve(token, 'private')).toThrow(ModuleVisibilityError);
    expect(container.createChild().resolve(token, 'A')).toBe('A');
  });

  it('distinguishes same-token registrations within one synchronous dependency chain', () => {
    const token = new InjectionToken<string>('same-name');
    const bridge = new InjectionToken<string>('bridge');
    const container = new Container();
    scope(container, 'A', [token], ['B']);
    scope(container, 'B', [token, bridge]);
    container.register(
      defineProvider(token, { inject: [bridge], useFactory: (value) => `A:${value}` }),
      'A',
    );
    container.register(
      defineProvider(bridge, { inject: [token], useFactory: (value) => value }),
      'B',
    );
    container.register(defineProvider(token, { inject: [], useFactory: () => 'B' }), 'B');
    expect(container.resolve(token, 'A')).toBe('A:B');
  });

  it('detects alias cycles on both paths and cleans up ancestry after failure', async () => {
    const a = new InjectionToken<string>('alias A');
    const b = new InjectionToken<string>('alias B');
    const container = new Container()
      .register(defineProvider(a, { useExisting: b }))
      .register(defineProvider(b, { useExisting: a }));
    expect(() => container.resolve(a)).toThrow('Circular dependency detected');
    await expect(container.resolveAsync(a)).rejects.toThrow('Circular dependency detected');
    container.register(defineProvider(b, { useValue: 'fixed' }));
    expect(container.resolve(a)).toBe('fixed');
  });

  it('observes exact owner scope, instance and lazy state without resolving', () => {
    const token = new InjectionToken<number>('owned');
    const container = new Container();
    scope(container, 'A', [token], ['B']);
    scope(container, 'B', [token]);
    scope(container, 'importer', [], ['B']);
    let calls = 0;
    container.register(defineProvider(token, { inject: [], useFactory: () => ++calls }), 'A');
    container.register(
      defineProvider(token, {
        scope: Scope.REQUEST,
        inject: [],
        useFactory: () => ++calls,
      }),
      'B',
    );
    container.setLazyHook({
      isPending: (moduleId) => moduleId === 'B',
      claim: () => {},
      hasClaimed: () => false,
      isDraining: () => false,
      drainSync: () => {},
      drainAsync: async () => {},
    });
    expect(container.getProviderScope(token)).toBe(Scope.SINGLETON);
    expect(container.getProviderScope(token, 'B')).toBe(Scope.REQUEST);
    expect(container.getProviderScope(token, 'importer')).toBeUndefined();
    expect(container.isLazyPending(token)).toBe(false);
    expect(container.isLazyPending(token, 'B')).toBe(true);
    expect(container.isLazyPending(token, 'importer')).toBe(false);
    expect(container.isInstantiated(token, 'A')).toBe(false);
    expect(calls).toBe(0);
    container.resolve(token, 'A');
    expect(container.isInstantiated(token)).toBe(true);
    expect(container.isInstantiated(token, 'A')).toBe(true);
    expect(container.isInstantiated(token, 'B')).toBe(false);
    expect(container.isInstantiated(token, 'importer')).toBe(false);
  });

  it('returns frozen visible wiring snapshots without constructing providers or claiming lazy modules', () => {
    const token = new InjectionToken<{ count: number }>('audit candidate');
    const alias = new InjectionToken<{ count: number }>('audit alias');
    const hidden = new InjectionToken<object>('private');
    const root = new Container();
    scope(root, 'A', [token, alias, hidden]);
    scope(root, 'B', [token]);
    scope(root, 'consumer', [], ['A', 'B']);
    root.registerScope({
      moduleId: 'A',
      localProviders: new Set([token, alias, hidden]),
      exportedTokens: new Set([token, alias]),
      importedModules: new Set(),
      isGlobal: false,
    });
    const value = { count: 1 };
    root.register(defineProvider(token, { useValue: value }), 'A');
    root.register(defineProvider(alias, { useExisting: token }), 'A');
    root.register(defineProvider(hidden, { useValue: {} }), 'A');
    let calls = 0;
    let claims = 0;
    root.register(
      defineProvider(token, {
        scope: Scope.REQUEST,
        inject: [],
        useFactory: () => ({ count: ++calls }),
      }),
      'B',
    );
    root.setLazyHook({
      isPending: () => true,
      claim: () => {
        claims++;
      },
      hasClaimed: () => false,
      isDraining: () => false,
      drainSync: () => {},
      drainAsync: async () => {},
    });
    const child = root.createChild();
    const snapshots = child.getVisibleProviderSnapshots(token, 'consumer');
    expect(
      snapshots.map(({ moduleId, scope: lifetime, kind }) => ({ moduleId, scope: lifetime, kind })),
    ).toEqual([
      { moduleId: 'A', scope: Scope.SINGLETON, kind: 'value' },
      { moduleId: 'B', scope: Scope.REQUEST, kind: 'factory' },
    ]);
    expect(snapshots[0]?.instance?.value).toBe(value);
    expect(snapshots[1]?.instance).toBeUndefined();
    expect(child.getVisibleProviderSnapshots(hidden, 'consumer')).toEqual([]);
    expect(child.getVisibleProviderSnapshots(alias, 'consumer')[0]?.useExisting).toBe(token);
    expect(Object.isFrozen(snapshots)).toBe(true);
    expect(Object.isFrozen(snapshots[0])).toBe(true);
    expect(Object.isFrozen(snapshots[0]?.instance)).toBe(true);
    expect(Object.isFrozen(value)).toBe(false);
    expect(snapshots[1]).not.toHaveProperty('useFactory');
    expect(snapshots[1]).not.toHaveProperty('inject');
    expect([calls, claims]).toEqual([0, 0]);
    const instance = child.resolve(token, 'B');
    expect(child.getVisibleProviderSnapshots(token, 'B')[0]?.instance?.value).toBe(instance);
    expect(snapshots[1]?.instance).toBeUndefined();
    expect(root.getVisibleProviderSnapshots(token, 'B')[0]?.instance).toBeUndefined();
  });
});
