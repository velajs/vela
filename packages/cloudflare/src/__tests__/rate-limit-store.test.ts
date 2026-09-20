import { describe, expect, it, vi } from 'vitest';
import { cloudflareRateLimitStore } from '../rate-limit/cloudflare-rate-limit.store';

describe('cloudflareRateLimitStore', () => {
  it('uses the binding decision without inventing an exact remaining quota', async () => {
    const limit = vi
      .fn()
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false });
    const store = cloudflareRateLimitStore({ limit }, { limit: 25, periodSeconds: 10 });

    await expect(store.increment('tenant:t-1:user:u-1', 10_000)).resolves.toEqual({
      count: 0,
      ttlMs: 10_000,
      allowed: true,
      enforcedLimit: 25,
    });
    await expect(store.increment('tenant:t-1:user:u-1', 10_000)).resolves.toEqual({
      count: 26,
      ttlMs: 10_000,
      allowed: false,
      enforcedLimit: 25,
    });
    expect(limit).toHaveBeenCalledWith({ key: 'tenant:t-1:user:u-1' });
  });

  it('fails closed for mismatched periods and unbounded keys', async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });
    const store = cloudflareRateLimitStore(
      { limit },
      { limit: 5, periodSeconds: 60, maxKeyBytes: 8 },
    );

    await expect(store.increment('user', 10_000)).rejects.toThrow('period mismatch');
    await expect(store.increment('oversized', 60_000)).rejects.toThrow('oversized');
    expect(limit).not.toHaveBeenCalled();
  });

  it('rejects malformed platform decisions and unsupported resets', async () => {
    const store = cloudflareRateLimitStore(
      {
        limit: async () => ({ success: 'yes' }) as unknown as { success: boolean },
      },
      { limit: 5, periodSeconds: 10 },
    );

    await expect(store.increment('user', 10_000)).rejects.toThrow('invalid decision');
    expect(() => store.reset('user')).toThrow('do not support counter reset');
  });
});
