import { describe, expect, it } from 'vitest';
import { Container } from '../container/container';
import { Inject } from '../container/decorators';
import { InjectionToken, defineProvider } from '../container/types';
import {
  instantiate,
  instantiateMany,
  instantiateAsync,
  instantiateManyAsync,
} from '../http/instantiate';

describe('pipeline component ownership', () => {
  it('keeps synchronous class and typed-token resolution in the requested module', () => {
    const container = new Container({ diagnostics: 'silent' });
    const VALUE = new InjectionToken<string>('value');
    class Guard {
      constructor(@Inject(VALUE) readonly value: string) {}
    }
    for (const moduleId of ['a', 'b']) {
      container.registerScope({
        moduleId,
        localProviders: new Set([VALUE, Guard]),
        importedModules: new Set(),
        exportedTokens: new Set(),
        global: false,
      });
      container.register(defineProvider(VALUE, { useValue: moduleId }), moduleId);
      container.register(Guard, moduleId);
    }
    expect(instantiate(Guard, container, 'b').value).toBe('b');
    expect(instantiateMany([Guard], container, 'a')[0]?.value).toBe('a');
    expect(instantiate(VALUE, container, 'b')).toBe('b');
  });

  it('resolves async dependencies by owner and preserves construction order', async () => {
    const container = new Container({ diagnostics: 'silent' });
    const order: string[] = [];
    const VALUE = new InjectionToken<string>('value');
    class Guard {
      constructor(@Inject(VALUE) readonly value: string) {
        order.push(`guard:${value}`);
      }
    }
    class Second {
      constructor() {
        order.push('second');
      }
    }
    for (const moduleId of ['a', 'b']) {
      container.registerScope({
        moduleId,
        localProviders: new Set([VALUE, Guard]),
        importedModules: new Set(),
        exportedTokens: new Set(),
        global: false,
      });
      container.register(
        defineProvider(VALUE, {
          inject: [],
          useFactory: async () => {
            await Promise.resolve();
            order.push(`value:${moduleId}`);
            return moduleId;
          },
        }),
        moduleId,
      );
      container.register(Guard, moduleId);
    }
    expect((await instantiateAsync(Guard, container, 'b')).value).toBe('b');
    await instantiateManyAsync<unknown>([Guard, Second], container, 'a');
    expect(order).toEqual(['value:b', 'guard:b', 'value:a', 'guard:a', 'second']);
    expect(await instantiateAsync(VALUE, container, 'b')).toBe('b');
  });

  it('keeps async helper fallback honest and stops after a failing constructor', async () => {
    const container = new Container();
    let later = false;
    class Missing {
      constructor(@Inject('missing') _value: unknown) {}
    }
    class Later {
      constructor() {
        later = true;
      }
    }
    await expect(instantiateManyAsync<unknown>([Missing, Later], container)).rejects.toThrow(
      'declares constructor dependencies',
    );
    expect(later).toBe(false);
    const instance = { canActivate: () => true };
    expect(await instantiateAsync(instance, container)).toBe(instance);
  });
});
