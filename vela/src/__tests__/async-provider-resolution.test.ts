import { describe, expect, it } from 'vitest';
import {
  Container,
  defineProvider,
  Inject,
  Injectable,
  InjectionToken,
  Module,
  Scope,
  VelaFactory,
} from '../index';

describe('asynchronous provider construction', () => {
  it('awaits constructor dependencies regardless of provider declaration order', async () => {
    const nativeResult = new InjectionToken<string>('native result');
    let calls = 0;
    const lifecycle: string[] = [];
    @Injectable()
    class Lifecycle {
      constructor(@Inject(nativeResult) readonly value: string) {
        lifecycle.push(`construct:${value}`);
      }
      onModuleInit() {
        lifecycle.push(`init:${this.value}`);
      }
    }
    @Module({
      providers: [
        Lifecycle,
        defineProvider(nativeResult, {
          inject: [],
          useFactory: async () => {
            calls++;
            await Promise.resolve();
            return 'ready';
          },
        }),
      ],
    })
    class App {}

    const app = await VelaFactory.create(App);
    expect(app.get(Lifecycle).value).toBe('ready');
    expect(lifecycle).toEqual(['construct:ready', 'init:ready']);
    expect(calls).toBe(1);
  });

  it('shares in-flight singleton work and caches an undefined result', async () => {
    const token = new InjectionToken<undefined>('once');
    let calls = 0;
    const container = new Container();
    container.register(
      defineProvider(token, {
        inject: [],
        useFactory: async () => {
          calls++;
          await Promise.resolve();
        },
      }),
    );
    await Promise.all([
      container.resolveAsync(token),
      container.resolveAsync(token),
      container.createChild().resolveAsync(token),
    ]);
    await container.resolveAsync(token);
    expect(container.resolve(token)).toBeUndefined();
    expect(calls).toBe(1);
  });

  it('deduplicates per request without sharing request instances across children', async () => {
    const token = new InjectionToken<{ id: number }>('request native value');
    let calls = 0;
    const container = new Container();
    container.register(
      defineProvider(token, {
        inject: [],
        scope: Scope.REQUEST,
        useFactory: async () => ({ id: ++calls }),
      }),
    );
    const first = container.createChild();
    const second = container.createChild();
    const [a, b, c] = await Promise.all([
      first.resolveAsync(token),
      first.resolveAsync(token),
      second.resolveAsync(token),
    ]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(first.resolve(token)).toBe(a);
    expect(calls).toBe(2);
  });

  it('aborts bootstrap on the original dependency error without retrying side effects', async () => {
    const token = new InjectionToken<string>('failing native value');
    const failure = new Error('native write failed');
    let calls = 0;
    @Injectable()
    class Lifecycle {
      constructor(@Inject(token) readonly value: string) {}
    }
    @Module({
      providers: [
        Lifecycle,
        defineProvider(token, {
          inject: [],
          useFactory: async () => {
            calls++;
            throw failure;
          },
        }),
      ],
    })
    class App {}
    await expect(VelaFactory.create(App, { diagnostics: 'silent' })).rejects.toBe(failure);
    expect(calls).toBe(1);
  });

  it('removes failed in-flight work so an explicit later attempt can retry', async () => {
    const token = new InjectionToken<number>('retryable');
    const failure = new Error('first attempt');
    const container = new Container();
    let calls = 0;
    container.register(
      defineProvider(token, {
        inject: [],
        useFactory: async () => {
          if (++calls === 1) throw failure;
          return calls;
        },
      }),
    );
    const results = await Promise.allSettled([
      container.resolveAsync(token),
      container.resolveAsync(token),
    ]);
    expect(results).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ]);
    expect(await container.resolveAsync(token)).toBe(2);
  });

  it('rejects dependency cycles instead of awaiting an in-flight promise forever', async () => {
    const first = new InjectionToken<string>('first');
    const second = new InjectionToken<string>('second');
    const container = new Container();
    container.register(
      defineProvider(first, { inject: [second], useFactory: async (value) => value }),
    );
    container.register(
      defineProvider(second, { inject: [first], useFactory: async (value) => value }),
    );
    await expect(container.resolveAsync(first)).rejects.toThrow('Circular dependency detected');
  });
});
