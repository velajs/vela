import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  APP_EXCEPTION_HANDLER,
  APP_GUARD,
  Catch,
  EXECUTION_LIFETIME,
  ENV,
  Inject,
  InjectionToken,
  Injectable,
  Module,
  NotFoundException,
  ParseIntPipe,
  Scope,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UsePipes,
  VelaError,
  defineProvider,
  type CallHandler,
  type CanActivate,
  type ExceptionFilter,
  type ExecutionContext,
  type ExecutionLifetime,
  type NestInterceptor,
  type VelaEnv,
} from '@velajs/vela';
import { APP_LOGGER } from '@velajs/vela/logging';
import type { Container, EntrypointExecutionContext } from '@velajs/vela/module-kit';
import { EntrypointError, isEntrypointError } from '../rpc/entrypoint-error';
import { durableObjectHostMembers } from '../durable-object/host-methods';
import {
  createDurableObjectHost,
  type DurableObjectHostDispatcher,
} from '../durable-object/host-dispatch';
import type { DurableObjectRpcMethod } from '../durable-objects';

const REPORTS = new InjectionToken<unknown[]>('test reports');
const CALLS = new InjectionToken<string[]>('test calls');

/** Record what the application reports, as an ExceptionHandler would forward it. */
function recordReports(container: Container): void {
  const reports: unknown[] = [];
  container.register(defineProvider(REPORTS, { useValue: reports }));
  container.markGlobalToken(REPORTS);
  container.register(
    defineProvider(APP_EXCEPTION_HANDLER, {
      useValue: { report: (error: unknown) => void reports.push(error) },
    }),
  );
}

/** Boot a host whose RPC methods are `rpc`, as `VelaDurableObject(root, Host, { rpc })` does. */
async function host<H extends object>(
  root: Parameters<typeof createDurableObjectHost>[0],
  hostClass: new (...args: never[]) => H,
  rpc: readonly DurableObjectRpcMethod<H>[] = [],
  options: { env?: VelaEnv; waitUntil?: (promise: Promise<unknown>) => void } = {},
): Promise<{ dispatcher: DurableObjectHostDispatcher; reports: unknown[] }> {
  const dispatcher = await createDurableObjectHost(
    root,
    hostClass,
    {
      env: options.env ?? {},
      adapters: [{ name: 'reports', configureContainer: recordReports }],
      waitUntil: options.waitUntil,
    },
    durableObjectHostMembers(hostClass, rpc),
  );
  return { dispatcher, reports: dispatcher.context.get(REPORTS) };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected a rejection');
}

/** The EntrypointError a failed RPC call rejects with. */
async function rpcFailure(promise: Promise<unknown>): Promise<EntrypointError> {
  const error = await rejection(promise);
  if (!(error instanceof EntrypointError)) throw new Error(`Unexpected rejection: ${error}`);
  return error;
}

describe('Durable Object host methods', () => {
  it('exposes only the prototype methods the rpc list names', () => {
    class Base {
      inherited(): string {
        return 'base';
      }
    }
    class CounterHost extends Base {
      #hidden = 0;
      get value(): number {
        return this.#hidden;
      }
      increment(): number {
        return this.helper();
      }
      // TypeScript-private: an ordinary prototype method at runtime.
      private helper(): number {
        return ++this.#hidden;
      }
      // A method named like a stub member is harmless while it is not listed.
      name(): string {
        return 'counter';
      }
      onModuleInit(): void {}
      onApplicationShutdown(): void {}
      fetch(): Response {
        return new Response('ok');
      }
      alarm(): void {}
      webSocketMessage(): void {}
    }
    const handlers = ['fetch', 'alarm', 'webSocketMessage'];
    expect(durableObjectHostMembers(CounterHost, ['increment', 'inherited'])).toEqual({
      methods: ['increment', 'inherited'],
      handlers,
    });
    // Without a list, the object has no RPC methods: only its event handlers.
    expect(durableObjectHostMembers(CounterHost)).toEqual({ methods: [], handlers });
  });

  it('rejects a host whose prototype defines then(), which would hang its resolution', () => {
    class ThenableHost {
      increment(): number {
        return 1;
      }
      then(resolve: (value: unknown) => void): void {
        void resolve;
      }
    }
    class Base {
      get then(): undefined {
        return undefined;
      }
    }
    class InheritedThenable extends Base {
      increment(): number {
        return 1;
      }
    }
    // Resolving the host awaits it: a thenable never produces the instance.
    expect(() => durableObjectHostMembers(ThenableHost, ['increment'])).toThrow(
      'ThenableHost defines then()',
    );
    expect(() => durableObjectHostMembers(InheritedThenable)).toThrow(
      'InheritedThenable defines then()',
    );
  });

  it('rejects rpc names that would shadow the Durable Object or its stubs', () => {
    for (const name of ['ctx', 'env', 'connect', 'dup', 'id', 'name']) {
      class Clashing {}
      Object.defineProperty(Clashing.prototype, name, { value: () => undefined });
      expect(() => durableObjectHostMembers(Clashing, [name])).toThrow(`'${name}' is reserved`);
    }
    // A host defining then() is rejected outright (see above); listing it is reserved too.
    class Plain {}
    expect(() => durableObjectHostMembers(Plain, ['then'])).toThrow(`'then' is reserved`);
  });

  it('rejects rpc names that are hooks, handlers or not prototype methods', () => {
    class Hooks {
      arrow = (): number => 1;
      get value(): number {
        return 1;
      }
      onModuleInit(): void {}
      dispose(): void {}
      collectEntrypoints(): unknown[] {
        return [];
      }
      fetch(): Response {
        return new Response('ok');
      }
    }
    for (const name of ['onModuleInit', 'dispose', 'collectEntrypoints', 'constructor']) {
      expect(() => durableObjectHostMembers(Hooks, [name])).toThrow(
        `Hooks.${name}() cannot be a Durable Object RPC method`,
      );
    }
    expect(() => durableObjectHostMembers(Hooks, ['fetch'])).toThrow(
      'fetch() is the Durable Object fetch handler',
    );
    for (const name of ['arrow', 'value', 'missing']) {
      expect(() => durableObjectHostMembers(Hooks, [name])).toThrow(
        `Hooks has no prototype method ${name}()`,
      );
    }
  });
});

describe('Durable Object host dispatch', () => {
  it('runs RPC calls with DI, a fresh request scope per call and module visibility', async () => {
    let created = 0;
    @Injectable()
    class Store {
      count = 0;
    }
    @Injectable({ scope: Scope.REQUEST })
    class Trace {
      readonly id = ++created;
    }
    @Module({ providers: [Store], exports: [Store] })
    class StoreModule {}

    @Injectable()
    class CounterHost {
      constructor(
        @Inject(Store) private readonly store: Store,
        @Inject(Trace) private readonly trace: Trace,
        @Inject(ENV) private readonly env: VelaEnv,
      ) {}
      increment(by: number): { count: number; trace: number; region: unknown } {
        this.store.count += by;
        return {
          count: this.store.count,
          trace: this.trace.id,
          region: Reflect.get(this.env, 'REGION'),
        };
      }
    }
    @Module({ imports: [StoreModule], providers: [Trace] })
    class AppModule {}

    const env = { REGION: 'eu' };
    const { dispatcher } = await host(AppModule, CounterHost, ['increment'], { env });
    expect(await dispatcher.call('increment', [2])).toEqual({ count: 2, trace: 1, region: 'eu' });
    expect(await dispatcher.call('increment', [3])).toEqual({ count: 5, trace: 2, region: 'eu' });

    // Another instance (another object) has its own singletons.
    const other = await host(AppModule, CounterHost, ['increment'], { env });
    expect(await other.dispatcher.call('increment', [1])).toMatchObject({ count: 1 });
    await dispatcher.context.dispose();
    await other.dispatcher.context.dispose();
  });

  it('runs scoped guards, pipes, interceptors and filters with an rpc ExecutionContext', async () => {
    const seen: EntrypointExecutionContext[] = [];
    @Injectable()
    class Observe implements CanActivate {
      canActivate(context: EntrypointExecutionContext): boolean {
        seen.push(context);
        return true;
      }
    }
    @Injectable()
    class Deny implements CanActivate {
      canActivate(): boolean {
        return false;
      }
    }
    @Injectable()
    class Wrap implements NestInterceptor {
      async intercept(_context: ExecutionContext, next: CallHandler): Promise<unknown> {
        return { wrapped: await next.handle() };
      }
    }
    @Catch(NotFoundException)
    class Recover implements ExceptionFilter {
      catch(): unknown {
        return 'recovered';
      }
    }

    @UseGuards(Observe)
    @Injectable()
    class GuardedHost {
      @UsePipes(ParseIntPipe)
      @UseInterceptors(Wrap)
      double(value: number): number {
        return value * 2;
      }
      @UseGuards(Deny)
      secret(): string {
        return 'never';
      }
      @UseFilters(Recover)
      missing(): string {
        throw new NotFoundException('No such counter');
      }
    }
    @Module({ providers: [Observe, Deny, Wrap] })
    class AppModule {}

    const { dispatcher } = await host(AppModule, GuardedHost, ['double', 'secret', 'missing']);
    expect(await dispatcher.call('double', ['21'])).toEqual({ wrapped: 42 });
    const [context] = seen;
    expect(context?.getType()).toBe('rpc');
    expect(context?.getClass()).toBe(GuardedHost);
    expect(context?.getHandlerName()).toBe('double');
    expect(context?.getHandler()).toBe(GuardedHost.prototype.double);
    expect(context?.getPayload()).toEqual(['21']);

    const denied = await rpcFailure(dispatcher.call('secret', []));
    expect(isEntrypointError(denied)).toBe(true);
    expect(denied).toMatchObject({ status: 403, code: 'forbidden', message: 'Forbidden' });

    expect(await dispatcher.call('missing', [])).toBe('recovered');
    await dispatcher.context.dispose();
  });

  it('reports failures first and returns only the documented error shape', async () => {
    @Injectable()
    class FailingHost {
      leak(): never {
        const error = new Error('db password is hunter2');
        Object.assign(error, { query: 'SELECT secret' });
        throw error;
      }
      missing(): never {
        throw new NotFoundException('Counter not found');
      }
      invalid(): never {
        throw new VelaError('bad_request', {
          message: 'Invalid amount',
          data: { field: 'amount' },
        });
      }
      nested(): never {
        throw new EntrypointError({ status: 409, code: 'conflict', message: 'Busy' });
      }
      nestedServerFault(): never {
        throw new EntrypointError({
          status: 503,
          code: 'upstream_down',
          message: 'upstream db.internal:5432 refused',
        });
      }
    }
    @Module({})
    class AppModule {}
    const { dispatcher, reports } = await host(AppModule, FailingHost, [
      'leak',
      'missing',
      'invalid',
      'nested',
      'nestedServerFault',
    ]);

    const leaked = await rpcFailure(dispatcher.call('leak', []));
    expect(isEntrypointError(leaked)).toBe(true);
    // Only these own properties cross the RPC boundary (workerd serializes them).
    expect({ ...leaked }).toEqual({ name: 'EntrypointError', status: 500, code: 'internal' });
    expect(leaked.message).toBe('Internal Server Error');
    expect(leaked.stack).toBe('EntrypointError: Internal Server Error');
    expect(Object.getOwnPropertyNames(leaked).toSorted()).toEqual(
      ['code', 'message', 'name', 'stack', 'status'].toSorted(),
    );
    expect(reports).toHaveLength(1);
    expect(String(reports[0])).toContain('hunter2');

    expect(await rpcFailure(dispatcher.call('missing', []))).toMatchObject({
      status: 404,
      code: 'not_found',
      message: 'Counter not found',
    });
    expect(await rpcFailure(dispatcher.call('invalid', []))).toMatchObject({
      status: 400,
      code: 'bad_request',
      message: 'Invalid amount',
      details: { field: 'amount' },
    });
    expect(await rpcFailure(dispatcher.call('nested', []))).toMatchObject({
      status: 409,
      code: 'conflict',
      message: 'Busy',
    });
    // A server fault keeps its status only: its text is never a client message.
    const serverFault = await rpcFailure(dispatcher.call('nestedServerFault', []));
    expect({ ...serverFault, message: serverFault.message }).toEqual({
      name: 'EntrypointError',
      status: 503,
      code: 'service_unavailable',
      message: 'Service Unavailable',
    });
    await expect(dispatcher.call('unknownMethod', [])).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
    await dispatcher.context.dispose();
  });

  it('never lets a failure outside the pipeline cross the RPC boundary', async () => {
    @Injectable()
    class PlainHost {
      ping(): string {
        return 'pong';
      }
      fetch(): Response {
        return new Response('ok');
      }
    }
    @Module({})
    class AppModule {}
    // A logger the error reporter itself cannot build: the invocation fails
    // before its pipeline starts.
    const dispatcher = await createDurableObjectHost(
      AppModule,
      PlainHost,
      {
        env: {},
        adapters: [
          {
            name: 'broken-logger',
            configureContainer(container) {
              container.register(
                defineProvider(APP_LOGGER, {
                  scope: Scope.REQUEST,
                  useFactory: () => {
                    throw new Error('logger secret');
                  },
                }),
              );
              container.markGlobalToken(APP_LOGGER);
            },
          },
        ],
      },
      durableObjectHostMembers(PlainHost, ['ping']),
    );
    const failure = await rpcFailure(dispatcher.call('ping', []));
    expect({ ...failure, message: failure.message }).toEqual({
      name: 'EntrypointError',
      status: 500,
      code: 'internal',
      message: 'Internal Server Error',
    });
    const response = await dispatcher.fetch(new Request('https://do.test/'));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('secret');
    await dispatcher.context.dispose();
  });

  it('recognizes the error shape after it crossed the RPC boundary', () => {
    // workerd delivers a plain Error carrying the thrown error's own properties.
    const remote = Object.assign(new Error('Forbidden'), {
      name: 'EntrypointError',
      status: 403,
      code: 'forbidden',
      remote: true,
    });
    expect(isEntrypointError(remote)).toBe(true);
    if (isEntrypointError(remote)) expectTypeOf(remote.status).toEqualTypeOf<number>();
    expect(isEntrypointError(new Error('Forbidden'))).toBe(false);
    expect(isEntrypointError({ name: 'EntrypointError', status: '403', code: 'x' })).toBe(false);
  });

  it('delegates fetch, alarm and WebSocket handlers through the same pipeline', async () => {
    @Injectable()
    class Deny implements CanActivate {
      canActivate(context: ExecutionContext): boolean {
        return context.getType() !== 'cf:do:fetch';
      }
    }
    @Injectable()
    class HandlerHost {
      constructor(@Inject(CALLS) private readonly calls: string[]) {}
      fetch(request: Request): Response {
        this.calls.push(`fetch ${new URL(request.url).pathname}`);
        return Response.json({ ok: true });
      }
      alarm(info?: { retryCount: number }): void {
        this.calls.push(`alarm ${info?.retryCount ?? 0}`);
        if ((info?.retryCount ?? 0) > 0) throw new Error('alarm failed');
      }
      webSocketMessage(_ws: unknown, message: string): void {
        this.calls.push(`message ${message}`);
      }
    }
    @UseGuards(Deny)
    @Injectable()
    class GuardedFetchHost {
      fetch(): Response {
        return new Response('never');
      }
      boom(): never {
        throw new Error('secret');
      }
    }
    const calls: string[] = [];
    @Module({
      providers: [Deny, defineProvider(CALLS, { useValue: calls })],
      exports: [CALLS],
    })
    class AppModule {}

    const { dispatcher, reports } = await host(AppModule, HandlerHost);
    const response = await dispatcher.fetch(new Request('https://do.test/status'));
    expect(await response.json()).toEqual({ ok: true });
    await dispatcher.alarm({ retryCount: 0, isRetry: false, scheduledTime: 0 });
    const alarmFailure = await rejection(
      dispatcher.alarm({ retryCount: 1, isRetry: true, scheduledTime: 0 }),
    );
    // The platform retries alarms: the handler's own error reaches it, reported first.
    expect(alarmFailure).toBeInstanceOf(Error);
    expect(String(alarmFailure)).toContain('alarm failed');
    expect(reports).toEqual([alarmFailure]);
    await dispatcher.webSocket('webSocketMessage', [{}, 'hello']);
    expect(calls).toEqual(['fetch /status', 'alarm 0', 'alarm 1', 'message hello']);

    const guarded = await host(AppModule, GuardedFetchHost);
    const forbidden = await guarded.dispatcher.fetch(new Request('https://do.test/'));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: { code: 'forbidden', message: 'Forbidden' } });
    await dispatcher.context.dispose();
    await guarded.dispatcher.context.dispose();
  });

  it('renders fetch failures as a redacted JSON response', async () => {
    @Injectable()
    class BrokenFetch {
      fetch(): Response {
        throw new Error('internal detail');
      }
    }
    @Module({})
    class AppModule {}
    const { dispatcher, reports } = await host(AppModule, BrokenFetch);
    const response = await dispatcher.fetch(new Request('https://do.test/'));
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain('internal detail');
    expect(JSON.parse(body)).toEqual({
      error: { code: 'internal', message: 'Internal Server Error' },
    });
    expect(reports).toHaveLength(1);
    await dispatcher.context.dispose();
  });

  it('leaves application-wide HTTP guards out of Durable Object invocations', async () => {
    @Injectable()
    class HttpOnly implements CanActivate {
      canActivate(): boolean {
        return false;
      }
    }
    @Injectable()
    class OpenHost {
      ping(): string {
        return 'pong';
      }
    }
    @Module({ providers: [defineProvider(APP_GUARD, { useClass: HttpOnly })] })
    class AppModule {}
    const { dispatcher } = await host(AppModule, OpenHost, ['ping']);
    expect(await dispatcher.call('ping', [])).toBe('pong');
    await dispatcher.context.dispose();
  });

  it('reports managed work that fails after the call, without failing the call', async () => {
    @Injectable({ scope: Scope.REQUEST })
    class DeferringHost {
      constructor(@Inject(EXECUTION_LIFETIME) private readonly lifetime: ExecutionLifetime) {}
      schedule(): string {
        this.lifetime.defer(() => {
          throw new Error('background failed');
        });
        return 'scheduled';
      }
    }
    @Module({})
    class AppModule {}
    const { dispatcher, reports } = await host(AppModule, DeferringHost, ['schedule']);
    expect(await dispatcher.call('schedule', [])).toBe('scheduled');
    expect(reports.map(String)).toEqual(['Error: background failed']);
    await dispatcher.context.dispose();
  });

  it('leaves every method the rpc list does not name off the RPC surface', async () => {
    const recorded: string[] = [];
    @Injectable()
    class LedgerHost {
      constructor(@Inject(CALLS) private readonly calls: string[]) {}
      async reset(): Promise<string> {
        await this.wipe();
        return 'reset';
      }
      // A TypeScript-private helper: callable over RPC only if it were listed.
      private async wipe(): Promise<void> {
        this.calls.push('wiped');
      }
      protected secretHelper(): string {
        return 'secret';
      }
      audit(): string {
        return 'audit';
      }
      // The container's disposal hook.
      dispose(): void {
        this.calls.push('disposed');
      }
    }
    @Module({ providers: [defineProvider(CALLS, { useValue: recorded })] })
    class AppModule {}

    const { dispatcher } = await host(AppModule, LedgerHost, ['reset']);
    expect(await dispatcher.call('reset', [])).toBe('reset');
    for (const method of ['wipe', 'secretHelper', 'audit', 'dispose']) {
      // eslint-disable-next-line no-await-in-loop -- One call at a time.
      expect(await rpcFailure(dispatcher.call(method, []))).toMatchObject({
        status: 404,
        code: 'not_found',
      });
    }
    expect(recorded).toEqual(['wiped']);
    // Only public, non-hook methods can be listed.
    const typed = (): void => {
      // @ts-expect-error a TypeScript-private helper is never an RPC method
      void host(AppModule, LedgerHost, ['wipe']);
      // @ts-expect-error dispose() is the container's disposal hook
      void host(AppModule, LedgerHost, ['dispose']);
    };
    void typed;
    await dispatcher.context.dispose();
  });

  it('keeps the execution scope open until a streamed fetch body finishes', async () => {
    const resources: Resource[] = [];
    @Injectable({ scope: Scope.REQUEST })
    class Resource {
      closed = false;
      constructor() {
        resources.push(this);
      }
      dispose(): void {
        this.closed = true;
      }
    }
    @Injectable()
    class StreamingHost {
      constructor(@Inject(Resource) private readonly resource: Resource) {}
      fetch(request: Request): Response {
        const resource = this.resource;
        const encoder = new TextEncoder();
        if (request.method === 'HEAD') return new Response('ignored');
        return new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(encoder.encode(`first closed=${resource.closed}\n`));
              await new Promise((resolve) => setTimeout(resolve, 20));
              controller.enqueue(encoder.encode(`later closed=${resource.closed}\n`));
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/plain' } },
        );
      }
    }
    @Module({ providers: [Resource] })
    class AppModule {}
    const completions: Promise<unknown>[] = [];
    const { dispatcher } = await host(AppModule, StreamingHost, [], {
      waitUntil: (promise) => void completions.push(promise),
    });

    const response = await dispatcher.fetch(new Request('https://do.test/export'));
    expect(response.headers.get('content-type')).toBe('text/plain');
    expect(completions).toHaveLength(1);
    // Request-scoped providers stay open while the body streams.
    expect(await response.text()).toBe('first closed=false\nlater closed=false\n');
    await Promise.all(completions);
    expect(resources.map((resource) => resource.closed)).toEqual([true]);

    // A HEAD response sends no body: the scope finishes before it returns.
    const head = await dispatcher.fetch(new Request('https://do.test/export', { method: 'HEAD' }));
    expect(head.body).toBeNull();
    expect(resources.map((resource) => resource.closed)).toEqual([true, true]);
    expect(completions).toHaveLength(1);
    await dispatcher.context.dispose();
  });
  it('finishes the scope when a fetch body cannot be sent', async () => {
    const resources: Resource[] = [];
    @Injectable({ scope: Scope.REQUEST })
    class Resource {
      closed = false;
      constructor() {
        resources.push(this);
      }
      dispose(): void {
        this.closed = true;
      }
    }
    @Injectable()
    class LockedBodyHost {
      constructor(@Inject(Resource) private readonly resource: Resource) {}
      fetch(): Response {
        const response = new Response(`resource ${this.resource.closed}`);
        // Another reader holds the body: it can no longer be streamed.
        void response.body?.getReader();
        return response;
      }
    }
    @Module({ providers: [Resource] })
    class AppModule {}
    const { dispatcher, reports } = await host(AppModule, LockedBodyHost);
    const response = await dispatcher.fetch(new Request('https://do.test/'));
    expect(response.status).toBe(500);
    expect(reports).toHaveLength(1);
    expect(resources.map((resource) => resource.closed)).toEqual([true]);
    await dispatcher.context.dispose();
  });
});
