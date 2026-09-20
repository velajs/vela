import { describe, expect, it } from 'vitest';
import { Container } from '../container/container';
import { defineProvider, InjectionToken, ModuleVisibilityError } from '../container/types';

describe('factory provider module boundaries', () => {
  it('rejects unexported dependencies on both synchronous and asynchronous resolution', async () => {
    const secret = new InjectionToken<string>('private config');
    const consumer = new InjectionToken<string>('consumer');
    const container = new Container();
    container.registerScope({
      moduleId: 'owner',
      localProviders: new Set([secret]),
      importedModules: new Set(),
      exportedTokens: new Set(),
      isGlobal: false,
    });
    container.registerScope({
      moduleId: 'consumer',
      localProviders: new Set([consumer]),
      importedModules: new Set(['owner']),
      exportedTokens: new Set(),
      isGlobal: false,
    });
    container.register(defineProvider(secret, { useValue: 'private' }), 'owner');
    container.register(
      defineProvider(consumer, {
        inject: [secret],
        useFactory: (value) => value,
      }),
      'consumer',
    );

    expect(() => container.resolve(consumer, 'consumer')).toThrow(ModuleVisibilityError);
    await expect(container.resolveAsync(consumer, 'consumer')).rejects.toThrow(
      ModuleVisibilityError,
    );
  });

  it('propagates dependency failures without retrying against another scope', async () => {
    const dependency = new InjectionToken<string>('throwing dependency');
    const consumer = new InjectionToken<string>('consumer');
    const failure = new Error('dependency failed');
    let calls = 0;
    const container = new Container();
    container.registerScope({
      moduleId: 'app',
      localProviders: new Set([dependency, consumer]),
      importedModules: new Set(),
      exportedTokens: new Set(),
      isGlobal: false,
    });
    container.register(
      defineProvider(dependency, {
        inject: [],
        useFactory: () => {
          calls++;
          throw failure;
        },
      }),
      'app',
    );
    container.register(
      defineProvider(consumer, {
        inject: [dependency],
        useFactory: (value) => value,
      }),
      'app',
    );

    expect(() => container.resolve(consumer, 'app')).toThrow(failure);
    expect(calls).toBe(1);
    await expect(container.resolveAsync(consumer, 'app')).rejects.toBe(failure);
    expect(calls).toBe(2);
  });
});
