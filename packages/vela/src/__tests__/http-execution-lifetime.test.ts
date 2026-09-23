import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context, ExecutionContext as HonoExecutionContext } from 'hono';
import {
  EXECUTION_LIFETIME,
  Inject,
  Controller,
  Get,
  Injectable,
  Module,
  Req,
  Scope,
  VelaFactory,
  type ExecutionLifetime,
} from '../index';
import { getExecutionLifetime, getRequestContainer } from '../module-kit';

afterEach(() => vi.restoreAllMocks());

function nativeContext() {
  const pending: Promise<unknown>[] = [];
  const context: HonoExecutionContext = {
    waitUntil(work) {
      pending.push(work);
    },
    passThroughOnException() {},
    props: {},
  };
  return { context, pending };
}

describe('HTTP managed execution lifetime', () => {
  it('starts deferred work before body drain and retains scope through both work and async disposal', async () => {
    const release = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const events: string[] = [];
    let lifetime: ExecutionLifetime | undefined;
    @Injectable({ scope: Scope.REQUEST })
    class Resource {
      async dispose() {
        events.push('dispose-start');
        await cleanup.promise;
        events.push('dispose-end');
      }
    }
    @Controller('/managed')
    class Routes {
      constructor(
        readonly resource: Resource,
        @Inject(EXECUTION_LIFETIME) readonly managed: ExecutionLifetime,
      ) {}
      @Get()
      get(@Req() context: Context) {
        lifetime = getExecutionLifetime(getRequestContainer(context));
        expect(this.managed).toBe(lifetime);
        lifetime!.defer(async () => {
          events.push('deferred-start');
          await release.promise;
          events.push('deferred-end');
        });
        return new Response('body');
      }
    }
    @Module({ controllers: [Routes], providers: [Resource] })
    class App {}
    const app = await VelaFactory.create(App);
    const native = nativeContext();
    const abort = new AbortController();
    try {
      const request = new Request('http://test/managed', { signal: abort.signal });
      const response = await app.fetch(request, {}, native.context);
      expect(lifetime?.signal).toBe(request.signal);
      expect(lifetime?.active).toBe(true);
      expect(events).toEqual(['deferred-start']);
      expect(native.pending).toHaveLength(1);
      release.resolve();
      await response.text();
      await vi.waitFor(() => expect(events).toContain('dispose-start'));
      expect(events).not.toContain('dispose-end');
      cleanup.resolve();
      await Promise.all(native.pending);
      expect(events).toEqual(['deferred-start', 'deferred-end', 'dispose-start', 'dispose-end']);
      expect(lifetime?.active).toBe(false);
      expect(() => lifetime!.defer(() => {})).toThrow('closed');
    } finally {
      release.resolve();
      cleanup.resolve();
      await app.close();
    }
  });

  it('retains resources until a cancelled producer finishes cancellation', async () => {
    const cancelled = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const events: string[] = [];
    @Injectable({ scope: Scope.REQUEST })
    class Resource {
      dispose() {
        events.push('dispose');
      }
    }
    @Controller('/cancel')
    class Routes {
      constructor(readonly resource: Resource) {}
      @Get()
      get() {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
            async cancel(reason) {
              events.push(String(reason));
              cancelled.resolve();
              await release.promise;
              events.push('cancel-end');
            },
          }),
        );
      }
    }
    @Module({ controllers: [Routes], providers: [Resource] })
    class App {}
    const app = await VelaFactory.create(App);
    const native = nativeContext();
    try {
      const response = await app.fetch(new Request('http://test/cancel'), {}, native.context);
      const cancellation = response.body!.cancel('client-left');
      await cancelled.promise;
      expect(events).toEqual(['client-left']);
      release.resolve();
      await cancellation;
      await Promise.all(native.pending);
      expect(events).toEqual(['client-left', 'cancel-end', 'dispose']);
    } finally {
      release.resolve();
      await app.close();
    }
  });

  it.each(['HEAD', 'GET'] as const)(
    'finishes %s responses without a transmitted body',
    async (method) => {
      const events: string[] = [];
      let lifetime: ExecutionLifetime | undefined;
      @Injectable({ scope: Scope.REQUEST })
      class Resource {
        dispose() {
          events.push('dispose');
        }
      }
      @Controller('/empty')
      class Routes {
        constructor(readonly resource: Resource) {}
        @Get()
        get(@Req() context: Context) {
          lifetime = getExecutionLifetime(getRequestContainer(context));
          lifetime!.defer(() => {
            events.push('deferred');
          });
          return method === 'HEAD' ? 'suppressed' : null;
        }
      }
      @Module({ controllers: [Routes], providers: [Resource] })
      class App {}
      const app = await VelaFactory.create(App);
      try {
        const response = await app.getHonoApp().request('/empty', { method });
        expect(await response.text()).toBe('');
        expect(events).toEqual(['deferred', 'dispose']);
        expect(lifetime?.active).toBe(false);
      } finally {
        await app.close();
      }
    },
  );

  it('reports failed deferred work once and keeps rejection visible to native waitUntil', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('deferred-failure');
    @Controller('/failed')
    class Routes {
      @Get()
      get(@Req() context: Context) {
        getExecutionLifetime(getRequestContainer(context))!.defer(() => {
          throw failure;
        });
        return 'already-responding';
      }
    }
    @Module({ controllers: [Routes] })
    class App {}
    const app = await VelaFactory.create(App);
    const native = nativeContext();
    try {
      const response = await app.fetch(new Request('http://test/failed'), {}, native.context);
      expect(await response.text()).toBe('already-responding');
      await expect(Promise.all(native.pending)).rejects.toBe(failure);
      expect(report).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('finishes and disposes when the response stream errors', async () => {
    let disposed = 0;
    @Injectable({ scope: Scope.REQUEST })
    class Resource {
      dispose() {
        disposed++;
      }
    }
    @Controller('/stream-error')
    class Routes {
      constructor(readonly resource: Resource) {}
      @Get()
      get() {
        return new Response(
          new ReadableStream({
            pull() {
              throw new Error('stream-failed');
            },
          }),
        );
      }
    }
    @Module({ controllers: [Routes], providers: [Resource] })
    class App {}
    const app = await VelaFactory.create(App);
    const native = nativeContext();
    try {
      const response = await app.fetch(new Request('http://test/stream-error'), {}, native.context);
      await expect(response.text()).rejects.toThrow('stream-failed');
      await Promise.all(native.pending);
      expect(disposed).toBe(1);
    } finally {
      await app.close();
    }
  });
});

it('seeds the shared scope for adapter-only routes before their handler executes', async () => {
  @Module({})
  class App {}
  let lifetime: ExecutionLifetime | undefined;
  const app = await VelaFactory.create(App, {
    adapters: [
      {
        name: 'test-adapter',
        onRoutesBuilt({ app }) {
          app.getHonoApp().post('/rpc', (context) => {
            lifetime = getExecutionLifetime(getRequestContainer(context));
            return context.json({ active: lifetime?.active });
          });
        },
      },
    ],
  });
  const native = nativeContext();
  try {
    const response = await app.fetch(
      new Request('http://test/rpc', { method: 'POST' }),
      {},
      native.context,
    );
    expect(await response.json()).toEqual({ active: true });
    await Promise.all(native.pending);
    expect(lifetime?.active).toBe(false);
  } finally {
    await app.close();
  }
});
