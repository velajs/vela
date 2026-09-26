import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@velajs/vela';
import { CloudflareTracingInterceptor } from '../tracing';

const native = vi.hoisted(() => ({
  enterSpan:
    vi.fn<
      (
        name: string,
        work: (span: {
          isTraced: boolean;
          setAttribute: (key: string, value: string) => void;
        }) => Promise<unknown>,
      ) => Promise<unknown>
    >(),
}));

vi.mock('cloudflare:workers', () => ({ tracing: native }));

class Handler {}

function context(kind = 'http', method: string | symbol = 'read'): ExecutionContext {
  const unused = (): never => {
    throw new Error('Tracing must not inspect request data');
  };
  return {
    getType: () => kind,
    getClass: () => Handler,
    getHandlerName: () => method,
    getHandler: unused,
    getModuleId: unused,
    getContainer: unused,
    getContext: unused,
    getRequest: unused,
    switchToHttp: unused,
    switchToWs: unused,
  };
}

describe('CloudflareTracingInterceptor', () => {
  const interceptor = new CloudflareTracingInterceptor();
  const setAttribute = vi.fn<(key: string, value: string) => void>();

  beforeEach(() => {
    vi.clearAllMocks();
    native.enterSpan.mockImplementation((_name, work) => work({ isTraced: true, setAttribute }));
  });

  it.each(['http', 'rpc'])(
    'invokes %s work inside the native callback and returns its promise',
    async (kind) => {
      let inside = false;
      native.enterSpan.mockImplementation((_name, work) => {
        inside = true;
        try {
          return work({ isTraced: true, setAttribute });
        } finally {
          inside = false;
        }
      });
      const result = Promise.resolve({ value: 42 });
      const handle = vi.fn(() => {
        expect(inside).toBe(true);
        return result;
      });

      expect(interceptor.intercept(context(kind), { handle })).toBe(result);
      expect(await result).toEqual({ value: 42 });
      expect(handle).toHaveBeenCalledTimes(1);
      expect(native.enterSpan).toHaveBeenCalledWith(`vela.${kind}.handler`, expect.any(Function));
      expect(setAttribute.mock.calls).toEqual([
        ['vela.handler.class', 'Handler'],
        ['vela.handler.method', 'read'],
      ]);
    },
  );

  it('bounds source labels and leaves the span name independent of the handler', async () => {
    class LongName {}
    Object.defineProperty(LongName, 'name', { value: 'C'.repeat(1000) });
    await interceptor.intercept(
      { ...context('rpc', 'm'.repeat(1000)), getClass: () => LongName },
      { handle: async () => null },
    );
    expect(native.enterSpan.mock.calls[0]?.[0]).toBe('vela.rpc.handler');
    expect(setAttribute.mock.calls).toEqual([
      ['vela.handler.class', 'C'.repeat(128)],
      ['vela.handler.method', 'm'.repeat(128)],
    ]);
  });

  it('omits symbol descriptions', async () => {
    await interceptor.intercept(context('http', Symbol('private-value')), {
      handle: async () => null,
    });
    expect(setAttribute.mock.calls).toEqual([['vela.handler.class', 'Handler']]);
  });

  it('runs unsampled work without reading labels', async () => {
    native.enterSpan.mockImplementation((_name, work) => work({ isTraced: false, setAttribute }));
    const unused = (): never => {
      throw new Error('Unsampled labels must not be read');
    };
    const handle = vi.fn(async () => 'unsampled');
    expect(
      await interceptor.intercept(
        { ...context(), getClass: unused, getHandlerName: unused },
        { handle },
      ),
    ).toBe('unsampled');
    expect(handle).toHaveBeenCalledTimes(1);
    expect(setAttribute).not.toHaveBeenCalled();
  });

  it.each(['ws', 'queue', 'scheduled'])(
    'passes through %s without a handler span',
    async (kind) => {
      const handle = vi.fn(async () => 'result');
      expect(await interceptor.intercept(context(kind), { handle })).toBe('result');
      expect(handle).toHaveBeenCalledTimes(1);
      expect(native.enterSpan).not.toHaveBeenCalled();
    },
  );

  it('preserves synchronous throws and rejected promises without recording exception data', async () => {
    const error = new Error('private-error-detail');
    expect(() =>
      interceptor.intercept(context(), {
        handle: () => {
          throw error;
        },
      }),
    ).toThrow(error);
    await expect(
      interceptor.intercept(context('rpc'), {
        handle: async () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
    expect(
      setAttribute.mock.calls.every(
        ([key]) => key === 'vela.handler.class' || key === 'vela.handler.method',
      ),
    ).toBe(true);
  });
});
