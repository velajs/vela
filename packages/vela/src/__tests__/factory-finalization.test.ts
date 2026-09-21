import { describe, expect, it } from 'vitest';
import { Injectable, Module, VelaFactory, type RuntimeAdapter } from '../index';

describe('application finalization cleanup', () => {
  it('always disposes resources when shutdown hooks fail and shares shutdown completion', async () => {
    const events: string[] = [];
    const failure = new Error('shutdown failed');
    @Injectable()
    class Resource {
      onModuleDestroy() {
        events.push('hook');
        throw failure;
      }
      async [Symbol.asyncDispose]() {
        await Promise.resolve();
        events.push('disposed');
      }
    }
    @Module({ providers: [Resource] })
    class AppModule {}
    const app = await VelaFactory.create(AppModule);
    const first = app.dispose();
    const second = app.dispose();
    expect(second).toBe(first);
    await expect(first).rejects.toBe(failure);
    expect(events).toEqual(['hook', 'disposed']);
    await expect(app.dispose()).rejects.toBe(failure);
  });

  it('cleans up after adapter failure without losing the original startup error', async () => {
    let disposed = 0;
    const failure = new Error('adapter failed');
    @Injectable()
    class Resource {
      [Symbol.dispose]() {
        disposed++;
      }
    }
    @Module({ providers: [Resource] })
    class AppModule {}
    const adapter: RuntimeAdapter = {
      name: 'broken',
      onRoutesBuilt() {
        throw failure;
      },
    };
    await expect(VelaFactory.create(AppModule, { adapters: [adapter] })).rejects.toBe(failure);
    expect(disposed).toBe(1);
  });

  it('retains initialization and cleanup failures together', async () => {
    const startup = new Error('startup');
    const shutdown = new Error('shutdown');
    @Injectable()
    class Resource {
      onModuleInit() {
        throw startup;
      }
      onModuleDestroy() {
        throw shutdown;
      }
    }
    @Module({ providers: [Resource] })
    class AppModule {}
    await expect(VelaFactory.create(AppModule)).rejects.toMatchObject({
      cause: startup,
      errors: [startup, shutdown],
    });
  });
});
