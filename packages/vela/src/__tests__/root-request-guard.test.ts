import { describe, expect, it } from 'vitest';
import {
  Injectable,
  InjectionToken,
  Module,
  Scope,
  VelaFactory,
  defineProvider,
} from '../index.js';
import {
  DiscoveryService,
  createDiscoverableDecorator,
  runInEntrypointScope,
} from '../module-kit.js';
import { Container } from '../container/container.js';

describe('request-scoped providers on the root container', () => {
  it('are refused on both resolution paths and resolve in a child', async () => {
    @Injectable({ scope: Scope.REQUEST })
    class PerRequest {}

    const container = new Container();
    container.register(PerRequest);

    expect(() => container.resolve(PerRequest)).toThrow(/request-scoped/);
    await expect(container.resolveAsync(PerRequest)).rejects.toThrow(/request-scoped/);

    const child = container.createChild();
    const instance = child.resolve(PerRequest);
    expect(instance).toBeInstanceOf(PerRequest);
    expect(await child.resolveAsync(PerRequest)).toBe(instance);
  });

  it('are refused when request scope bubbles up from a dependency', async () => {
    @Injectable({ scope: Scope.REQUEST })
    class PerRequest {}

    @Injectable()
    class Consumer {
      constructor(readonly current: PerRequest) {}
    }

    @Module({ providers: [PerRequest, Consumer] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(() => app.get(Consumer)).toThrow(/runInEntrypointScope[\s\S]*ModuleRef\.resolve/);

    const [first, second] = await Promise.all(
      [1, 2].map(() =>
        runInEntrypointScope(app.getContainer(), (scope) => scope.resolveAsync(Consumer)),
      ),
    );
    expect(first?.current).toBeInstanceOf(PerRequest);
    expect(first?.current).not.toBe(second?.current);
  });

  it('are refused through an alias to a request-scoped target', () => {
    @Injectable({ scope: Scope.REQUEST })
    class PerRequest {}
    const ALIAS = new InjectionToken<PerRequest>('RootGuardAlias');

    const container = new Container();
    container.register(PerRequest);
    container.register(defineProvider(ALIAS, { useExisting: PerRequest }));
    container.computeEffectiveScopes();

    expect(() => container.resolve(ALIAS)).toThrow(/request-scoped/);
    const child = container.createChild();
    expect(child.resolve(ALIAS)).toBe(child.resolve(PerRequest));
  });

  it('let discovery resolve them only inside an explicit execution scope', async () => {
    const Flagged = createDiscoverableDecorator<boolean>('vela-test:root-guard-flagged');

    @Flagged(true)
    @Injectable({ scope: Scope.REQUEST })
    class PerRequest {}

    @Module({ providers: [PerRequest] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, { diagnostics: 'silent' });
    const discovery = app.get(DiscoveryService);
    expect(discovery.registrationsWithMeta(Flagged)[0]?.instance).toBeUndefined();

    await runInEntrypointScope(app.getContainer(), (scope) => {
      const [hit] = discovery.registrationsWithMeta(Flagged, { requestScope: scope });
      expect(hit?.instance).toBeInstanceOf(PerRequest);
      expect(hit?.instance).toBe(scope.resolve(PerRequest));
    });
  });
});
