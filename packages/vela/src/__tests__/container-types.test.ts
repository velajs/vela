import { describe, expect, expectTypeOf, it } from 'vitest';
import { Container } from '../container/container';
import { ModuleRef } from '../container/module-ref';
import {
  defineProvider,
  InjectionToken,
  forwardRef,
  type Token,
  type TypedToken,
} from '../container/types';
import { defineModule } from '../module/define-module';
import { lazyProvider } from '../module/lazy-provider';
import type { AsyncModuleOptions } from '../registry/types';
import { VelaApplication } from '../application';
import { Module } from '../module/decorators';
import { Injectable } from '../container/decorators';
import { VelaFactory } from '../factory';
import type { DynamicModule } from '../module/types';

const count = new InjectionToken<number>('count');
const label = new InjectionToken<string>('label');

// Compile-only negative cases. This function is deliberately not invoked.
function invalidWiring(container: Container, moduleRef: ModuleRef, app: VelaApplication): void {
  // @ts-expect-error The token determines the resolved type, not a caller-supplied result type.
  container.resolve<number>('count');
  // @ts-expect-error Raw runtime keys have no declared value type.
  const numberFromString: number = container.resolve('count');
  // @ts-expect-error Raw symbols have no declared value type.
  const numberFromSymbol: number = container.resolve(Symbol('count'));
  // @ts-expect-error ModuleRef follows the token, too.
  moduleRef.get<number>('count');
  // @ts-expect-error ModuleRef.resolve follows the token as well.
  moduleRef.resolve<number>('count');
  // @ts-expect-error ModuleRef.create yields the class it constructs, asynchronously.
  const created: Promise<number> = moduleRef.create(class Created {});
  // @ts-expect-error A request scope is identified by a context or container, not a module id.
  void moduleRef.resolve(count, 'owner');
  void created;
  // @ts-expect-error Application.get follows the token, too.
  app.get<number>('count');
  // @ts-expect-error A request cache value must satisfy the token.
  container.setRequestInstance(count, 'wrong');
  // @ts-expect-error The provided token fixes the value type.
  container.register({ provide: count, useValue: 'wrong' });
  // @ts-expect-error The provided token fixes the factory result type.
  container.register({ provide: count, useFactory: () => 'wrong' });
  // @ts-expect-error The provided token fixes the value type before module erasure.
  defineProvider(count, { useValue: 'wrong' });
  // @ts-expect-error An explicit result generic cannot override token inference.
  defineProvider<unknown>(count, { useValue: 'wrong' });
  // @ts-expect-error Explicitly widening the typed token cannot erase its invariant value type.
  defineProvider<InjectionToken<unknown>>(count, { useValue: 'wrong' });
  // @ts-expect-error An erased registry token is not permission to author a typed provider.
  defineProvider<Token>(count, { useValue: 'wrong' });
  // @ts-expect-error The same constraint applies to the union of typed tokens.
  defineProvider<TypedToken<unknown>>(count, { useValue: 'wrong' });
  const erased: Token = count;
  // @ts-expect-error Erased identities can be read as unknown, but cannot be rebound.
  defineProvider(erased, { useValue: 'wrong' });
  // @ts-expect-error A request cache write cannot widen the token either.
  container.setRequestInstance<Token>(count, 'wrong');
  // @ts-expect-error Invariant typed tokens cannot be widened by assignment.
  const widened: InjectionToken<unknown> = count;
  void widened;
  // @ts-expect-error The provided token fixes the factory output type.
  defineProvider(count, { inject: [label], useFactory: (value) => value });
  // @ts-expect-error Dependency parameters come from their token tuple.
  defineProvider(label, { inject: [count], useFactory: (value: string) => value });
  // @ts-expect-error The class must construct the provided token's type.
  defineProvider(count, { useClass: class Wrong {} });
  // @ts-expect-error Aliases must preserve the token value type.
  defineProvider(count, { useExisting: label });
  // @ts-expect-error Raw alias keys cannot promise a typed value.
  defineProvider(count, { useExisting: 'untyped' });
  // @ts-expect-error Select exactly one provider strategy.
  defineProvider(count, { useValue: 1, useFactory: () => 1 });
  // @ts-expect-error A factory without dependency tokens receives no dependencies.
  defineProvider(count, { useFactory: (value: number) => value });
  // @ts-expect-error An explicit dependency tuple still needs its runtime inject tokens.
  defineProvider<typeof count, readonly [typeof label]>(count, {
    useFactory: (value) => value.length,
  });
  const thunk = new InjectionToken<() => number>('thunk');
  // @ts-expect-error Lazy factories also require their runtime dependency tuple.
  lazyProvider<number, readonly [typeof label]>({
    provide: thunk,
    useFactory: (value) => value.length,
  });
  // @ts-expect-error Async options cannot fabricate dependencies with an explicit generic.
  const asyncOptions: AsyncModuleOptions<number, readonly [typeof label]> = {
    useFactory: (value) => value.length,
  };
  const { ConfigurableModuleClass } = defineModule<{ value: number }>({ name: 'Typed' });
  // @ts-expect-error Generated module factories require runtime dependency tokens too.
  ConfigurableModuleClass.forRootAsync<readonly [typeof label]>({
    useFactory: (value: string) => ({ value: value.length }),
  });
  defineModule<{ value: number }>({
    name: 'GlobalSlot',
    // @ts-expect-error A global guard registration must implement CanActivate.
    setup: () => ({ global: { guards: [{ transform: (value: unknown) => value }] } }),
  });
  void asyncOptions;
  // @ts-expect-error Module provider arrays accept checked definitions, not erased plain objects.
  Module({ providers: [{ provide: count, useValue: 'wrong' }] });
  // Nothing ties a DynamicModule literal to its token: the loader checks its shape at load.
  const dynamic: DynamicModule = {
    module: class {},
    providers: [{ provide: count, useValue: 'unchecked' }],
  };
  const checked = defineProvider(count, { useValue: 1 });
  const snapshots = container.getVisibleProviderSnapshots(count, 'owner');
  const snapshot = snapshots[0]!;
  // @ts-expect-error Snapshot identity and wiring are immutable.
  snapshot.token = label;
  // @ts-expect-error Runtime snapshots do not claim a token-correlated domain type.
  const uncheckedNumber: number = snapshot.instance?.value;
  // @ts-expect-error Runtime provider factories are not exposed by diagnostic snapshots.
  snapshot.useFactory;
  void uncheckedNumber;
  // @ts-expect-error A spread loses the private state that proves provider validation.
  Module({ providers: [{ ...checked, useValue: 'wrong' }] });
  // @ts-expect-error Definitions cannot be retargeted to a different token.
  checked.provide = label;
  void dynamic;
  void [numberFromString, numberFromSymbol];
}
void invalidWiring;

describe('typed provider definitions', () => {
  it('infers class/token resolution and keeps raw keys unknown', () => {
    class Service {
      readonly name = 'service';
    }
    const container = new Container();
    container.register(defineProvider(Service, { useClass: Service }));
    container.register(defineProvider(count, { useValue: 2 }));
    container.register(
      defineProvider(label, {
        inject: [Service, count],
        useFactory: (service, value) => {
          expectTypeOf(service).toEqualTypeOf<Service>();
          expectTypeOf(value).toEqualTypeOf<number>();
          return `${service.name}:${value}`;
        },
      }),
    );
    expectTypeOf(container.resolve(count)).toEqualTypeOf<number>();
    expectTypeOf(container.resolve(Service)).toEqualTypeOf<Service>();
    expectTypeOf(container.resolveAsync(count)).toEqualTypeOf<Promise<number>>();
    expectTypeOf(container.resolve(count, 'owner')).toEqualTypeOf<number>();
    expectTypeOf(container.resolveAsync(count, 'owner')).toEqualTypeOf<Promise<number>>();
    expectTypeOf(container.isLazyPending(count, 'owner')).toEqualTypeOf<boolean>();
    expectTypeOf(container.isInstantiated(count, 'owner')).toEqualTypeOf<boolean>();
    expectTypeOf(container.resolveAll(count)).toEqualTypeOf<number[]>();
    expectTypeOf<ReturnType<typeof container.resolve<'runtime'>>>().toEqualTypeOf<unknown>();
    expect(container.resolve(label)).toBe('service:2');
  });

  it('infers ModuleRef lookups from the token', async () => {
    @Injectable()
    class Service {
      readonly name = 'service';
    }

    @Module({ providers: [Service, defineProvider(count, { useValue: 2 })] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const moduleRef = app.get(ModuleRef);
    expectTypeOf(moduleRef).toEqualTypeOf<ModuleRef>();
    expectTypeOf(moduleRef.get(count)).toEqualTypeOf<number>();
    expectTypeOf(moduleRef.get(count, { strict: false })).toEqualTypeOf<number>();
    expectTypeOf(moduleRef.resolve(count)).toEqualTypeOf<Promise<number>>();
    expectTypeOf(moduleRef.create(Service)).toEqualTypeOf<Promise<Service>>();
    expect(moduleRef.get(count)).toBe(2);
    expect(await moduleRef.resolve(Service)).toBe(app.get(Service));
    expect(await moduleRef.create(Service)).not.toBe(app.get(Service));
  });

  it('supports values, aliases and factories when a token legitimately includes undefined', () => {
    const optional = new InjectionToken<string | undefined>('optional');
    const alias = new InjectionToken<string | undefined>('optional-alias');
    const container = new Container();
    container.register(defineProvider(optional, { useValue: undefined }));
    container.register(defineProvider(alias, { useExisting: optional }));
    expect(container.resolve(optional)).toBeUndefined();
    expect(container.resolve(alias)).toBeUndefined();
  });

  it('keeps dependency tuples and token defaults immutable after authoring', () => {
    const defaults = { factory: () => 3 };
    const defaulted = new InjectionToken<number>('defaulted', defaults);
    const dependencies: [typeof defaulted] = [defaulted];
    const provider = defineProvider(count, {
      inject: dependencies,
      useFactory: (value) => value * 2,
    });
    defaults.factory = () => 99;
    dependencies[0] = new InjectionToken<number>('missing');
    const container = new Container().register(provider);
    expect(container.resolve(count)).toBe(6);
    expect(Object.isFrozen(provider)).toBe(true);
    expect(Object.isFrozen(defaulted)).toBe(true);
    expect(Object.isFrozen(provider.inject)).toBe(true);
  });

  it('infers forwarded dependency tokens through the actual token returned', () => {
    const container = new Container().register(defineProvider(count, { useValue: 2 }));
    container.register(
      defineProvider(label, {
        inject: [forwardRef(() => count)],
        useFactory: (value) => {
          expectTypeOf(value).toEqualTypeOf<number>();
          return `count:${value}`;
        },
      }),
    );
    expect(container.resolve(label)).toBe('count:2');
  });
});
