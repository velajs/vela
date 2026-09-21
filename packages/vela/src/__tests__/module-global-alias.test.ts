import { beforeEach, describe, expect, it } from 'vitest';
import {
  APP_GUARD,
  Controller,
  defineProvider,
  Get,
  getRequestContainer,
  Inject,
  Injectable,
  InjectionToken,
  MetadataRegistry,
  Module,
  Scope,
  VelaFactory,
  type ExecutionContext,
} from '../index';
import { bootstrap } from '../factory/bootstrap';

beforeEach(() => MetadataRegistry.clear());

describe('module global aliases', () => {
  it('exposes request alias metadata without construction and reuses its target in each child', async () => {
    let constructed = 0;
    @Injectable({ scope: Scope.REQUEST })
    class Guard {
      readonly id = ++constructed;
      canActivate() {
        return true;
      }
    }
    const GUARD = new InjectionToken<Guard>('private guard alias');
    @Module({
      providers: [
        Guard,
        defineProvider(GUARD, { useExisting: Guard }),
        defineProvider(APP_GUARD, { useExisting: GUARD }),
        defineProvider(APP_GUARD, { useExisting: Guard }),
      ],
    })
    class Feature {}
    @Module({ imports: [Feature] })
    class Root {}
    const { container, loader } = await bootstrap(Root);
    const [alias, classAlias] = loader.getAppProviderTokens(APP_GUARD);
    expect(alias).toBeDefined();
    expect(container.getVisibleProviderSnapshots(alias!)).toEqual([
      expect.objectContaining({
        kind: 'existing',
        useExisting: GUARD,
        moduleId: 'Feature#default',
        scope: Scope.REQUEST,
      }),
    ]);
    expect(constructed).toBe(0);
    const first = container.createChild();
    const second = container.createChild();
    const instance = await first.resolveAsync(alias!);
    expect(instance).toBe(first.resolve(Guard, 'Feature#default'));
    expect(instance).toBe(await first.resolveAsync(classAlias!));
    expect(instance).toBe(await first.resolveAsync(alias!));
    expect(await second.resolveAsync(alias!)).not.toBe(instance);
    expect(constructed).toBe(2);
    await Promise.all([first.dispose(), second.dispose()]);
    await container.dispose();
  });

  it('dispatches private keyed guard aliases with asynchronous request dependencies', async () => {
    const OWNER = new InjectionToken<string>('guard owner');
    const DEPENDENCY = new InjectionToken<{ owner: string; id: number }>('request dependency');
    let constructed = 0;
    let dependencies = 0;
    const calls: Array<{ request: string | undefined; owner: string; id: number }> = [];
    @Injectable()
    class Guard {
      constructor(@Inject(DEPENDENCY) readonly dependency: { owner: string; id: number }) {
        constructed++;
      }
      canActivate(context: ExecutionContext) {
        const request = context.getContext();
        expect(
          getRequestContainer(request).resolve(Guard, `Feature#${this.dependency.owner}`),
        ).toBe(this);
        calls.push({ request: request.req.query('request'), ...this.dependency });
        return true;
      }
    }
    class Feature {}
    @Controller('/alias')
    class Routes {
      @Get() get() {
        return { ok: true };
      }
    }
    @Module({
      imports: ['one', 'two'].map((key) => ({
        module: Feature,
        key,
        providers: [
          defineProvider(OWNER, { useValue: key }),
          defineProvider(DEPENDENCY, {
            scope: Scope.REQUEST,
            inject: [OWNER],
            useFactory: async (owner) => {
              await Promise.resolve();
              return { owner, id: ++dependencies };
            },
          }),
          Guard,
          defineProvider(APP_GUARD, { useExisting: Guard }),
        ],
      })),
      controllers: [Routes],
    })
    class Root {}
    const app = await VelaFactory.create(Root);
    try {
      expect(constructed).toBe(0);
      const responses = await Promise.all(
        ['first', 'second'].map((request) => app.getHonoApp().request(`/alias?request=${request}`)),
      );
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      await Promise.all(responses.map((response) => response.text()));
      for (const request of ['first', 'second']) {
        expect(calls.filter((call) => call.request === request).map((call) => call.owner)).toEqual([
          'one',
          'two',
        ]);
      }
      expect(new Set(calls.map((call) => call.id)).size).toBe(4);
      expect(constructed).toBe(4);
    } finally {
      await app.close();
    }
  });

  it.each([Scope.SINGLETON, Scope.TRANSIENT])(
    'retains the target lifetime and disposal for a %s global guard',
    async (scope) => {
      let constructed = 0;
      const calls: number[] = [];
      const disposed: number[] = [];
      @Injectable({ scope })
      class Guard {
        readonly id = ++constructed;
        canActivate() {
          calls.push(this.id);
          return true;
        }
        dispose() {
          disposed.push(this.id);
        }
      }
      @Module({ providers: [Guard, defineProvider(APP_GUARD, { useExisting: Guard })] })
      class Feature {}
      @Controller('/lifetime')
      class Routes {
        @Get() get() {
          return new Response(null, { status: 204 });
        }
      }
      @Module({ imports: [Feature], controllers: [Routes] })
      class Root {}
      const app = await VelaFactory.create(Root);
      try {
        const responses = await Promise.all([
          app.getHonoApp().request('/lifetime'),
          app.getHonoApp().request('/lifetime'),
        ]);
        expect(responses.map((response) => response.status)).toEqual([204, 204]);
        expect(calls).toHaveLength(2);
        if (scope === Scope.SINGLETON) {
          expect(calls).toEqual([
            app.getContainer().resolve(Guard, 'Feature#default').id,
            app.getContainer().resolve(Guard, 'Feature#default').id,
          ]);
          expect(constructed).toBe(1);
          expect(disposed).toEqual([]);
        } else {
          expect(new Set(calls).size).toBe(2);
          expect(disposed.toSorted()).toEqual(calls.toSorted());
        }
      } finally {
        await app.close();
        await app.getContainer().dispose();
      }
      expect(disposed).toHaveLength(constructed);
      expect(new Set(disposed).size).toBe(constructed);
    },
  );
});
