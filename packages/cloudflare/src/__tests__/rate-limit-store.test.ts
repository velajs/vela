import { describe, expect, it, vi } from 'vitest';
import { Controller, Get, Module } from '@velajs/vela';
import { Throttle, ThrottlerModule } from '@velajs/vela/throttler';
import { createCloudflareApp, rateLimitStore } from '../index';

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} };

function limiter(decisions: boolean[] = []) {
  return { limit: vi.fn(async () => ({ success: decisions.shift() ?? true })) };
}

describe('rateLimitStore({ binding })', () => {
  it('uses the binding decision without inventing an exact remaining quota', async () => {
    const API_LIMITER = limiter([true, false]);
    const store = rateLimitStore({ binding: 'API_LIMITER' })({ API_LIMITER });
    expect(store.fixedLimits).toBe(true);

    await expect(store.increment('tenant:t-1:user:u-1', 10_000, 25, 'default')).resolves.toEqual({
      count: 0,
      ttlMs: 10_000,
      allowed: true,
    });
    await expect(store.increment('tenant:t-1:user:u-1', 10_000, 25, 'default')).resolves.toEqual({
      count: 26,
      ttlMs: 10_000,
      allowed: false,
    });
    expect(API_LIMITER.limit).toHaveBeenCalledWith({ key: 'tenant:t-1:user:u-1' });
  });

  it('routes each named throttler to its own binding', async () => {
    const BURST = limiter();
    const SUSTAINED = limiter();
    const store = rateLimitStore({ binding: { burst: 'BURST', sustained: 'SUSTAINED' } })({
      BURST,
      SUSTAINED,
    });
    await store.increment('k', 10_000, 5, 'burst');
    await store.increment('k', 60_000, 100, 'sustained');
    expect(BURST.limit).toHaveBeenCalledTimes(1);
    expect(SUSTAINED.limit).toHaveBeenCalledTimes(1);
    await expect(store.increment('k', 60_000, 1, 'other')).rejects.toThrow(
      "no rate limiting binding for throttler 'other'",
    );
  });

  it('fails closed for unsupported periods and unbounded keys', async () => {
    const API_LIMITER = limiter();
    const store = rateLimitStore({ binding: 'API_LIMITER', maxKeyBytes: 8 })({ API_LIMITER });
    await expect(store.increment('user', 30_000, 5, 'default')).rejects.toThrow('10 or 60 seconds');
    await expect(store.increment('oversized', 60_000, 5, 'default')).rejects.toThrow('oversized');
    expect(API_LIMITER.limit).not.toHaveBeenCalled();
  });

  it('rejects malformed platform decisions, missing bindings and unsupported resets', async () => {
    const store = rateLimitStore({ binding: 'API_LIMITER' })({
      API_LIMITER: { limit: async () => ({ success: 'yes' }) },
    });
    await expect(store.increment('user', 10_000, 5, 'default')).rejects.toThrow('invalid decision');
    expect(() => store.reset('user')).toThrow('do not support counter reset');

    const missing = rateLimitStore({ binding: 'API_LIMITER' })({});
    await expect(missing.increment('user', 10_000, 5, 'default')).rejects.toThrow(
      "ENV.API_LIMITER is not set: declare the rate limiter binding 'API_LIMITER' under ratelimits",
    );
    expect(() => rateLimitStore({ binding: '' })).toThrow('non-empty');
  });

  it('backs a static ThrottlerModule with each application ENV', async () => {
    @Controller('/limited')
    class Limited {
      @Get() read() {
        return { ok: true };
      }
      @Get('/stricter') @Throttle({ default: { limit: 1 } }) stricter() {
        return { ok: true };
      }
    }
    @Module({
      imports: [
        ThrottlerModule.forRoot({
          throttlers: [{ ttl: 60_000, limit: 100 }],
          storage: rateLimitStore({ binding: 'API_LIMITER' }),
        }),
      ],
      controllers: [Limited],
    })
    class App {}
    const envA = { API_LIMITER: limiter([true, false]) };
    const envB = { API_LIMITER: limiter([true]) };
    const a = await createCloudflareApp(App, { env: envA });
    const b = await createCloudflareApp(App, { env: envB });
    const request = () => new Request('https://worker.test/limited');
    expect((await a.fetch(request(), envA, ctx)).status).toBe(200);
    expect((await a.fetch(request(), envA, ctx)).status).toBe(429);
    expect((await b.fetch(request(), envB, ctx)).status).toBe(200);
    expect(envA.API_LIMITER.limit).toHaveBeenCalledTimes(2);
    expect(envB.API_LIMITER.limit).toHaveBeenCalledTimes(1);
    // The binding enforces its configured limit, so a route override fails loudly.
    const stricter = await b.fetch(new Request('https://worker.test/limited/stricter'), envB, ctx);
    expect(stricter.status).toBe(500);
    await Promise.all([a.close(), b.close()]);
  });
});
