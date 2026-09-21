import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createRpcClient,
  defineProcedure,
  RpcError,
  RpcHttpError,
  RpcProtocolError,
} from '../index';
import type { RpcRequest } from '../index';

const echo = defineProcedure({
  name: 'echo.value',
  input: z.string().transform(Number),
  output: z.object({ value: z.number() }),
});
const query = defineProcedure({
  name: 'echo.read',
  input: z.string(),
  output: z.string(),
  idempotent: true,
});
function success(request: RpcRequest, result: unknown) {
  return Response.json({
    version: 1,
    id: request.id,
    procedure: request.procedure,
    ok: true,
    result,
  });
}
afterEach(() => vi.useRealTimers());

describe('portable RPC client', () => {
  it('sends original input, preserves Fetcher receiver and per-call headers', async () => {
    const fetcher = {
      label: 'binding',
      async fetch(request: Request) {
        expect(this.label).toBe('binding');
        expect(request.headers.get('authorization')).toBe('Bearer per-call');
        expect(request.headers.get('content-type')).toBe('application/json');
        const body = (await request.json()) as RpcRequest;
        expect(body.input).toBe('42');
        return success(body, { value: 42 });
      },
    };
    const client = createRpcClient({
      url: 'https://rpc.test/rpc',
      fetch: fetcher,
      headers: async () => ({ authorization: 'Bearer default' }),
    });
    expect(
      await client.call(echo, '42', { headers: { authorization: 'Bearer per-call' } }),
    ).toEqual({ value: 42 });
    expect(Object.keys(client)).toEqual([]);
  });
  it('uses an independent result decoder and never retries its failures', async () => {
    let calls = 0;
    const client = createRpcClient({
      url: 'https://rpc.test/rpc',
      fetch: async (r) => {
        calls++;
        return success((await r.json()) as RpcRequest, 42);
      },
    });
    await expect(
      client.call(query, 'x', {
        retry: { maxAttempts: 3 },
        decode: (value) => z.string().parse(value),
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it('rejects bad protocol identity even on HTTP 200', async () => {
    const client = createRpcClient({
      url: 'https://rpc.test/rpc',
      fetch: async (r) => success({ ...((await r.json()) as RpcRequest), id: 'foreign' }, {}),
    });
    await expect(client.call(echo, '42')).rejects.toBeInstanceOf(RpcProtocolError);
  });
  it('distinguishes application failures from HTTP transport failures', async () => {
    const client = createRpcClient({
      url: 'https://rpc.test/rpc',
      fetch: async (r) => {
        const rpc = (await r.json()) as RpcRequest;
        return Response.json(
          {
            version: 1,
            id: rpc.id,
            procedure: rpc.procedure,
            ok: false,
            error: { code: 'forbidden', message: 'Denied', status: 403 },
          },
          { status: 403 },
        );
      },
    });
    await expect(client.call(query, '')).rejects.toMatchObject({
      name: 'RpcError',
      code: 'forbidden',
      status: 403,
    });
    const upstream = createRpcClient({
      url: 'https://rpc.test/rpc',
      fetch: async () => new Response('gateway down', { status: 502 }),
    });
    await expect(upstream.call(query, '')).rejects.toBeInstanceOf(RpcHttpError);
  });
  it('defaults to one attempt, and rejects retries for mutations before fetch', async () => {
    const fetch = vi.fn(async (): Promise<Response> => {
      throw new TypeError('network');
    });
    const client = createRpcClient({ url: 'https://rpc.test/rpc', fetch });
    await expect(client.call(echo, '1')).rejects.toThrow('network');
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(client.call(echo, '1', { retry: { maxAttempts: 2 } })).rejects.toThrow(
      'idempotent',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('retries only explicit idempotent calls, retaining the correlation ID', async () => {
    vi.useFakeTimers();
    const ids: string[] = [];
    const fetch = vi.fn(async (request: Request) => {
      const rpc = (await request.json()) as RpcRequest;
      ids.push(rpc.id);
      if (ids.length === 1) return new Response('unavailable', { status: 503 });
      return success(rpc, 'done');
    });
    const pending = createRpcClient({ url: 'https://rpc.test/rpc', fetch }).call(query, 'x', {
      retry: { maxAttempts: 2, delayMs: 10 },
    });
    await vi.runAllTimersAsync();
    expect(await pending).toBe('done');
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('never retries a framed application 503', async () => {
    const fetch = vi.fn(async (request: Request) => {
      const rpc = (await request.json()) as RpcRequest;
      return Response.json(
        {
          version: 1,
          id: rpc.id,
          procedure: rpc.procedure,
          ok: false,
          error: { code: 'busy', message: 'Busy', status: 503 },
        },
        { status: 503 },
      );
    });
    await expect(
      createRpcClient({ url: 'https://rpc.test/rpc', fetch }).call(query, '', {
        retry: { maxAttempts: 3 },
      }),
    ).rejects.toBeInstanceOf(RpcError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not treat a miscorrelated error frame as a retryable gateway failure', async () => {
    const fetch = vi.fn(async (request: Request) => {
      const rpc = (await request.json()) as RpcRequest;
      return Response.json(
        {
          version: 1,
          id: 'foreign',
          procedure: rpc.procedure,
          ok: false,
          error: { code: 'busy', message: 'Busy', status: 503 },
        },
        { status: 503 },
      );
    });
    await expect(
      createRpcClient({ url: 'https://rpc.test/rpc', fetch }).call(query, '', {
        retry: { maxAttempts: 3 },
      }),
    ).rejects.toBeInstanceOf(RpcProtocolError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('bounds a fetch that ignores cancellation and releases a late response', async () => {
    vi.useFakeTimers();
    let release!: (r: Response) => void;
    const cancelled = vi.fn();
    const client = createRpcClient({
      url: 'https://rpc.test/rpc',
      timeoutMs: 100,
      fetch: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const pending = client.call(query, '').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ name: 'TimeoutError' });
    release(new Response(new ReadableStream({ cancel: cancelled })));
    await Promise.resolve();
    await Promise.resolve();
    expect(cancelled).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels a hanging body and preserves the caller abort reason', async () => {
    const controller = new AbortController();
    const reason = new Error('caller left');
    const cancel = vi.fn();
    const client = createRpcClient({
      url: 'https://rpc.test/rpc',
      fetch: async () =>
        new Response(
          new ReadableStream({
            start() {
              queueMicrotask(() => controller.abort(reason));
            },
            cancel,
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    });
    await expect(client.call(query, '', { signal: controller.signal })).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalled();
  });
  it('bounds response bytes and accepts only the JSON media type', async () => {
    const client = createRpcClient({
      url: 'https://rpc.test/rpc',
      maxResponseBytes: 4,
      fetch: async () => Response.json({ large: 'payload' }),
    });
    await expect(client.call(query, '')).rejects.toThrow('maxResponseBytes');
    const invalid = createRpcClient({
      url: 'https://rpc.test/rpc',
      fetch: async () =>
        new Response('{}', { headers: { 'content-type': 'evilapplication/json' } }),
    });
    await expect(invalid.call(query, '')).rejects.toBeInstanceOf(RpcProtocolError);
  });
  it('does not start transport for an already-aborted call', async () => {
    const controller = new AbortController();
    controller.abort('stop');
    const fetch = vi.fn();
    await expect(
      createRpcClient({ url: 'https://rpc.test/rpc', fetch }).call(query, '', {
        signal: controller.signal,
      }),
    ).rejects.toBe('stop');
    expect(fetch).not.toHaveBeenCalled();
  });
});
