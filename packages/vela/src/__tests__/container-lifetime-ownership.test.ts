import { describe, expect, it } from 'vitest';
import { Scope } from '../constants';
import { Container } from '../container/container';
import { Inject, Injectable } from '../container/decorators';
import { defineProvider, forwardRef, InjectionToken } from '../container/types';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

describe('container construction ownership', () => {
  it.each(['sync', 'async'] as const)(
    'owns transients by their retaining graph (%s)',
    async (mode) => {
      const root = new Container();
      const events: string[] = [];
      const transient = new InjectionToken<{ id: number; dispose(): void }>('transient');
      let id = 0;
      root.register(
        defineProvider(transient, {
          scope: Scope.TRANSIENT,
          inject: [],
          useFactory: () => {
            const ownId = ++id;
            return {
              id: ownId,
              dispose: () => {
                events.push(`transient:${ownId}`);
              },
            };
          },
        }),
      );
      const singleton = new InjectionToken<{ dep: { id: number }; dispose(): void }>('singleton');
      root.register(
        defineProvider(singleton, {
          inject: [transient],
          useFactory: (dep) => ({
            dep,
            dispose: () => {
              events.push('singleton');
            },
          }),
        }),
      );
      const child = root.createChild();
      const retained =
        mode === 'sync' ? child.resolve(singleton) : await child.resolveAsync(singleton);
      const local =
        mode === 'sync' ? child.resolve(transient) : await child.resolveAsync(transient);
      expect(retained.dep.id).not.toBe(local.id);
      await child.dispose();
      expect(events).toEqual([`transient:${local.id}`]);
      expect(root.resolve(singleton)).toBe(retained);
      await root.dispose();
      expect(events).toEqual([
        `transient:${local.id}`,
        'singleton',
        `transient:${retained.dep.id}`,
      ]);
    },
  );

  it.each([Scope.REQUEST, Scope.TRANSIENT])(
    'waits for pending %s construction and coalesces disposal',
    async (scope) => {
      const barrier = gate();
      const started = gate();
      const token = new InjectionToken<{ dispose(): void }>('pending');
      const child = new Container()
        .register(
          defineProvider(token, {
            scope,
            inject: [],
            useFactory: async () => {
              started.release();
              await barrier.promise;
              return {
                dispose: () => {
                  disposed++;
                },
              };
            },
          }),
        )
        .createChild();
      let disposed = 0;
      const pending = child.resolveAsync(token);
      await started.promise;
      expect(child.hasDisposables()).toBe(true);
      let finished = false;
      const closing = child.dispose().then(() => {
        finished = true;
        return undefined;
      });
      const alsoClosing = child.dispose();
      await Promise.resolve();
      expect(finished).toBe(false);
      barrier.release();
      await Promise.all([pending, closing, alsoClosing]);
      expect(disposed).toBe(1);
      expect(child.hasDisposables()).toBe(false);
      await child.dispose();
      expect(disposed).toBe(1);
    },
  );

  it('drains successful sibling dependencies after an asynchronous construction failure', async () => {
    const barrier = gate();
    const failure = new Error('dependency failed');
    const failing = new InjectionToken<string>('failing');
    const late = new InjectionToken<{ dispose(): void }>('late');
    const parent = new InjectionToken<unknown>('parent');
    let disposed = 0;
    const child = new Container()
      .register(
        defineProvider(failing, {
          inject: [],
          useFactory: async () => {
            throw failure;
          },
        }),
      )
      .register(
        defineProvider(late, {
          scope: Scope.TRANSIENT,
          inject: [],
          useFactory: async () => {
            await barrier.promise;
            return {
              dispose: () => {
                disposed++;
              },
            };
          },
        }),
      )
      .register(
        defineProvider(parent, {
          scope: Scope.REQUEST,
          inject: [failing, late],
          useFactory: () => ({}),
        }),
      )
      .createChild();
    await expect(child.resolveAsync(parent)).rejects.toBe(failure);
    const closing = child.dispose();
    barrier.release();
    await closing;
    expect(disposed).toBe(1);
  });

  it('rejects new resolution during and after teardown', async () => {
    const barrier = gate();
    const token = new InjectionToken<{ dispose(): Promise<void> }>('disposed');
    const root = new Container().register(
      defineProvider(token, {
        inject: [],
        useFactory: () => ({ dispose: () => barrier.promise }),
      }),
    );
    root.resolve(token);
    const closing = root.dispose();
    expect(() => root.resolve(token)).toThrow(/dispos/i);
    expect(() => root.createChild().resolve(token)).toThrow(/dispos/i);
    await expect(root.resolveAsync(token)).rejects.toThrow(/dispos/i);
    barrier.release();
    await closing;
    expect(() => root.resolve(token)).toThrow(/disposed/);
    expect(() => root.createChild()).toThrow(/disposed/);
    await expect(root.resolveAsync(token)).rejects.toThrow(/disposed/);
    await root.dispose();
  });

  it('leaves values and seeds caller-owned and disposes a factory-returned dependency only once', async () => {
    const events: string[] = [];
    const value = new InjectionToken<{ dispose(): void }>('external');
    const seed = new InjectionToken<{ dispose(): void }>('seed');
    const produced = new InjectionToken<{ dispose(): void }>('produced');
    const passthrough = new InjectionToken<{ dispose(): void }>('passthrough');
    const child = new Container()
      .register(
        defineProvider(value, {
          useValue: {
            dispose: () => {
              events.push('value');
            },
          },
        }),
      )
      .register(
        defineProvider(seed, {
          scope: Scope.REQUEST,
          inject: [],
          useFactory: () => {
            throw new Error('seed missing');
          },
        }),
      )
      .register(
        defineProvider(produced, {
          scope: Scope.REQUEST,
          inject: [],
          useFactory: () => ({
            dispose: () => {
              events.push('produced');
            },
          }),
        }),
      )
      .register(
        defineProvider(passthrough, {
          scope: Scope.REQUEST,
          inject: [produced],
          useFactory: (dep) => dep,
        }),
      )
      .createChild();
    child.setRequestInstance(seed, {
      dispose: () => {
        events.push('seed');
      },
    });
    child.resolve(value);
    child.resolve(seed);
    child.resolve(passthrough);
    await child.dispose();
    expect(events).toEqual(['produced']);
  });

  it('does not transfer singleton or caller-owned disposal to a request factory returning it', async () => {
    const events: string[] = [];
    const singleton = new InjectionToken<{ dispose(): void }>('root owned');
    const external = new InjectionToken<{ dispose(): void }>('caller owned');
    const rootAlias = new InjectionToken<{ dispose(): void }>('root passthrough');
    const valueAlias = new InjectionToken<{ dispose(): void }>('value passthrough');
    const root = new Container()
      .register(
        defineProvider(singleton, {
          inject: [],
          useFactory: () => ({
            dispose: () => {
              events.push('root');
            },
          }),
        }),
      )
      .register(
        defineProvider(external, {
          useValue: {
            dispose: () => {
              events.push('external');
            },
          },
        }),
      )
      .register(
        defineProvider(rootAlias, {
          scope: Scope.REQUEST,
          inject: [singleton],
          useFactory: (value) => value,
        }),
      )
      .register(
        defineProvider(valueAlias, {
          scope: Scope.REQUEST,
          inject: [external],
          useFactory: (value) => value,
        }),
      );
    const child = root.createChild();
    child.resolve(rootAlias);
    await child.resolveAsync(valueAlias);
    await child.dispose();
    expect(events).toEqual([]);
    await root.dispose();
    expect(events).toEqual(['root']);
  });

  it('retains a singleton graph in flight when its initiating request is disposed', async () => {
    const barrier = gate();
    const started = gate();
    const transient = new InjectionToken<{ dispose(): void }>('late singleton dependency');
    const singleton = new InjectionToken<object>('singleton');
    let disposed = 0;
    const root = new Container()
      .register(
        defineProvider(transient, {
          scope: Scope.TRANSIENT,
          inject: [],
          useFactory: async () => {
            started.release();
            await barrier.promise;
            return {
              dispose: () => {
                disposed++;
              },
            };
          },
        }),
      )
      .register(defineProvider(singleton, { inject: [transient], useFactory: (dep) => ({ dep }) }));
    const child = root.createChild();
    const pending = child.resolveAsync(singleton);
    await started.promise;
    await child.dispose();
    expect(root.hasDisposables()).toBe(true);
    expect(disposed).toBe(0);
    const closing = root.dispose();
    barrier.release();
    await Promise.all([pending, closing]);
    expect(disposed).toBe(1);
  });

  it.each(['sync', 'async'] as const)(
    'preserves private methods/getters through circular proxies (%s)',
    async (mode) => {
      const aToken = new InjectionToken<A>('A');
      const bToken = new InjectionToken<B>('B');
      @Injectable()
      class A {
        #value = 7;
        constructor(@Inject(forwardRef(() => bToken)) readonly b: Pick<B, 'a'>) {}
        read() {
          return this.#value;
        }
        get value() {
          return this.#value;
        }
      }
      @Injectable()
      class B {
        constructor(@Inject(forwardRef(() => aToken)) readonly a: Pick<A, 'read' | 'value'>) {}
      }
      const container = new Container()
        .register(defineProvider(aToken, { useClass: A }))
        .register(defineProvider(bToken, { useClass: B }));
      const a = mode === 'sync' ? container.resolve(aToken) : await container.resolveAsync(aToken);
      expect(a.b.a.read()).toBe(7);
      expect(a.b.a.value).toBe(7);
    },
  );
});
