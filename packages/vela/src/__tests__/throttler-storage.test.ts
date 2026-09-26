import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_GUARD, Controller, Get, Module, VelaFactory } from '../index.js';
import { ThrottlerGuard, ThrottlerModule, ThrottlerStorage } from '../throttler/index.js';

const MINUTE = 60_000;
const TEN_MINUTES = 10 * MINUTE;

describe('ThrottlerStorage (in-memory)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a counter for its whole window, however long, while other keys come and go', () => {
    const storage = new ThrottlerStorage();
    expect(storage.increment('client-a', TEN_MINUTES)).toEqual({ count: 1, ttlMs: TEN_MINUTES });
    expect(storage.increment('client-a', TEN_MINUTES).count).toBe(2);

    // Other traffic for several minutes: the counter of client-a is untouched,
    // yet it must not reset before its own ten-minute window ends.
    for (let minute = 1; minute <= 9; minute++) {
      vi.advanceTimersByTime(MINUTE);
      storage.increment(`other-${minute}`, 10_000);
    }
    expect(storage.increment('client-a', TEN_MINUTES)).toEqual({ count: 3, ttlMs: MINUTE });

    // The window ends: the next request opens a new one.
    vi.advanceTimersByTime(MINUTE);
    expect(storage.increment('client-a', TEN_MINUTES)).toEqual({ count: 1, ttlMs: TEN_MINUTES });
  });

  it('evicts windows once they expire, so the bound applies to open windows only', () => {
    const storage = new ThrottlerStorage({ maxKeys: 2 });
    storage.increment('a', 1_000);
    storage.increment('b', 1_000);
    vi.advanceTimersByTime(1_000);
    // Both windows ended: the two new keys take their slots.
    expect(storage.increment('c', 1_000).count).toBe(1);
    expect(storage.increment('d', 1_000).count).toBe(1);
  });

  it('refuses a new key while every tracked window is open, instead of evicting a live counter', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const storage = new ThrottlerStorage({ maxKeys: 2 });
      storage.increment('a', TEN_MINUTES);
      vi.advanceTimersByTime(MINUTE);
      storage.increment('b', TEN_MINUTES);

      // Full of open windows: the new key is over-counted (refused) until a
      // slot frees, and it is told when that happens.
      const refused = storage.increment('c', TEN_MINUTES, 5, 'default');
      expect(refused.count).toBeGreaterThan(5);
      expect(refused.ttlMs).toBe(TEN_MINUTES - MINUTE);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('maxKeys (2)');
      storage.increment('c', TEN_MINUTES, 5, 'default');
      expect(warn).toHaveBeenCalledTimes(1);

      // The tracked counters kept counting throughout.
      expect(storage.increment('a', TEN_MINUTES).count).toBe(2);
      expect(storage.increment('b', TEN_MINUTES).count).toBe(2);

      // The first window ends and frees its slot.
      vi.advanceTimersByTime(TEN_MINUTES - MINUTE);
      expect(storage.increment('c', TEN_MINUTES, 5, 'default')).toEqual({
        count: 1,
        ttlMs: TEN_MINUTES,
      });
      expect(storage.increment('b', TEN_MINUTES).count).toBe(3);
    } finally {
      warn.mockRestore();
    }
  });

  it('forgets a key on reset', () => {
    const storage = new ThrottlerStorage({ maxKeys: 1 });
    storage.increment('a', TEN_MINUTES);
    storage.reset('a');
    expect(storage.increment('b', TEN_MINUTES).count).toBe(1);
    expect(storage.increment('a', TEN_MINUTES, 1, 'default').count).toBeGreaterThan(1);
  });

  it('rejects a bound that is not a positive integer', () => {
    expect(() => new ThrottlerStorage({ maxKeys: 0 })).toThrow(
      'ThrottlerStorage maxKeys must be a positive integer',
    );
    expect(() => new ThrottlerStorage({ maxKeys: Number.POSITIVE_INFINITY })).toThrow(
      'ThrottlerStorage maxKeys must be a positive integer',
    );
  });

  it('enforces a ten-minute limit through ThrottlerModule past the old two-minute horizon', async () => {
    @Controller('/limited')
    class Limited {
      @Get() read() {
        return { ok: true };
      }
      @Get('/other') other() {
        return { ok: true };
      }
    }
    @Module({
      providers: [{ provide: APP_GUARD, useExisting: ThrottlerGuard }],
      imports: [ThrottlerModule.forRoot({ throttlers: [{ ttl: TEN_MINUTES, limit: 2 }] })],
      controllers: [Limited],
    })
    class App {}
    const app = await VelaFactory.create(App);
    try {
      const hono = app.getHonoApp();
      expect((await hono.request('/limited')).status).toBe(200);
      expect((await hono.request('/limited')).status).toBe(200);
      // Traffic on another route in between, as a busy application has.
      vi.advanceTimersByTime(2 * MINUTE);
      expect((await hono.request('/limited/other')).status).toBe(200);
      vi.advanceTimersByTime(3 * MINUTE);
      expect((await hono.request('/limited/other')).status).toBe(200);
      const blocked = await hono.request('/limited');
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('Retry-After')).toBe('300');
      vi.advanceTimersByTime(5 * MINUTE);
      expect((await hono.request('/limited')).status).toBe(200);
    } finally {
      await app.close();
    }
  });
});
