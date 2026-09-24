import { describe, expect, it, vi } from 'vitest';
import { Controller, Get, Module, type Type } from '@velajs/vela';
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

  it('refuses throttlers with different limits or windows on one binding', async () => {
    const API_LIMITER = limiter();
    const store = rateLimitStore({ binding: 'API_LIMITER' })({ API_LIMITER });
    await store.increment('a', 10_000, 3, 'short');
    // Another throttler with the same limit and window can share the binding.
    await store.increment('b', 10_000, 3, 'twin');
    await expect(store.increment('c', 60_000, 1_000, 'long')).rejects.toThrow(
      "one binding enforces one limit and period: throttlers 'short' (3 per 10000ms) and 'long' (1000 per 60000ms)",
    );
    expect(API_LIMITER.limit).toHaveBeenCalledTimes(2);
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
    const limited = (controller: Type) => {
      @Module({
        imports: [
          ThrottlerModule.forRoot({
            throttlers: [{ ttl: 60_000, limit: 100 }],
            storage: rateLimitStore({ binding: 'API_LIMITER' }),
          }),
        ],
        controllers: [controller],
      })
      class App {}
      return App;
    };
    @Controller('/limited')
    class Limited {
      @Get() read() {
        return { ok: true };
      }
    }
    const App = limited(Limited);
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
    await Promise.all([a.close(), b.close()]);

    // The binding enforces its configured limit, so a route override fails the bootstrap.
    @Controller('/limited')
    class Stricter {
      @Get() @Throttle({ default: { limit: 1 } }) read() {
        return { ok: true };
      }
    }
    await expect(createCloudflareApp(limited(Stricter), { env: envB })).rejects.toThrow(
      '@Throttle() on Stricter.read cannot change them',
    );
  });
});
