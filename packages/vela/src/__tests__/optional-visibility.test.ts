import { describe, expect, it, vi } from 'vitest';
import {
  Inject,
  Injectable,
  InjectionToken,
  ModuleVisibilityError,
  Optional,
  Scope,
  defineProvider,
  type Token,
} from '../index.js';
import { Container } from '../container/container.js';

describe('@Optional() dependencies follow module visibility', () => {
  const HIDDEN = new InjectionToken<string>('OptionalVisibilityHidden');
  const DEFAULTED = new InjectionToken<string>('OptionalVisibilityDefault', {
    factory: () => 'fallback',
  });

  function wire(diagnostics: 'throw' | 'log' | 'silent') {
    @Injectable({ scope: Scope.TRANSIENT })
    class Consumer {
      constructor(
        @Optional() @Inject(HIDDEN) readonly hidden: string | undefined,
        @Optional() @Inject(DEFAULTED) readonly defaulted: string | undefined,
      ) {}
    }

    const container = new Container({ diagnostics });
    container.register(defineProvider(HIDDEN, { useValue: 'hidden' }), 'owner');
    container.register(Consumer, 'consumer');
    for (const moduleId of ['owner', 'consumer']) {
      container.registerScope({
        moduleId,
        localProviders: new Set<Token>(moduleId === 'owner' ? [HIDDEN] : [Consumer]),
        importedModules: new Set(moduleId === 'consumer' ? ['owner'] : []),
        exportedTokens: new Set(),
        isGlobal: false,
      });
    }
    return { container, Consumer };
  }

  it('throws the visibility error in throw mode on both paths', async () => {
    const { container, Consumer } = wire('throw');
    expect(() => container.resolve(Consumer, 'consumer')).toThrow(ModuleVisibilityError);
    await expect(container.resolveAsync(Consumer, 'consumer')).rejects.toThrow(
      ModuleVisibilityError,
    );
  });

  it('warns once and injects undefined in log mode; honors default factories', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { container, Consumer } = wire('log');
      const sync = container.resolve(Consumer, 'consumer');
      const async = await container.resolveAsync(Consumer, 'consumer');
      for (const consumer of [sync, async]) {
        expect(consumer.hidden).toBeUndefined();
        expect(consumer.defaulted).toBe('fallback');
      }
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('OptionalVisibilityHidden'));
    } finally {
      warn.mockRestore();
    }
  });

  it('stays quiet in silent mode', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { container, Consumer } = wire('silent');
      expect(container.resolve(Consumer, 'consumer').hidden).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
