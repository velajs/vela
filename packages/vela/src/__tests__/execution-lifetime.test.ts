import { describe, expect, it, vi } from 'vitest';
import { Scope } from '../constants';
import { Container } from '../container/container';
import { InjectionToken, defineProvider } from '../container/types';
import {
  createExecutionScope,
  EXECUTION_LIFETIME,
  finishExecutionScope,
  getExecutionLifetime,
  runInEntrypointScope,
} from '../entrypoint/execution-scope';
import { getEntrypointModuleId, resolveEntrypoint } from '../entrypoint/execution-context';

function root(): Container {
  const container = new Container({ diagnostics: 'silent' });
  container.register(
    defineProvider(EXECUTION_LIFETIME, {
      scope: Scope.REQUEST,
      inject: [],
      useFactory: () => {
        throw new Error('outside managed invocation');
      },
    }),
  );
  container.markGlobalToken(EXECUTION_LIFETIME);
  return container;
}

function gate() {
  return Promise.withResolvers<void>();
}

describe('managed execution lifetime', () => {
  it('isolates concurrent invocation DI and cooperatively exposes cancellation', async () => {
    const container = root();
    const abort = new AbortController();
    const ready = gate();
    const seen: string[] = [];
    const first = runInEntrypointScope(
      container,
      async (scope, lifetime) => {
        expect(scope.resolve(EXECUTION_LIFETIME)).toBe(lifetime);
        expect(getExecutionLifetime(scope)).toBe(lifetime);
        seen.push(lifetime.id);
        abort.abort();
        expect(lifetime.signal?.aborted).toBe(true);
        await ready.promise;
        expect(lifetime.active).toBe(true);
      },
      { signal: abort.signal },
    );
    await runInEntrypointScope(container, (scope, lifetime) => {
      expect(scope.resolve(EXECUTION_LIFETIME)).toBe(lifetime);
      seen.push(lifetime.id);
      expect(lifetime.signal).toBeUndefined();
      ready.resolve();
    });
    await first;
    expect(new Set(seen).size).toBe(2);
    expect(getExecutionLifetime(container)).toBeUndefined();
    expect(() => container.resolve(EXECUTION_LIFETIME)).toThrow(/request-scoped[\s\S]*root/);
  });

  it('drains nested deferred work before one asynchronous disposal', async () => {
    const container = root();
    const RESOURCE = new InjectionToken<{ dispose(): Promise<void> }>('resource');
    const events: string[] = [];
    const release = gate();
    container.register(
      defineProvider(RESOURCE, {
        scope: Scope.REQUEST,
        inject: [],
        useFactory: () => ({
          async dispose() {
            events.push('disposing');
            await release.promise;
            events.push('disposed');
          },
        }),
      }),
    );
    const scope = createExecutionScope(container);
    scope.container.resolve(RESOURCE);
    scope.lifetime.defer(async () => {
      events.push('outer');
      scope.lifetime.defer(() => {
        events.push('nested');
      });
      await Promise.resolve();
    });
    const completion = scope.finish();
    expect(scope.finish()).toBe(completion);
    await vi.waitFor(() => expect(events).toEqual(['outer', 'nested', 'disposing']));
    expect(scope.lifetime.active).toBe(false);
    let finished = false;
    void completion.then(() => {
      finished = true;
      return undefined;
    });
    expect(finished).toBe(false);
    release.resolve();
    await completion;
    expect(events).toEqual(['outer', 'nested', 'disposing', 'disposed']);
    await finishExecutionScope(scope.container);
    expect(events.filter((event) => event === 'disposed')).toHaveLength(1);
  });

  it('starts work while a stream boundary is open, accepts stream work, then closes', async () => {
    const scope = createExecutionScope(root());
    const body = gate();
    const ran = gate();
    const events: string[] = [];
    scope.lifetime.defer(() => {
      events.push('early');
      ran.resolve();
    });
    const completion = scope.finish(body.promise);
    await ran.promise;
    expect(scope.lifetime.active).toBe(true);
    scope.lifetime.defer(() => {
      events.push('stream');
    });
    body.resolve();
    await completion;
    expect(events).toEqual(['early', 'stream']);
    expect(getExecutionLifetime(scope.container)).toBeUndefined();
    expect(() => scope.lifetime.defer(() => {})).toThrow('closed');
    expect(() => scope.lifetime.waitUntil(Promise.resolve())).toThrow('closed');
  });

  it('observes already-started rejections before earlier deferred work unblocks', async () => {
    const container = root();
    const block = gate();
    const error = new Error('sink failed');
    const started = gate();
    const pending = runInEntrypointScope(container, (_scope, lifetime) => {
      lifetime.defer(async () => {
        started.resolve();
        await block.promise;
      });
      lifetime.waitUntil(Promise.reject(error));
    });
    const result = expect(pending).rejects.toBe(error);
    await started.promise;
    // Cross a task boundary: an unobserved rejection would fail Vitest here.
    await new Promise((resolve) => setTimeout(resolve, 0));
    block.resolve();
    await result;
  });

  it('retains handler and completion errors while settling remaining work', async () => {
    const handlerError = new Error('handler');
    const deferredError = new Error('deferred');
    const events: string[] = [];
    const result = runInEntrypointScope(root(), (_scope, lifetime) => {
      lifetime.defer(() => {
        throw deferredError;
      });
      lifetime.defer(() => {
        events.push('remaining');
      });
      throw handlerError;
    });
    await expect(result).rejects.toMatchObject({ errors: [handlerError, deferredError] });
    expect(events).toEqual(['remaining']);
  });

  it('collects multiple deferred and boundary failures, and still disposes', async () => {
    const scope = createExecutionScope(root());
    const errors = [new Error('a'), new Error('b'), new Error('body')];
    const dispose = vi.spyOn(scope.container, 'dispose');
    scope.lifetime.defer(() => {
      throw errors[0];
    });
    scope.lifetime.defer(() => {
      throw errors[1];
    });
    try {
      await scope.finish(Promise.reject(errors[2]));
      throw new Error('expected completion failure');
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual(expect.arrayContaining(errors));
    }
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(scope.lifetime.active).toBe(false);
  });

  it('handles reentrant finish without executing a callback twice', async () => {
    const scope = createExecutionScope(root());
    let reentrant: Promise<void> | undefined;
    const work = vi.fn(() => {
      reentrant = scope.finish();
    });
    scope.lifetime.defer(work);
    const completion = scope.finish();
    await completion;
    expect(reentrant).toBe(completion);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('does not expose owned state as writable runtime properties', async () => {
    const scope = createExecutionScope(root());
    expect(Object.keys(scope.lifetime)).not.toContain('pending');
    expect(Reflect.set(scope.lifetime, 'active', false)).toBe(false);
    expect(scope.lifetime.active).toBe(true);
    await scope.finish();
  });
});

describe('owner-qualified entrypoint resolution', () => {
  it('preserves typed async resolution and rejects foreign/ambiguous owner metadata', async () => {
    const container = root();
    const TOKEN = new InjectionToken<string>('owned job');
    for (const moduleId of ['alpha', 'beta']) {
      container.registerScope({
        moduleId,
        localProviders: new Set([TOKEN]),
        importedModules: new Set(),
        exportedTokens: new Set(),
        global: false,
      });
    }
    container.register(
      defineProvider(TOKEN, { inject: [], useFactory: async () => 'alpha' }),
      'alpha',
    );
    container.register(
      defineProvider(TOKEN, { inject: [], useFactory: async () => 'beta' }),
      'beta',
    );
    const scope = createExecutionScope(container);
    expect(() => getEntrypointModuleId(scope.container, { token: TOKEN })).toThrow('multiple');
    expect(() =>
      getEntrypointModuleId(scope.container, { token: TOKEN, moduleId: 'foreign' }),
    ).toThrow('does not register');
    expect(await resolveEntrypoint(scope.container, { token: TOKEN, moduleId: 'alpha' })).toBe(
      'alpha',
    );
    expect(await resolveEntrypoint(scope.container, { token: TOKEN, moduleId: 'beta' })).toBe(
      'beta',
    );
    await scope.finish();
    expect(() => resolveEntrypoint(scope.container, { token: TOKEN, moduleId: 'alpha' })).toThrow(
      'closed',
    );
  });
});
