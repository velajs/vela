import { isVelaError } from '@velajs/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Container } from '../container/container.js';
import { InternalDispatcher } from '../dispatch/internal-dispatcher.js';
import type { InvocationTransport } from '../dispatch/types.js';
import type { UrlGeneratorService } from '../http/url/url-generator.service.js';

const SECRET = 'dispatch-deadline-test-secret';

function makeDispatcher(transport: InvocationTransport): InternalDispatcher {
  const urls = {} as UrlGeneratorService;
  const container = {
    resolve: () => transport,
  } as unknown as Container;
  return new InternalDispatcher(urls, container, SECRET);
}

function captureTransport(): {
  request: Promise<Request>;
  transport: InvocationTransport;
} {
  let capture!: (request: Request) => void;
  const request = new Promise<Request>((resolve) => {
    capture = resolve;
  });
  return {
    request,
    transport: (value) => {
      capture(value);
      return new Promise<Response>(() => {});
    },
  };
}

async function waitForBodyReader(response: Response, attempts = 20): Promise<void> {
  if (response.body?.locked === true || attempts === 0) {
    expect(response.body?.locked).toBe(true);
    return;
  }
  await Promise.resolve();
  return waitForBodyReader(response, attempts - 1);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('InternalDispatcher abort deadlines', () => {
  it('bounds a transport that ignores Request.signal with the 30-second default', async () => {
    vi.useFakeTimers();
    const captured = captureTransport();
    const pending = makeDispatcher(captured.transport)
      .run({ path: '/inv/run' })
      .catch((error: unknown) => error);
    const request = await captured.request;

    await vi.advanceTimersByTimeAsync(29_999);
    expect(vi.getTimerCount()).toBe(1);
    expect(request.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const error = await pending;

    expect(isVelaError(error)).toBe(true);
    if (isVelaError(error)) {
      expect(error.code).toBe('gateway_timeout');
      expect(error.status).toBe(504);
      expect(error.message).toMatch(/timed out after 30000ms/);
    }
    expect(request.signal.aborted).toBe(true);
    expect(request.signal.reason).toMatchObject({ name: 'TimeoutError' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honors a finite positive per-call timeout override', async () => {
    vi.useFakeTimers();
    const captured = captureTransport();
    const pending = makeDispatcher(captured.transport)
      .run({ path: '/inv/run' }, { timeoutMs: 25 })
      .catch((error: unknown) => error);
    await captured.request;

    await vi.advanceTimersByTimeAsync(24);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    const error = await pending;
    expect(isVelaError(error) && error.code).toBe('gateway_timeout');
    expect((error as Error).message).toMatch(/timed out after 25ms/);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid timeoutMs %s before dispatch',
    async (timeoutMs) => {
      const transport = vi.fn<InvocationTransport>();
      await expect(
        makeDispatcher(transport).run({ path: '/inv/run' }, { timeoutMs }),
      ).rejects.toThrow(RangeError);
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it('clears the deadline timer after a fast response is fully read', async () => {
    vi.useFakeTimers();
    const dispatcher = makeDispatcher(async () => Response.json({ ok: true }));

    await expect(dispatcher.run({ path: '/inv/run' })).resolves.toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['successful', 200],
    ['non-ok', 500],
  ])('bounds and cancels a stalled %s response body', async (_label, status) => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    let markDelivered!: () => void;
    const delivered = new Promise<void>((resolve) => {
      markDelivered = resolve;
    });
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel,
      }),
      { status },
    );
    const dispatcher = makeDispatcher(async () => {
      markDelivered();
      return response;
    });
    const pending = dispatcher
      .run({ path: '/inv/run' }, { timeoutMs: 40 })
      .catch((error: unknown) => error);
    await delivered;
    await waitForBodyReader(response);

    await vi.advanceTimersByTimeAsync(40);
    const error = await pending;
    await Promise.resolve();

    expect(isVelaError(error) && error.code).toBe('gateway_timeout');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel.mock.calls[0]?.[0]).toMatchObject({ name: 'TimeoutError' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves an in-flight caller abort reason and clears its timeout', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const captured = captureTransport();
    const pending = makeDispatcher(captured.transport)
      .run({ path: '/inv/run' }, { signal: controller.signal, timeoutMs: 1000 })
      .catch((error: unknown) => error);
    const request = await captured.request;
    const reason = new DOMException('caller stopped dispatch', 'TimeoutError');
    await vi.advanceTimersByTimeAsync(0);

    controller.abort(reason);

    await expect(pending).resolves.toBe(reason);
    expect(request.signal.aborted).toBe(true);
    expect(request.signal.reason).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves an already-aborted caller reason without invoking the transport', async () => {
    const controller = new AbortController();
    const reason = new Error('already stopped');
    controller.abort(reason);
    const transport = vi.fn<InvocationTransport>();

    await expect(
      makeDispatcher(transport).run({ path: '/inv/run' }, { signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(transport).not.toHaveBeenCalled();
  });

  it('does not reclassify an arbitrary transport TimeoutError', async () => {
    const upstream = new DOMException('upstream timeout', 'TimeoutError');
    const dispatcher = makeDispatcher(async () => {
      throw upstream;
    });

    await expect(dispatcher.run({ path: '/inv/run' })).rejects.toBe(upstream);
  });
});
