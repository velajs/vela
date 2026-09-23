import { defineProvider } from '../container/types';
import { describe, it, expect, beforeEach } from 'vitest';
import { Container } from '../container/container.js';
import { Injectable, Inject, Optional } from '../container/decorators.js';
import { InjectionToken, forwardRef } from '../container/types.js';
import { Scope } from '../constants.js';

describe('DI Container', () => {
  let container: Container;

  beforeEach(() => {
    container = new Container();
  });

  describe('transient scope', () => {
    it('should create a new instance every time for transient providers', () => {
      @Injectable({ scope: Scope.TRANSIENT })
      class TransientService {
        id = Math.random();
      }

      container.register(TransientService);

      const a = container.resolve(TransientService);
      const b = container.resolve(TransientService);

      expect(a).not.toBe(b);
      expect(a.id).not.toBe(b.id);
    });

    it('should return the same instance for singleton (default)', () => {
      @Injectable()
      class SingletonService {
        id = Math.random();
      }

      container.register(SingletonService);

      const a = container.resolve(SingletonService);
      const b = container.resolve(SingletonService);

      expect(a).toBe(b);
      expect(a.id).toBe(b.id);
    });
  });

  describe('circular dependency detection', () => {
    it('should throw on direct circular dependency (A → B → A)', () => {
      // Use InjectionTokens + factories to create a clear circular chain
      const TOKEN_A = new InjectionToken('A');
      const TOKEN_B = new InjectionToken('B');

      container.register(
        defineProvider(TOKEN_A, {
          useFactory: (b: unknown) => ({ name: 'A', dep: b }),
          inject: [TOKEN_B],
        }),
      );

      container.register(
        defineProvider(TOKEN_B, {
          useFactory: (a: unknown) => ({ name: 'B', dep: a }),
          inject: [TOKEN_A],
        }),
      );

      expect(() => container.resolve(TOKEN_A)).toThrow(/Circular dependency detected/);
    });

    it('should throw on indirect circular dependency (A → B → C → A)', () => {
      const TOKEN_A = new InjectionToken('A');
      const TOKEN_B = new InjectionToken('B');
      const TOKEN_C = new InjectionToken('C');

      container.register(
        defineProvider(TOKEN_A, {
          useFactory: (b: unknown) => ({ name: 'A', dep: b }),
          inject: [TOKEN_B],
        }),
      );

      container.register(
        defineProvider(TOKEN_B, {
          useFactory: (c: unknown) => ({ name: 'B', dep: c }),
          inject: [TOKEN_C],
        }),
      );

      container.register(
        defineProvider(TOKEN_C, {
          useFactory: (a: unknown) => ({ name: 'C', dep: a }),
          inject: [TOKEN_A],
        }),
      );

      expect(() => container.resolve(TOKEN_A)).toThrow(/Circular dependency detected/);
    });
  });

  describe('factory providers', () => {
    it('should create instance via factory function', () => {
      const CONFIG = new InjectionToken<{ port: number }>('CONFIG');

      container.register(
        defineProvider(CONFIG, { inject: [], useFactory: () => ({ port: 3000 }) }),
      );

      const config = container.resolve(CONFIG);
      expect(config).toEqual({ port: 3000 });
    });

    it('should inject dependencies into factory', () => {
      const DB_URL = new InjectionToken<string>('DB_URL');
      const DB = new InjectionToken<{ url: string; connected: boolean }>('DB');

      container.register(defineProvider(DB_URL, { useValue: 'postgres://localhost/mydb' }));

      container.register(
        defineProvider(DB, {
          useFactory: (url: string) => ({ url, connected: true }),
          inject: [DB_URL],
        }),
      );

      const db = container.resolve(DB);
      expect(db).toEqual({ url: 'postgres://localhost/mydb', connected: true });
    });

    it('should cache singleton factory result', () => {
      let callCount = 0;
      const COUNTER = new InjectionToken<number>('COUNTER');

      container.register(defineProvider(COUNTER, { inject: [], useFactory: () => ++callCount }));

      const a = container.resolve(COUNTER);
      const b = container.resolve(COUNTER);

      expect(a).toBe(1);
      expect(b).toBe(1);
      expect(callCount).toBe(1);
    });

    it('should not cache transient factory result', () => {
      let callCount = 0;
      const COUNTER = new InjectionToken<number>('COUNTER');

      container.register(
        defineProvider(COUNTER, {
          inject: [],
          scope: Scope.TRANSIENT,
          useFactory: () => ++callCount,
        }),
      );

      const a = container.resolve(COUNTER);
      const b = container.resolve(COUNTER);

      expect(a).toBe(1);
      expect(b).toBe(2);
    });
  });

  describe('resolveAsync', () => {
    it('should resolve async factory providers', async () => {
      const ASYNC_DATA = new InjectionToken<string>('ASYNC_DATA');

      container.register(
        defineProvider(ASYNC_DATA, {
          inject: [],
          useFactory: async () => {
            // Simulate async operation
            return 'loaded';
          },
        }),
      );

      const data = await container.resolveAsync(ASYNC_DATA);
      expect(data).toBe('loaded');
    });

    it('should cache async singleton result', async () => {
      let callCount = 0;
      const ASYNC_COUNTER = new InjectionToken<number>('ASYNC_COUNTER');

      container.register(
        defineProvider(ASYNC_COUNTER, { inject: [], useFactory: async () => ++callCount }),
      );

      const a = await container.resolveAsync(ASYNC_COUNTER);
      const b = await container.resolveAsync(ASYNC_COUNTER);

      expect(a).toBe(1);
      expect(b).toBe(1);
    });
  });

  describe('useValue and useExisting', () => {
    it('should resolve useValue providers directly', () => {
      const TOKEN = new InjectionToken<string>('TOKEN');
      container.register(defineProvider(TOKEN, { useValue: 'hello' }));
      expect(container.resolve(TOKEN)).toBe('hello');
    });

    it('should resolve useExisting as alias', () => {
      @Injectable()
      class RealService {
        name = 'real';
      }

      const ALIAS = new InjectionToken<RealService>('ALIAS');

      container.register(RealService);
      container.register(defineProvider(ALIAS, { useExisting: RealService }));

      const fromAlias = container.resolve(ALIAS);
      const fromReal = container.resolve(RealService);

      expect(fromAlias).toBe(fromReal);
      expect(fromAlias.name).toBe('real');
    });
  });

  describe('InjectionToken with default factory', () => {
    it('should use default factory when no provider is registered', () => {
      const TOKEN = new InjectionToken<{ env: string }>('TOKEN', {
        factory: () => ({ env: 'development' }),
      });

      const value = container.resolve(TOKEN);
      expect(value).toEqual({ env: 'development' });
    });

    it('makes a request-scoped default a per-scope seed that consumers depend on', () => {
      const EVENT = new InjectionToken<{ id: string }>('EVENT', {
        scope: Scope.REQUEST,
        factory: () => {
          throw new Error('EVENT can only be resolved inside an invocation');
        },
      });
      let constructed = 0;
      @Injectable()
      class Consumer {
        constructor(@Inject(EVENT) readonly event: { id: string }) {
          constructed++;
        }
      }
      container.register(Consumer);
      container.computeEffectiveScopes();

      expect(container.getResolvedScope(EVENT)).toBe(Scope.REQUEST);
      expect(container.getResolvedScope(Consumer)).toBe(Scope.REQUEST);
      expect(() => container.resolve(Consumer)).toThrow(/request-scoped provider Consumer/);

      const seeded = container.createChild();
      seeded.setRequestInstance(EVENT, { id: 'a' });
      expect(seeded.resolve(Consumer).event).toEqual({ id: 'a' });
      expect(() => container.createChild().resolve(Consumer)).toThrow(
        'EVENT can only be resolved inside an invocation',
      );
      expect(constructed).toBe(1);
    });
  });

  describe('error cases', () => {
    it('should throw for unregistered token without default', () => {
      const TOKEN = new InjectionToken('MISSING');
      expect(() => container.resolve(TOKEN)).toThrow(/No provider found/);
    });

    it('should throw for sync resolve of async factory', () => {
      const TOKEN = new InjectionToken('ASYNC');
      container.register(defineProvider(TOKEN, { inject: [], useFactory: async () => 'data' }));

      expect(() => container.resolve(TOKEN)).toThrow(/returned a Promise/);
    });
  });

  describe('request scope', () => {
    it('should create separate instances per child container', () => {
      @Injectable({ scope: Scope.REQUEST })
      class RequestService {
        id = Math.random();
      }

      container.register(RequestService);

      const child1 = container.createChild();
      const child2 = container.createChild();

      const a = child1.resolve(RequestService);
      const b = child1.resolve(RequestService); // same child — same instance
      const c = child2.resolve(RequestService); // different child — different instance

      expect(a).toBe(b);
      expect(a).not.toBe(c);
    });

    it('should share singletons across child containers', () => {
      @Injectable()
      class SingletonService {
        id = Math.random();
      }

      container.register(SingletonService);

      const child1 = container.createChild();
      const child2 = container.createChild();

      const a = child1.resolve(SingletonService);
      const b = child2.resolve(SingletonService);

      expect(a).toBe(b);
    });
  });

  describe('@Optional()', () => {
    it('should inject undefined when optional dep is not registered', () => {
      @Injectable()
      class OptionalDep {}

      @Injectable()
      class ServiceA {
        constructor(@Optional() public dep?: OptionalDep) {}
      }

      container.register(ServiceA);
      const instance = container.resolve(ServiceA);
      expect(instance.dep).toBeUndefined();
    });

    it('should inject the value when optional dep is registered', () => {
      @Injectable()
      class OptionalDep {}

      @Injectable()
      class ServiceA {
        constructor(@Optional() public dep?: OptionalDep) {}
      }

      container.register(OptionalDep);
      container.register(ServiceA);
      const instance = container.resolve(ServiceA);
      expect(instance.dep).toBeInstanceOf(OptionalDep);
    });

    it('should work with @Inject() and @Optional() together', () => {
      const TOKEN = new InjectionToken<string>('OPTIONAL_TOKEN');

      @Injectable()
      class ServiceA {
        constructor(@Optional() @Inject(TOKEN) public value?: string) {}
      }

      container.register(ServiceA);
      const instance = container.resolve(ServiceA);
      expect(instance.value).toBeUndefined();
    });
  });

  describe('forwardRef()', () => {
    it('should resolve a forward-referenced provider (non-circular)', () => {
      @Injectable()
      class ServiceB {
        greet() {
          return 'hello';
        }
      }

      @Injectable()
      class ServiceA {
        constructor(@Inject(forwardRef(() => ServiceB)) public b: ServiceB) {}
      }

      container.register(ServiceB);
      container.register(ServiceA);
      const a = container.resolve(ServiceA);
      expect(a.b).toBeInstanceOf(ServiceB);
      expect(a.b.greet()).toBe('hello');
    });

    it('should break circular dependencies with forwardRef', () => {
      // InjectionToken keys avoid the TypeScript design:paramtypes TDZ issue
      // that occurs when two classes reference each other's type in the same scope.
      const TOKEN_A = new InjectionToken('SERVICE_A');
      const TOKEN_B = new InjectionToken('SERVICE_B');

      @Injectable()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      class ServiceA {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        constructor(@Inject(forwardRef(() => TOKEN_B)) public b: any) {}
        name() {
          return 'A';
        }
      }

      @Injectable()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      class ServiceB {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        constructor(@Inject(forwardRef(() => TOKEN_A)) public a: any) {}
        name() {
          return 'B';
        }
      }

      container.register(defineProvider(TOKEN_A, { useClass: ServiceA }));
      container.register(defineProvider(TOKEN_B, { useClass: ServiceB }));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const a = container.resolve<any>(TOKEN_A);
      expect(a.name()).toBe('A');
      expect(a.b.name()).toBe('B'); // b is resolved via lazy proxy

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b = container.resolve<any>(TOKEN_B);
      expect(b.name()).toBe('B');
      expect(b.a.name()).toBe('A'); // a is resolved via lazy proxy
    });
  });

  describe('explicit @Inject without emitted design:paramtypes', () => {
    // Some bundlers — notably esbuild, and therefore Wrangler — do not emit
    // `design:paramtypes` even with `emitDecoratorMetadata: true`. Applying the
    // decorators via direct calls (instead of decorator *syntax*) reproduces
    // that: TypeScript emits no metadata, so the container only sees the
    // explicit @Inject tokens. The container must still resolve the constructor.
    it('resolves explicit-token constructors when paramtypes metadata is absent', () => {
      const DEP = new InjectionToken<string>('DEP');
      container.register(defineProvider(DEP, { useValue: 'injected-value' }));

      class NoParamtypesService {
        constructor(public dep: string) {}
      }
      // No decorator syntax above => no `design:paramtypes` emitted.
      Injectable()(NoParamtypesService);
      Inject(DEP)(NoParamtypesService, undefined, 0);

      container.register(NoParamtypesService);

      const instance = container.resolve(NoParamtypesService);
      expect(instance.dep).toBe('injected-value');
    });

    it('resolves multiple explicit tokens by index without paramtypes', () => {
      const A = new InjectionToken<string>('A');
      const B = new InjectionToken<string>('B');
      container.register(defineProvider(A, { useValue: 'a-value' }));
      container.register(defineProvider(B, { useValue: 'b-value' }));

      class TwoDeps {
        constructor(
          public a: string,
          public b: string,
        ) {}
      }
      Injectable()(TwoDeps);
      Inject(A)(TwoDeps, undefined, 0);
      Inject(B)(TwoDeps, undefined, 1);

      container.register(TwoDeps);

      const instance = container.resolve(TwoDeps);
      expect(instance.a).toBe('a-value');
      expect(instance.b).toBe('b-value');
    });
  });
});
