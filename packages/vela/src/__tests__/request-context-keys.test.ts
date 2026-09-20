import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createRequestContext, RequestContextKey } from '../http/request-context';

describe('request context keys', () => {
  it('keeps typed values request-local and separates keys with identical descriptions', async () => {
    const text = new RequestContextKey<string>('value');
    const count = new RequestContextKey<number>('value');
    const optional = new RequestContextKey<string | undefined>('optional');
    const app = new Hono();
    app.get('/', (c) => {
      const context = createRequestContext(c);
      expect(context.has(text)).toBe(false);
      expect(context.get(text)).toBeUndefined();
      expect(context.get(count)).toBeUndefined();

      context.set(text, 'hello');
      context.set(count, 42);
      context.set(optional, undefined);
      expect(context.get(text)).toBe('hello');
      expect(context.get(count)).toBe(42);
      expect(context.has(optional)).toBe(true);
      expect(context.get(optional)).toBeUndefined();
      expect(context.get('value')).toBeUndefined();
      return c.text('ok');
    });

    const results = await Promise.all([app.request('/'), app.request('/')]);
    expect(await Promise.all(results.map((response) => response.text()))).toEqual(['ok', 'ok']);
  });

  it('retains raw string and symbol values as unknown without aliasing typed keys', async () => {
    const key = new RequestContextKey<string>('raw');
    const symbol = Symbol('raw');
    const app = new Hono();
    app.get('/', (c) => {
      const context = createRequestContext(c);
      context.set('raw', { value: 1 });
      context.set(symbol, ['raw']);
      context.set(key, 'typed');
      expect(context.get('raw')).toEqual({ value: 1 });
      expect(context.get(symbol)).toEqual(['raw']);
      expect(context.get(key)).toBe('typed');
      expect(context.has('raw')).toBe(true);
      expect(context.has(symbol)).toBe(true);
      return c.text('ok');
    });
    expect((await app.request('/')).status).toBe(200);
  });
});
