import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from 'hono';
import { Module } from '../module/decorators';
import { VelaFactory } from '../factory';
import type { VelaApplication } from '../application';
import type { VelaHono } from '../http/hono.types';
import { getExecutionLifetime } from '../entrypoint/execution-scope';
import { getRequestContainer } from '../http/request-container';
import { REQUEST_CONTEXT } from '../http/request-context';
import type { HttpRequestObserver } from '../http/request-observer';
import { Scope } from '../constants';
import { defineProvider, InjectionToken } from '../container/types';
import {
  createExecutionTelemetryObserver,
  createHttpClientTelemetryObserver,
  createOpenTelemetry,
  extractTraceContext,
  getRequestTelemetry,
  injectTraceContext,
  noopSpan,
  noopTelemetry,
  observabilityAdapter,
  safeTelemetry,
  telemetryForScope,
  validateTraceContext,
  type Telemetry,
  type TelemetryAttributes,
  type TelemetryOutcome,
  type TelemetrySpanOptions,
} from '../observability';

const traceId = '1234567890abcdef1234567890abcdef';
const spanId = '1234567890abcdef';
const traceparent = `00-${traceId}-${spanId}-01`;
const parent = { traceId, spanId, traceFlags: 1 };

function recorder() {
  const spans: Array<{
    name: string;
    options?: TelemetrySpanOptions;
    attributes: TelemetryAttributes[];
    outcomes: TelemetryOutcome[];
  }> = [];
  const metrics: Array<{ name: string; value: number; attributes?: TelemetryAttributes }> = [];
  const telemetry: Telemetry = {
    startSpan(name, options) {
      const span = {
        name,
        options,
        attributes: [] as TelemetryAttributes[],
        outcomes: [] as TelemetryOutcome[],
      };
      spans.push(span);
      return {
        context: {
          traceId: options?.parent?.traceId ?? crypto.randomUUID().replaceAll('-', ''),
          spanId: spans.length.toString(16).padStart(16, '0'),
          traceFlags: 1,
        },
        setAttributes: (attributes) => {
          span.attributes.push(attributes);
        },
        end: (outcome = 'success') => {
          span.outcomes.push(outcome);
        },
      };
    },
    createCounter: (name) => ({
      add: (value, attributes) => {
        metrics.push({ name, value, attributes });
      },
    }),
    createHistogram: (name) => ({
      record: (value, attributes) => {
        metrics.push({ name, value, attributes });
      },
    }),
  };
  return { spans, metrics, telemetry };
}

function nativeContext() {
  const pending: Promise<unknown>[] = [];
  const context: ExecutionContext = {
    waitUntil: (work) => {
      pending.push(work);
    },
    passThroughOnException() {},
    props: {},
  };
  return { pending, context };
}

const apps: VelaApplication[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

async function application(
  mount: (hono: VelaHono) => void,
  telemetry?: Telemetry,
  trustIncoming = false,
) {
  @Module({})
  class App {}
  const app = await VelaFactory.create(App, {
    adapters: [
      observabilityAdapter({ telemetry, trustIncomingTraceContext: trustIncoming }),
      {
        name: 'routes',
        onRoutesBuilt: ({ app }) => {
          mount(app.getHonoApp());
        },
      },
    ],
  });
  apps.push(app);
  return app;
}

describe('trace context', () => {
  it('validates and snapshots only bounded W3C trace context', () => {
    const result = extractTraceContext(
      new Headers({ traceparent, tracestate: 'vendor=one, other=two', baggage: 'secret=value' }),
    );
    expect(result).toEqual({ ...parent, traceState: 'vendor=one,other=two', isRemote: true });
    expect(Object.isFrozen(result)).toBe(true);
    expect(
      extractTraceContext(new Headers({ traceparent: `01-${traceId}-${spanId}-03-extra` })),
    ).toEqual({ ...parent, isRemote: true });
    expect(validateTraceContext({ ...parent, traceFlags: 256 })).toBeUndefined();
    expect(
      validateTraceContext({
        ...parent,
        get traceId() {
          throw new Error('bad getter');
        },
      }),
    ).toBeUndefined();
  });

  it.each([
    '',
    `00-${'0'.repeat(32)}-${spanId}-01`,
    `00-${traceId}-${'0'.repeat(16)}-01`,
    `ff-${traceId}-${spanId}-01`,
    `${traceparent}-extra`,
    traceparent.toUpperCase(),
    `${traceparent},${traceparent}`,
    `00-${traceId}-${spanId}-zz`,
    `${traceparent}-`,
  ])('rejects malformed parent %s', (value) => {
    expect(
      extractTraceContext(new Headers({ traceparent: value, tracestate: 'vendor=one' })),
    ).toBeUndefined();
  });

  it.each([
    'vendor=one,vendor=two',
    'Vendor=one',
    'vendor=',
    'vendor=bad=value',
    `vendor=${'x'.repeat(257)}`,
    Array.from({ length: 33 }, (_, i) => `v${i}=a`).join(','),
    'vendor=é',
    'vendor =value',
    'vendor@1=one',
  ])('discards invalid state without losing a valid parent', (state) => {
    expect(extractTraceContext(new Headers({ traceparent, tracestate: state }))).toEqual({
      ...parent,
      isRemote: true,
    });
  });

  it('replaces stale trace state without copying any other fields', () => {
    const headers = new Headers({
      authorization: 'Bearer existing',
      baggage: 'local=owned',
      traceparent: 'stale',
      tracestate: 'old=value',
    });
    injectTraceContext(headers, parent);
    expect(headers.get('traceparent')).toBe(traceparent);
    expect(headers.has('tracestate')).toBe(false);
    expect(headers.get('authorization')).toBe('Bearer existing');
    expect(headers.get('baggage')).toBe('local=owned');
    injectTraceContext(headers, undefined);
    expect(headers.has('traceparent')).toBe(false);
  });
});

describe('request telemetry', () => {
  it('records once after body, deferred work, and disposal; excludes arbitrary identifiers', async () => {
    const recording = recorder();
    const release = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const disposing = Promise.withResolvers<void>();
    const resource = new InjectionToken<{ dispose(): Promise<void> }>('resource');
    let scoped: ReturnType<typeof getRequestContainer> | undefined;
    const app = await application(
      (hono) =>
        hono.get('/items/:id', (c) => {
          scoped = getRequestContainer(c);
          scoped.resolve(resource);
          getExecutionLifetime(scoped)!.defer(() => release.promise);
          const request = scoped.resolve(REQUEST_CONTEXT);
          expect(getRequestTelemetry(request)).toBe(telemetryForScope(scoped));
          expect(getRequestTelemetry(request).span.context?.traceId).not.toBe(traceId);
          c.set('telemetry', 'spoofed');
          return c.text('private-body');
        }),
      recording.telemetry,
    );
    app.getContainer().register(
      defineProvider(resource, {
        scope: Scope.REQUEST,
        inject: [],
        useFactory: () => ({
          async dispose() {
            disposing.resolve();
            await cleanup.promise;
          },
        }),
      }),
    );
    const native = nativeContext();
    const response = await app.fetch(
      new Request('https://test/items/private-id?secret=credential', {
        headers: {
          traceparent,
          authorization: 'Bearer credential',
          'x-request-id': 'private-request-id',
        },
      }),
      {},
      native.context,
    );
    await response.text();
    expect(recording.metrics).toHaveLength(0);
    expect(recording.spans[0]?.outcomes).toEqual([]);
    release.resolve();
    await disposing.promise;
    expect(recording.metrics).toHaveLength(0);
    cleanup.resolve();
    await Promise.all(native.pending);
    expect(recording.spans[0]?.outcomes).toEqual(['success']);
    expect(recording.metrics).toHaveLength(2);
    expect(recording.metrics[0]).toEqual({
      name: 'http.server.request.count',
      value: 1,
      attributes: {
        'http.request.method': 'GET',
        'http.route': '/items/:id',
        'http.response.status_code': 200,
        'vela.outcome': 'success',
      },
    });
    expect(recording.metrics[1]?.value).toBeGreaterThanOrEqual(0);
    expect(telemetryForScope(scoped!).span).toBe(noopSpan);
    expect(JSON.stringify(recording)).not.toMatch(/private-|credential|secret|authorization/);
  });

  it('keeps concurrent request parents independent and rejects invalid remote context', async () => {
    const recording = recorder();
    const release = Promise.withResolvers<void>();
    const seen: Array<string | undefined> = [];
    let entered = 0;
    const app = await application(
      (hono) =>
        hono.get('/', async (c) => {
          const current = telemetryForScope(getRequestContainer(c));
          if (++entered === 3) release.resolve();
          await release.promise;
          seen.push(current.span.context?.traceId);
          return c.text('ok');
        }),
      recording.telemetry,
      true,
    );
    const second = `00-${'a'.repeat(32)}-${spanId}-00`;
    const responses = await Promise.all(
      [traceparent, second, 'invalid'].map((value) =>
        app.getHonoApp().request('/', { headers: { traceparent: value } }),
      ),
    );
    await Promise.all(responses.map((response) => response.text()));
    await vi.waitFor(() => expect(recording.metrics).toHaveLength(6));
    expect(new Set(seen).size).toBe(3);
    expect(seen).toContain(traceId);
    expect(seen).toContain('a'.repeat(32));
    expect(recording.spans[2]?.options?.parent).toBeUndefined();
  });

  it.each(['HEAD', 'GET'] as const)(
    'finishes %s with no body once, and HEAD suppression is successful',
    async (method) => {
      const recording = recorder();
      const app = await application(
        (hono) =>
          hono.get('/', (c) =>
            method === 'HEAD' ? c.text('suppressed') : new Response(null, { status: 204 }),
          ),
        recording.telemetry,
      );
      const response = await app.getHonoApp().request('/', { method });
      expect(await response.text()).toBe('');
      expect(recording.spans[0]?.outcomes).toEqual(['success']);
      expect(recording.metrics).toHaveLength(2);
    },
  );

  it.each(['cancelled', 'cancel-error', 'stream-error', 'server-error', 'deferred-error'] as const)(
    'records one completion for %s',
    async (mode) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const recording = recorder();
      const release = Promise.withResolvers<void>();
      const cancellation = Promise.withResolvers<void>();
      const app = await application(
        (hono) =>
          hono.get('/', (c) => {
            if (mode === 'server-error') throw new Error('sensitive internal message');
            if (mode === 'deferred-error') {
              getExecutionLifetime(getRequestContainer(c))!.defer(() => {
                throw new Error('deferred');
              });
              return c.text('ok');
            }
            return new Response(
              new ReadableStream<Uint8Array>({
                pull(controller) {
                  if (mode === 'stream-error') throw new Error('stream');
                  controller.enqueue(new Uint8Array([1]));
                },
                async cancel() {
                  cancellation.resolve();
                  await release.promise;
                  if (mode === 'cancel-error') throw new Error('cancel');
                },
              }),
            );
          }),
        recording.telemetry,
      );
      const native = nativeContext();
      const response = await app.fetch(new Request('https://test/'), {}, native.context);
      if (mode === 'cancelled' || mode === 'cancel-error') {
        const cancelled = response.body!.cancel('sensitive reason');
        await cancellation.promise;
        expect(recording.metrics).toHaveLength(0);
        release.resolve();
        if (mode === 'cancel-error') await expect(cancelled).rejects.toThrow('cancel');
        else await cancelled;
      } else if (mode === 'stream-error') await expect(response.text()).rejects.toThrow('stream');
      else await response.text();
      if (mode === 'deferred-error')
        await expect(Promise.all(native.pending)).rejects.toThrow('deferred');
      else await Promise.all(native.pending);
      expect(recording.spans[0]?.outcomes).toEqual([mode === 'cancelled' ? 'cancelled' : 'error']);
      expect(recording.metrics).toHaveLength(2);
      expect(JSON.stringify(recording)).not.toContain('sensitive');
    },
  );

  it('includes pre-handler input rejection and unmatched routes without copying paths', async () => {
    const recording = recorder();
    const app = await application(
      (hono) => hono.get('/items/:id', (c) => c.text('ok')),
      recording.telemetry,
    );
    const responses = [
      await app.getHonoApp().request(`/items/private-id?q=${'x'.repeat(17000)}`),
      await app.getHonoApp().request('/private-unmatched-path'),
    ];
    await Promise.all(responses.map((response) => response.text()));
    await vi.waitFor(() => expect(recording.metrics).toHaveLength(4));
    expect(responses.map((response) => response.status)).toEqual([400, 404]);
    expect(JSON.stringify(recording)).not.toContain('private');
  });

  it('contains failing recorders and rejects duplicate installation', async () => {
    const broken = () => {
      throw new Error('recorder unavailable');
    };
    const telemetry = { startSpan: broken, createCounter: broken, createHistogram: broken };
    const app = await application((hono) => hono.get('/', (c) => c.text('ok')), telemetry);
    const response = await app.getHonoApp().request('/');
    expect(await response.text()).toBe('ok');
    @Module({})
    class App {}
    await expect(
      VelaFactory.create(App, { adapters: [observabilityAdapter(), observabilityAdapter()] }),
    ).rejects.toThrow('only once');
  });

  it('contains accidental async start/completion rejections without prolonging the request', async () => {
    @Module({})
    class App {}
    const completing = vi.fn(async () => {
      throw new Error('async complete');
    });
    const asyncStart = (async () => {
      throw new Error('async start');
    }) as unknown as HttpRequestObserver;
    const app = await VelaFactory.create(App, {
      adapters: [
        {
          name: 'async-observers',
          onBootstrap({ routeManager }) {
            routeManager.observeRequests(asyncStart);
            routeManager.observeRequests(() => ({ complete: completing }));
            routeManager.observeRequests(() => ({ complete: () => new Promise<void>(() => {}) }));
          },
          onRoutesBuilt({ app }) {
            app.getHonoApp().get('/', () => new Response(null, { status: 204 }));
          },
        },
      ],
    });
    apps.push(app);
    const response = await app.getHonoApp().request('/');
    expect(response.status).toBe(204);
    expect(completing).toHaveBeenCalledOnce();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('omits an uncommitted status when bodyless completion fails before error mapping', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const recording = recorder();
    const app = await application(
      (hono) =>
        hono.get('/', (context) => {
          getExecutionLifetime(getRequestContainer(context))!.defer(() => {
            throw new Error('deferred');
          });
          return new Response(null, { status: 204 });
        }),
      recording.telemetry,
    );
    const response = await app.getHonoApp().request('/');
    expect(response.status).toBe(500);
    await response.text();
    expect(recording.spans[0]?.outcomes).toEqual(['error']);
    expect(recording.metrics).toHaveLength(2);
    expect(recording.metrics[0]?.attributes).not.toHaveProperty('http.response.status_code');
  });
});

describe('independent telemetry adapters', () => {
  it('does nothing by default and contains record/end failures independently', async () => {
    expect(noopTelemetry.startSpan('operation')).toBe(noopSpan);
    const end = vi.fn(() => {
      throw new Error('end failed');
    });
    const safe = safeTelemetry({
      ...noopTelemetry,
      startSpan: () => ({
        context: parent,
        setAttributes: () => {
          throw new Error('attributes failed');
        },
        end,
      }),
    });
    const span = safe.startSpan('operation');
    span.setAttributes({ key: 'value' });
    span.end('error');
    span.end('success');
    expect(end).toHaveBeenCalledExactlyOnceWith('error');
    const asyncFailure = safeTelemetry({
      ...noopTelemetry,
      createCounter: () => ({
        add: async () => {
          throw new Error('async recording failed');
        },
      }),
    });
    asyncFailure.createCounter('count').add(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('injects outgoing child context and records only bounded labels', () => {
    const recording = recorder();
    const observer = createHttpClientTelemetryObserver({
      telemetry: recording.telemetry,
      parent: () => parent,
    });
    const headers = new Headers({ tracestate: 'old=one', authorization: 'Bearer secret' });
    const observed = observer.onRequest({ method: 'GET', headers });
    expect(extractTraceContext(headers)).toEqual({
      ...parent,
      spanId: '0000000000000001',
      isRemote: true,
    });
    expect(headers.get('authorization')).toBe('Bearer secret');
    expect(headers.has('tracestate')).toBe(false);
    observed.onResponse({ status: 201 });
    observed.onEnd();
    observed.onError(new Error('late'));
    observed.onEnd();
    expect(recording.spans[0]?.outcomes).toEqual(['success']);
    expect(recording.metrics).toHaveLength(2);
    expect(JSON.stringify(recording)).not.toContain('secret');
    const unknown = observer.onRequest({ method: 'UNBOUNDED-METHOD', headers: new Headers() });
    unknown.onError(new DOMException('private message', 'AbortError'));
    unknown.onEnd();
    expect(recording.metrics[2]?.attributes).toEqual({
      'http.request.method': '_OTHER',
      'vela.outcome': 'cancelled',
    });
  });

  it('records client failures and treats missing/invalid status as absent', () => {
    const recording = recorder();
    const observer = createHttpClientTelemetryObserver({ telemetry: recording.telemetry });
    for (const status of [503, 403, Number.NaN]) {
      const observed = observer.onRequest({ method: 'POST', headers: new Headers() });
      observed.onResponse({ status });
      if (Number.isNaN(status)) observed.onError(new Error('secret network failure'));
      observed.onEnd();
    }
    expect(recording.spans.map((span) => span.outcomes)).toEqual([['error'], ['error'], ['error']]);
    expect(recording.metrics[4]?.attributes).not.toHaveProperty('http.response.status_code');
  });

  it('records independent execution operations once without job payloads', () => {
    const recording = recorder();
    const observer = createExecutionTelemetryObserver({
      operation: 'queue.process',
      telemetry: recording.telemetry,
      parent: () => parent,
    });
    const first = observer.onStart();
    const second = observer.onStart();
    first.onEnd('success');
    second.onEnd('error');
    first.onEnd('cancelled');
    expect(recording.metrics).toHaveLength(4);
    expect(recording.spans.map((span) => span.outcomes)).toEqual([['success'], ['error']]);
    expect(recording.spans[0]?.options?.parent).toEqual(parent);
    expect(() => createExecutionTelemetryObserver({ operation: '' })).toThrow('fixed name');
  });

  it('bridges explicit OpenTelemetry contexts without ambient state or SDK setup', () => {
    const root = Symbol('root');
    const linked = Symbol('linked');
    const sdkSpan = {
      spanContext: () => ({ ...parent, traceState: { serialize: () => 'vendor=one' } }),
      setAttributes: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const tracer = { startSpan: vi.fn(() => sdkSpan) };
    const parentContext = vi.fn(() => linked);
    const add = vi.fn();
    const record = vi.fn();
    const meter = {
      createCounter: vi.fn(() => ({ add })),
      createHistogram: vi.fn(() => ({ record })),
    };
    const telemetry = createOpenTelemetry({ rootContext: root, parentContext, tracer, meter });
    expect(tracer.startSpan).not.toHaveBeenCalled();
    const span = telemetry.startSpan('operation', { parent, kind: 'consumer' });
    expect(tracer.startSpan).toHaveBeenCalledWith(
      'operation',
      { kind: 4, attributes: undefined },
      linked,
    );
    expect(span.context).toEqual({ ...parent, traceState: 'vendor=one' });
    span.end('error');
    span.end();
    expect(sdkSpan.end).toHaveBeenCalledOnce();
    expect(sdkSpan.setStatus).toHaveBeenCalledExactlyOnceWith({ code: 2 });
    telemetry.startSpan('root');
    expect(tracer.startSpan).toHaveBeenLastCalledWith(
      'root',
      { kind: 0, attributes: undefined },
      root,
    );
    expect(parentContext).toHaveBeenCalledExactlyOnceWith(parent);
    telemetry.createCounter('count', { unit: '{execution}' }).add(1, { operation: 'work' });
    telemetry.createHistogram('duration', { unit: 's' }).record(0.2);
    expect(add).toHaveBeenCalledWith(1, { operation: 'work' });
    expect(record).toHaveBeenCalledWith(0.2, undefined);
  });

  it('always attempts to end OpenTelemetry spans when other SDK calls fail', () => {
    const end = vi.fn();
    const fail = () => {
      throw new Error('SDK failure');
    };
    const telemetry = createOpenTelemetry({
      rootContext: undefined,
      parentContext: () => undefined,
      tracer: {
        startSpan: () => ({ spanContext: fail, setAttributes: fail, setStatus: fail, end }),
      },
    });
    const span = telemetry.startSpan('operation');
    expect(span.context).toBeUndefined();
    span.end('error');
    expect(end).toHaveBeenCalledOnce();
  });
});
