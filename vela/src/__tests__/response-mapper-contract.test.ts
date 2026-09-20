import { Context } from 'hono';
import { describe, expect, it } from 'vitest';
import { mapRedirect, mapResponse } from '../http/response-mapper';

function context(): Context {
  const context = new Context(new Request('http://localhost/'));
  context.header('x-prepared', 'retained');
  return context;
}

describe('HTTP response mapping contract', () => {
  it('passes prebuilt responses through without reinterpreting their status or body', () => {
    const response = new Response('transport owns this', { status: 202 });
    expect(mapResponse(context(), response, 101)).toBe(response);
  });

  it('keeps the default empty 204 and explicit empty 200 response distinct', async () => {
    const empty = mapResponse(context(), undefined);
    const explicit = mapResponse(context(), null, 200);
    expect(empty.status).toBe(204);
    expect(explicit.status).toBe(200);
    expect(empty.body).toBeNull();
    expect(explicit.body).toBeNull();
    expect(await explicit.text()).toBe('');
  });

  it('maps text and JSON primitives without assuming every JSON value is an object', async () => {
    const text = mapResponse(context(), 'hello', 201);
    expect(text.status).toBe(201);
    expect(text.headers.get('content-type')).toContain('text/plain');
    expect(await text.text()).toBe('hello');

    for (const value of [42, false, ['entry'], { nested: true }]) {
      const response = mapResponse(context(), value);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(response.headers.get('x-prepared')).toBe('retained');
      expect(await response.json()).toEqual(value);
    }
  });

  it('clears response bodies for contentless status codes', () => {
    for (const status of [204, 205, 304] satisfies Array<204 | 205 | 304>) {
      const response = mapResponse(context(), { ignored: true }, status);
      expect(response.status).toBe(status);
      expect(response.body).toBeNull();
      expect(response.headers.get('x-prepared')).toBe('retained');
    }
  });

  it('rejects statuses that Fetch cannot represent, including untyped callers', () => {
    expect(() => mapResponse(context(), 'upgrade', 101)).toThrow('transport-created Response');
    for (const status of [100, 199, 600, NaN, 200.5]) {
      expect(() => Reflect.apply(mapResponse, undefined, [context(), null, status])).toThrow(
        'integer from 200 to 599',
      );
    }
  });
});

describe('redirect mapping contract', () => {
  it('uses decorator defaults when the handler provides no redirect override', () => {
    for (const result of [undefined, null, {}, { url: 12 }]) {
      const response = mapRedirect(context(), result, { url: '/default', statusCode: 302 });
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/default');
    }
  });

  it('accepts URL-only overrides and validated dynamic status overrides', () => {
    const urlOnly = mapRedirect(
      context(),
      { url: '/custom' },
      { url: '/default', statusCode: 307 },
    );
    expect(urlOnly.status).toBe(307);
    expect(urlOnly.headers.get('location')).toBe('/custom');

    const overridden = mapRedirect(
      context(),
      { url: '/permanent', statusCode: 308 },
      { url: '/default', statusCode: 302 },
    );
    expect(overridden.status).toBe(308);
    expect(overridden.headers.get('location')).toBe('/permanent');
    expect(overridden.headers.get('x-prepared')).toBe('retained');
  });

  it('supports the complete redirect status set declared by Hono', () => {
    for (let status = 300; status <= 308; status++) {
      const response = mapRedirect(
        context(),
        { url: '/target', statusCode: status },
        { url: '/default', statusCode: 302 },
      );
      expect(response.status).toBe(status);
      expect(response.body).toBeNull();
    }
  });

  it('rejects invalid dynamic statuses instead of trusting the handler payload', () => {
    for (const statusCode of [200, 309, 302.5, NaN, Infinity, '302', null]) {
      expect(() =>
        mapRedirect(
          context(),
          { url: '/target', statusCode },
          { url: '/default', statusCode: 302 },
        ),
      ).toThrow('integer from 300 to 308');
    }
  });

  it('validates decorator metadata from untyped callers too', () => {
    expect(() =>
      Reflect.apply(mapRedirect, undefined, [
        context(),
        undefined,
        { url: '/target', statusCode: 200 },
      ]),
    ).toThrow('integer from 300 to 308');
  });
});
