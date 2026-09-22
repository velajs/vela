import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  hc,
  readHttpResponse,
  type HttpApp,
  type HttpResponse,
  type InferResponseType,
} from '../src/http';

type App = HttpApp<{
  '/download': { $get: { input: {}; output: Blob; outputFormat: 'binary'; status: 200 } };
  '/events': {
    $get:
      | {
          input: {};
          output: ReadableStream<Uint8Array> | null;
          outputFormat: 'stream';
          status: 200;
        }
      | { input: {}; output: { message: string }; outputFormat: 'json'; status: 503 };
  };
}>;

describe('native HTTP response consumption', () => {
  it('returns the same response with status and headers intact and unknown JSON types', async () => {
    const native = Response.json(
      { error: 'offline' },
      { status: 503, headers: { 'retry-after': '10' } },
    );
    const response = await readHttpResponse(Promise.resolve(native), 'response');
    expectTypeOf(response).toEqualTypeOf<HttpResponse>();
    expect(response).toBe(native);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('10');
    expect(response.bodyUsed).toBe(false);
    expectTypeOf<ReturnType<typeof response.json>>().toEqualTypeOf<Promise<unknown>>();
    await response.body?.cancel();
    const fresh = await readHttpResponse(Response.json({ ok: true }), 'response');
    const clone = fresh.clone();
    expectTypeOf(clone).toEqualTypeOf<HttpResponse>();
    expect(await clone.json()).toEqual({ ok: true });
    await fresh.body?.cancel();
  });

  it('uses native blob consumption for binary calls and keeps JSON unknown', async () => {
    const client = hc<App>('https://test', {
      fetch: async () =>
        new Response(new Uint8Array([0, 255]), {
          headers: { 'content-type': 'application/octet-stream' },
        }),
    });
    const response = await client.download.$get();
    expectTypeOf<InferResponseType<typeof client.download.$get>>().toEqualTypeOf<Blob>();
    const blob = await readHttpResponse(response, 'blob');
    expect(blob.type).toBe('application/octet-stream');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([0, 255]));
    if (false) {
      const unknownJson = await response.json();
      expectTypeOf(unknownJson).toEqualTypeOf<unknown>();
      // @ts-expect-error Binary media does not establish arbitrary JSON fields.
      unknownJson.message;
    }
  });

  it('leaves streams unread and passes cancellation through to the producer', async () => {
    const cancel = vi.fn();
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const controller = new AbortController();
    let signal: AbortSignal | null | undefined;
    const client = hc<App>('https://test', {
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal;
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const response = await client.events.$get({}, { init: { signal: controller.signal } });
    if (response.status === 503) {
      expectTypeOf(await response.json()).toEqualTypeOf<{ message: string }>();
      throw new Error('unexpected status');
    }
    const stream = await readHttpResponse(response, 'stream');
    expectTypeOf(stream).toEqualTypeOf<ReadableStream<Uint8Array> | null>();
    expect(stream).toBe(body);
    expect(pull).not.toHaveBeenCalled();
    expect(response.bodyUsed).toBe(false);
    expect(signal).toBe(controller.signal);
    await stream?.cancel('done');
    expect(cancel).toHaveBeenCalledExactlyOnceWith('done');
    controller.abort();
    expect(signal?.aborted).toBe(true);
  });

  it('propagates fetch and producer errors without automatic error-body buffering', async () => {
    const failure = new Error('failed');
    await expect(readHttpResponse(Promise.reject(failure), 'response')).rejects.toBe(failure);
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.error(failure);
        },
      },
      { highWaterMark: 0 },
    );
    const response = new Response(body, { status: 503 });
    const stream = await readHttpResponse(response, 'stream');
    expect(response.bodyUsed).toBe(false);
    const reader = stream!.getReader();
    await expect(reader.read()).rejects.toBe(failure);
    reader.releaseLock();
    expect(await readHttpResponse(new Response(null, { status: 204 }), 'stream')).toBeNull();
  });
});
