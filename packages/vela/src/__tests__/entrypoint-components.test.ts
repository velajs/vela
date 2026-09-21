import { afterEach, describe, expect, it } from 'vitest';
import { Container } from '../container/container';
import { InjectionToken, defineProvider } from '../container/types';
import { UseGuards } from '../pipeline/decorators';
import { MetadataRegistry } from '../registry/metadata.registry';
import {
  resolvePipelineComponents,
  resolveScopedComponents,
  resolveScopedComponentsAsync,
} from '../pipeline/scoped-components';
import type { CanActivate } from '../pipeline/types';

afterEach(() => MetadataRegistry.clear());

describe('public owned component resolution', () => {
  it('resolves async guard factories from each handler owner in declaration order', async () => {
    const root = new Container();
    const events: string[] = [];
    class Guard implements CanActivate {
      canActivate() {
        return true;
      }
    }
    class Handler {
      run() {}
    }
    const tail = { canActivate: () => true };
    UseGuards(Guard)(Handler);
    UseGuards(tail)(
      Handler.prototype,
      'run',
      Object.getOwnPropertyDescriptor(Handler.prototype, 'run')!,
    );
    for (const moduleId of ['alpha', 'beta']) {
      root.registerScope({
        moduleId,
        localProviders: new Set([Guard]),
        importedModules: new Set(),
        exportedTokens: new Set(),
        isGlobal: false,
      });
      root.register(
        defineProvider(Guard, {
          inject: [],
          useFactory: async () => {
            events.push(moduleId);
            await Promise.resolve();
            return { canActivate: () => moduleId === 'alpha' };
          },
        }),
        moduleId,
      );
    }
    const child = root.createChild();
    const alpha = await resolveScopedComponentsAsync('guard', Handler, 'run', child, 'alpha');
    const beta = await resolveScopedComponentsAsync('guard', Handler, 'run', child, 'beta');
    expect(alpha).toHaveLength(2);
    expect(beta).toHaveLength(2);
    expect(alpha[1]).toBe(tail);
    expect(beta[1]).toBe(tail);
    expect(events).toEqual(['alpha', 'beta']);
    expect(alpha[0]).not.toBe(beta[0]);
    expect(resolveScopedComponents('guard', Handler, 'run', child, 'alpha')[0]).toBe(alpha[0]);
  });

  it('supports typed global tokens and parameterless local guards without bypassing DI', async () => {
    const root = new Container();
    const TOKEN = new InjectionToken<CanActivate>('global guard');
    const guard = { canActivate: () => true };
    root.register(defineProvider(TOKEN, { inject: [], useFactory: async () => guard }));
    class LocalGuard {
      canActivate() {
        return false;
      }
    }
    const resolved = await resolvePipelineComponents('guard', [TOKEN, LocalGuard, guard], root);
    expect(resolved[0]).toBe(guard);
    expect(resolved[1]).toBeInstanceOf(LocalGuard);
    expect(resolved[2]).toBe(guard);
  });
});
