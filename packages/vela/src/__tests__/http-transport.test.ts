import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import * as v from 'valibot';
import {
  HttpService,
  HttpRequestException,
  HttpResponseSizeException,
  type HttpClientObserver,
  type HttpModuleOptions,
  type HttpRequestConfig,
  type HttpTransport,
} from '../fetch';
import { defineDto, SchemaValidationError } from '../validation';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const url = 'https://api.example.test/items';
const encoder = new TextEncoder();

function client(options: HttpModuleOptions = {}) {
  const transport = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ok: true }));
  const http = new HttpService({ transport, ...options });
  return { http, transport };
}

describe('HTTP URLs and transports', () => {
  it.each([
    ['/items?old=a%20b#section?x', '/items?old=a%20b&q=hello+world&old=new&flag=false#section?x'],
    ['/items#section?x', '/items?q=hello+world&old=new&flag=false#section?x'],
    ['/items?', '/items?q=hello+world&old=new&flag=false'],
    ['/items?old=1&', '/items?old=1&q=hello+world&old=new&flag=false'],
  ])('appends query values before fragments in %s', async (path, expected) => {
    const { http, transport } = client({ baseURL: 'https://api.example.test/v1' });
    await http.get(path, { params: { q: 'hello world', old: 'new', flag: false } });
    expect(transport).toHaveBeenCalledWith(
      `https://api.example.test/v1${expected}`,
      expect.anything(),
    );
  });

  it('preserves literal prefixes, repeated slashes, absolute suffixes and empty params', async () => {
    const { http, transport } = client({ baseURL: 'https://api.example.test/v1/' });
    await http.get('/items?encoded=%2f#fragment', { params: {} });
    await http.get('https://other.example.test/path');
    expect(transport.mock.calls[0]?.[0]).toBe(
      'https://api.example.test/v1//items?encoded=%2f#fragment',
    );
    expect(transport.mock.calls[1]?.[0]).toBe(
      'https://api.example.test/v1/https://other.example.test/path',
    );
  });

  it('preserves method spelling when forwarding custom requests', async () => {
    const { http, transport } = client();
    await http.request({ url, method: 'PROPFIND' });
    expect(transport.mock.calls[0]?.[1]?.method).toBe('PROPFIND');
  });

  it('binds Fetcher methods and lets requests override the module transport', async () => {
    const binding = {
      value: 'bound',
      fetch: vi.fn(async function (this: { value: string }) {
        return new Response(this.value);
      }),
    };
    const { http, transport } = client({ transport: binding });
    expect((await http.get(url)).data).toBe('bound');
    const override = vi.fn(async () => new Response('override'));
    expect((await http.get(url, { transport: override })).data).toBe('override');
    expect(binding.fetch).toHaveBeenCalledTimes(1);
    expect(transport).not.toHaveBeenCalled();
  });

  it('uses global fetch by default', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('native'));
    expect((await new HttpService({}).get(url)).data).toBe('native');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    'preserves synchronous or async transport failures without retrying (%s)',
    async (sync) => {
      const failure = new TypeError('transport unavailable');
      const transport = vi.fn(() => {
        if (sync) throw failure;
        return Promise.reject(failure);
      });
      await expect(client({ transport }).http.get(url)).rejects.toBe(failure);
      expect(transport).toHaveBeenCalledOnce();
    },
  );

  it('keeps non-success responses readable on HttpRequestException', async () => {
    const response = new Response('upstream failure', { status: 503, statusText: 'Unavailable' });
    const { http } = client({ transport: async () => response, maxResponseBytes: 1 });
    const error = await http.get(url).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(HttpRequestException);
    if (!(error instanceof HttpRequestException)) throw new Error('Expected HTTP error');
    expect(error.status).toBe(503);
    expect(error.response).toBe(response);
    expect(await error.response.text()).toBe('upstream failure');
  });
});

describe('HTTP request bodies and headers', () => {
  it('merges case-insensitively, respects JSON media types, and snapshots defaults', async () => {
    const defaults = new Headers({
      'X-Token': 'default',
      'CONTENT-TYPE': 'application/problem+json',
    });
    const { http, transport } = client({ headers: defaults });
    defaults.set('X-Token', 'mutated');
    const perRequest = new Headers({ 'x-TOKEN': 'override' });
    await http.post(url, { value: 1 }, { headers: perRequest });
    await http.post(url, { value: 2 });
    const first = new Headers(transport.mock.calls[0]?.[1]?.headers);
    const second = new Headers(transport.mock.calls[1]?.[1]?.headers);
    expect(first.get('x-token')).toBe('override');
    expect(first.get('content-type')).toBe('application/problem+json');
    expect(second.get('x-token')).toBe('default');
    expect(perRequest.has('content-type')).toBe(false);
  });

  it.each([{}, [1, 'x'], true, 42, null])(
    'JSON serializes %j and supplies the content type',
    async (body) => {
      const { http, transport } = client();
      await http.post(url, body);
      expect(transport.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(body));
      expect(new Headers(transport.mock.calls[0]?.[1]?.headers).get('content-type')).toBe(
        'application/json',
      );
    },
  );

  it.each([
    ['string', () => 'literal'],
    ['URLSearchParams', () => new URLSearchParams({ field: 'value' })],
    ['Blob', () => new Blob(['data'], { type: 'application/octet-stream' })],
    ['ArrayBuffer', () => new Uint8Array([0, 255]).buffer],
    ['typed array', () => new Uint8Array([0, 255])],
    ['DataView', () => new DataView(new Uint8Array([1, 2, 3, 4]).buffer, 1, 2)],
    [
      'stream',
      () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data'));
            controller.close();
          },
        }),
    ],
  ])('forwards %s without JSON conversion', async (_name, makeBody) => {
    const body = makeBody();
    const transport = vi.fn(async (input: string, init?: RequestInit) => {
      const request = new Request(input, init);
      const bytes = new Uint8Array(await request.arrayBuffer());
      expect(bytes.byteLength).toBeGreaterThan(0);
      return new Response('ok');
    });
    await client({ transport }).http.post(url, body);
    expect(transport.mock.calls[0]?.[1]?.body).toBe(body);
    expect(new Headers(transport.mock.calls[0]?.[1]?.headers).has('content-type')).toBe(false);
  });

  it('lets the transport generate multipart boundaries even with a default JSON header', async () => {
    const form = new FormData();
    form.append('name', 'sample');
    form.append('file', new Blob([new Uint8Array([0, 255])]), 'bytes.bin');
    const transport = vi.fn(async (input: string, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
      const decoded = await request.formData();
      expect(decoded.get('name')).toBe('sample');
      const file = decoded.get('file');
      expect(file).toBeInstanceOf(Blob);
      if (!(file instanceof Blob)) throw new Error('Expected file');
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([0, 255]));
      return new Response('ok');
    });
    const { http } = client({ transport, headers: { 'CONTENT-TYPE': 'application/json' } });
    await http.post(url, form, { headers: { 'Content-Type': 'multipart/form-data' } });
    expect(transport.mock.calls[0]?.[1]?.body).toBe(form);
    expect(new Headers(transport.mock.calls[0]?.[1]?.headers).has('content-type')).toBe(false);
  });

  it('omits an undefined body', async () => {
    const { http, transport } = client();
    await http.post(url);
    expect(transport.mock.calls[0]?.[1]?.body).toBeUndefined();
  });

  it('does not start a transport for non-serializable JSON', async () => {
    const { http, transport } = client();
    await expect(http.post(url, () => {})).rejects.toBeInstanceOf(TypeError);
    await expect(http.post(url, 1n)).rejects.toBeInstanceOf(TypeError);
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('HTTP response decoding and schemas', () => {
  it.each(['HEAD', 'head'])('skips and cancels even an unexpected %s body', async (method) => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { 'Content-Type': 'application/json' },
    });
    const { http } = client({ transport: async () => response });
    expect((await http.request({ method, url })).data).toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([204, 205])('returns undefined for status %s', async (status) => {
    const { http } = client({
      transport: async () =>
        new Response(null, { status, headers: { 'Content-Type': 'application/json' } }),
    });
    expect((await http.get(url)).data).toBeUndefined();
  });

  it.each(['Application/JSON; Charset=UTF-8', 'application/problem+json'])(
    'decodes %s',
    async (contentType) => {
      const { http } = client({
        transport: async () =>
          new Response('{"value":3}', { headers: { 'CONTENT-TYPE': contentType } }),
      });
      expect((await http.get(url)).data).toEqual({ value: 3 });
    },
  );

  it('uses existing async schema machinery once, with transformed output', async () => {
    const transform = vi.fn(async (value: string) => Number(value));
    const schema = defineDto(z.object({ value: z.string().transform(transform) }));
    const { http } = client({ transport: async () => Response.json({ value: '42' }) });
    expect((await http.get(url, { schema })).data).toEqual({ value: 42 });
    expect(transform).toHaveBeenCalledOnce();
    const standard = v.object({ value: v.pipe(v.string(), v.transform(Number)) });
    expect((await http.get(url, { schema: standard })).data).toEqual({ value: 42 });
  });

  it('validates bodyless responses against undefined when a schema is supplied', async () => {
    const { http } = client({ transport: async () => new Response(null, { status: 204 }) });
    expect((await http.get(url, { schema: z.undefined().transform(() => 'empty') })).data).toBe(
      'empty',
    );
    await expect(http.get(url, { schema: z.object({ value: z.number() }) })).rejects.toBeInstanceOf(
      SchemaValidationError,
    );
  });

  it('distinguishes schema failures, validator exceptions and unchecked generic calls', async () => {
    const { http } = client({ transport: async () => Response.json({ value: 'wire' }) });
    await expect(http.get(url, { schema: z.object({ value: z.number() }) })).rejects.toBeInstanceOf(
      SchemaValidationError,
    );
    const failure = new Error('validator failed');
    await expect(
      http.get(url, {
        schema: {
          parse() {
            throw failure;
          },
        },
      }),
    ).rejects.toBe(failure);
    expect((await http.get<{ value: number }>(url)).data).toEqual({ value: 'wire' });
  });

  it('reports malformed JSON and preserves transport stream errors', async () => {
    const { http } = client({
      transport: async () => new Response('{', { headers: { 'content-type': 'application/json' } }),
    });
    await expect(http.get(url)).rejects.toBeInstanceOf(SyntaxError);
    const failure = new Error('stream failed');
    const broken = new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(failure);
        },
      }),
    );
    await expect(http.get(url, { transport: async () => broken })).rejects.toBe(failure);
  });
});

describe('HTTP buffering limits', () => {
  it.each([undefined, '0', '1', '100000'])(
    'enforces bytes on chunked bodies with content-length %s',
    async (length) => {
      const cancel = vi.fn();
      const chunks = [encoder.encode('é'), encoder.encode('é')];
      const response = new Response(
        new ReadableStream({
          pull(controller) {
            const chunk = chunks.shift();
            if (chunk) controller.enqueue(chunk);
          },
          cancel,
        }),
        { headers: length === undefined ? {} : { 'Content-Length': length } },
      );
      const { http } = client({ maxResponseBytes: 3, transport: async () => response });
      const error = await http.get(url).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(HttpResponseSizeException);
      expect(error).toMatchObject({ maxResponseBytes: 3, receivedBytes: 4 });
      expect(cancel).toHaveBeenCalledWith(error);
      expect(response.body?.locked).toBe(false);
    },
  );

  it('allows the exact byte limit and decodes UTF-8 split across chunks', async () => {
    const encoded = encoder.encode('é🙂');
    const response = new Response(
      new ReadableStream({
        start(controller) {
          for (const byte of encoded) controller.enqueue(new Uint8Array([byte]));
          controller.close();
        },
      }),
    );
    const { http } = client({ maxResponseBytes: 1, transport: async () => response });
    expect((await http.get(url, { maxResponseBytes: encoded.length })).data).toBe('é🙂');
  });

  it('supports zero-byte limits and does not trust an empty length header', async () => {
    const { http } = client({
      maxResponseBytes: 0,
      transport: async () => new Response('', { headers: { 'Content-Length': '0' } }),
    });
    expect((await http.get(url)).data).toBeUndefined();
    await expect(
      http.get(url, {
        transport: async () => new Response('x', { headers: { 'Content-Length': '0' } }),
      }),
    ).rejects.toBeInstanceOf(HttpResponseSizeException);
  });
});

describe('HTTP cancellation', () => {
  it('does not call the transport for a pre-aborted signal', async () => {
    const reason = new Error('caller cancelled');
    const { http, transport } = client();
    await expect(http.get(url, { signal: AbortSignal.abort(reason), timeout: 100 })).rejects.toBe(
      reason,
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it('composes caller cancellation with timeout and disposes late responses', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const late = Promise.withResolvers<Response>();
    const transport = vi.fn((_input: string, _init?: RequestInit) => late.promise);
    const { http } = client({ transport, timeout: 100 });
    const reason = new Error('cancelled by caller');
    const pending = http.get(url, { signal: controller.signal });
    const outcome = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await outcome;
    expect(transport.mock.calls[0]?.[1]?.signal?.reason).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
    const cancel = vi.fn();
    late.resolve(new Response(new ReadableStream({ cancel })));
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledWith(reason);
  });

  it('times out a transport that ignores its signal and honors request overrides', async () => {
    vi.useFakeTimers();
    const { http } = client({ timeout: 1, transport: () => new Promise(() => {}) });
    const controller = new AbortController();
    const pending = http.get(url, { timeout: 30, signal: controller.signal });
    const outcome = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(29);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
    expect(controller.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['caller', 'timeout'])(
    'cancels a stalled body on %s without awaiting underlying cancellation',
    async (source) => {
      vi.useFakeTimers();
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const reading = Promise.withResolvers<void>();
      const response = new Response(
        new ReadableStream({
          pull() {
            reading.resolve();
          },
          cancel,
        }),
      );
      const { http } = client({ timeout: 10, transport: async () => response });
      const controller = new AbortController();
      const pending = http.get(url, { signal: controller.signal });
      const outcome = expect(pending).rejects.toMatchObject({
        name: source === 'caller' ? 'AbortError' : 'TimeoutError',
      });
      await reading.promise;
      if (source === 'caller') controller.abort();
      else await vi.advanceTimersByTimeAsync(10);
      await outcome;
      expect(cancel).toHaveBeenCalledOnce();
      expect(response.body?.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('keeps the deadline active through asynchronous validation', async () => {
    vi.useFakeTimers();
    const started = Promise.withResolvers<void>();
    const { http } = client({ timeout: 10 });
    const pending = http.get(url, {
      schema: {
        parse() {
          started.resolve();
          return new Promise(() => {});
        },
      },
    });
    const outcome = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    await started.promise;
    await vi.advanceTimersByTimeAsync(10);
    await outcome;
  });

  it('removes timers and caller listeners after successful calls', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const { http, transport } = client({ timeout: 30 });
    await http.get(url, { signal: controller.signal });
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]?.[1]);
    expect(vi.getTimerCount()).toBe(0);
    controller.abort();
    expect(transport.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  });
});

describe('HTTP request option validation', () => {
  it.each([
    { timeout: -1 },
    { timeout: NaN },
    { timeout: 0.5 },
    { timeout: 2_147_483_648 },
    { maxResponseBytes: -1 },
    { maxResponseBytes: Infinity },
    { maxResponseBytes: '5' },
    { transport: {} },
    { transport: null },
    { signal: {} },
    { signal: null },
    { schema: {} },
    { schema: null },
    { headers: { 'invalid\nname': 'value' } },
  ])('rejects invalid options before I/O: %j', async (options) => {
    const { http, transport } = client();
    await expect(
      http.request({ method: 'GET', url, ...options } as unknown as HttpRequestConfig),
    ).rejects.toBeInstanceOf(Error);
    expect(transport).not.toHaveBeenCalled();
  });

  it('validates module-level options on construction', () => {
    expect(() => new HttpService({ timeout: -1 })).toThrow(RangeError);
    expect(() => new HttpService({ maxResponseBytes: 0.5 })).toThrow(RangeError);
    expect(() => new HttpService({ transport: {} as HttpTransport })).toThrow(TypeError);
  });
});

describe('HTTP instrumentation seam', () => {
  it('propagates through isolated headers and ends after decoding and validation', async () => {
    const events: string[] = [];
    const observer: HttpClientObserver = {
      onRequest(request) {
        events.push('request');
        request.headers.set('traceparent', 'trace');
        return {
          onResponse(response) {
            events.push('response');
            response.headers.set('x-observer', 'private');
          },
          onEnd() {
            events.push('end');
          },
        };
      },
    };
    const { http, transport } = client({ observer });
    const response = await http.get(url, {
      schema: {
        parse(value) {
          events.push('parse');
          return value;
        },
      },
    });
    expect(events).toEqual(['request', 'response', 'parse', 'end']);
    expect(new Headers(transport.mock.calls[0]?.[1]?.headers).get('traceparent')).toBe('trace');
    expect(response.headers.has('x-observer')).toBe(false);
  });

  it.each(['parse', 'size', 'abort', 'transport', 'status'])(
    'reports raw %s errors with exactly one end',
    async (kind) => {
      const onError = vi.fn();
      const onEnd = vi.fn();
      const onResponse = vi.fn();
      const failure = new Error('failure');
      const { http } = client({ observer: { onRequest: () => ({ onError, onEnd, onResponse }) } });
      const options: HttpRequestConfig = { method: 'GET', url };
      if (kind === 'parse')
        options.transport = async () =>
          new Response('{', { headers: { 'content-type': 'application/json' } });
      if (kind === 'size') options.maxResponseBytes = 0;
      if (kind === 'abort') options.signal = AbortSignal.abort(failure);
      if (kind === 'transport')
        options.transport = async () => {
          throw failure;
        };
      if (kind === 'status') options.transport = async () => new Response('error', { status: 500 });
      const error = await http.request(options).catch((caught: unknown) => caught);
      expect(onError).toHaveBeenCalledExactlyOnceWith(error);
      expect(onEnd).toHaveBeenCalledOnce();
      expect(onResponse).toHaveBeenCalledTimes(kind === 'abort' || kind === 'transport' ? 0 : 1);
    },
  );

  it('isolates observer failures from successful and failed requests', async () => {
    const failure = new Error('observer failure');
    const hooks = {
      onResponse() {
        throw failure;
      },
      async onError() {
        throw failure;
      },
      async onEnd() {
        throw failure;
      },
    };
    const { http } = client({ observer: { onRequest: () => hooks } });
    expect((await http.get(url)).data).toEqual({ ok: true });
    const transportFailure = new Error('transport failure');
    await expect(
      http.get(url, {
        transport: async () => {
          throw transportFailure;
        },
      }),
    ).rejects.toBe(transportFailure);
    const startFailure = client({
      observer: {
        onRequest() {
          throw failure;
        },
      },
    });
    expect((await startFailure.http.get(url)).data).toEqual({ ok: true });
  });
});
