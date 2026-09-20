import { describe, expect, it } from 'vitest';
import { createStudioHandler } from '../src/handler';
import { resolveOptions } from '../src/options';

function setup(fetchImpl: typeof fetch) {
  const options = resolveOptions({
    workerOrigin: 'http://127.0.0.1:8787',
    adminPath: '/api/management',
    adminToken: 'MASTER',
    fetchImpl,
  });
  const handler = createStudioHandler(options);
  const request = (args: unknown, token = options.sessionToken) =>
    handler(
      new Request('http://127.0.0.1:9999/api/management/api-request', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
          cookie: 'browser=private',
        },
        body: JSON.stringify(args),
      }),
      '127.0.0.1',
    );
  return { options, handler, request };
}

describe('host HTTP execution', () => {
  it('isolates browser cookies and Worker response cookies on the admin proxy too', async () => {
    let forwarded: Request | undefined;
    const { options, handler } = setup(async (input, init) => {
      forwarded = new Request(input, init);
      return Response.json({ ok: true }, { headers: { 'set-cookie': 'admin=private' } });
    });
    const response = await handler(
      new Request('http://127.0.0.1:9999/api/management/health', {
        headers: { authorization: `Bearer ${options.sessionToken}`, cookie: 'browser=private' },
      }),
      '127.0.0.1',
    );
    expect(forwarded?.headers.get('authorization')).toBe('Bearer MASTER');
    expect(forwarded?.headers.get('cookie')).toBeNull();
    expect(response?.headers.get('set-cookie')).toBeNull();
  });
  it('authorizes with the master token, forwards only explicit API credentials, and isolates response cookies', async () => {
    const requests: Request[] = [];
    const { request } = setup(async (input, init) => {
      const forwarded = new Request(input, init);
      requests.push(forwarded);
      if (forwarded.url.endsWith('/api.authorizeTryIt')) {
        return Response.json({ ok: true, data: { authorized: true } });
      }
      return Response.json(
        { saved: true },
        { status: 201, headers: { 'set-cookie': 'api=new; HttpOnly' } },
      );
    });
    const result = await request({
      method: 'POST',
      path: '/users/a%20b',
      query: { q: 'hello world' },
      headers: { authorization: 'Bearer USER', cookie: 'api=explicit' },
      body: { name: 'A' },
    });
    expect(result?.status).toBe(200);
    expect(requests).toHaveLength(2);
    expect(requests[0].headers.get('authorization')).toBe('Bearer MASTER');
    expect(requests[0].headers.get('cookie')).toBeNull();
    expect(requests[1].url).toBe('http://127.0.0.1:8787/users/a%20b?q=hello+world');
    expect(requests[1].headers.get('authorization')).toBe('Bearer USER');
    expect(requests[1].headers.get('cookie')).toBe('api=explicit');
    expect(requests[1].redirect).toBe('manual');
    expect(await requests[1].json()).toEqual({ name: 'A' });
    expect(result?.headers.get('set-cookie')).toBeNull();
    expect(await result?.json()).toMatchObject({
      status: 201,
      headers: { 'set-cookie': 'api=new; HttpOnly' },
    });
  });

  it('does not execute when the Worker gate is closed or the authorization reply is malformed', async () => {
    for (const response of [
      Response.json({ ok: false }, { status: 403 }),
      Response.json({ ok: true, data: {} }),
    ]) {
      let calls = 0;
      const { request } = setup(async () => {
        calls++;
        return response;
      });
      expect(
        (await request({ method: 'DELETE', path: '/users/1' }))?.status,
      ).toBeGreaterThanOrEqual(400);
      expect(calls).toBe(1);
    }
  });

  it('rejects missing/stale sessions, malformed input, external URLs and normalized admin paths before forwarding', async () => {
    let calls = 0;
    const { request, options } = setup(async () => {
      calls++;
      return Response.json({});
    });
    expect((await request({ method: 'GET', path: '/' }, 'stale'))?.status).toBe(403);
    for (const path of [
      'https://evil.example',
      '//evil.example',
      '/api/management/rpc/x',
      '/x/../api/management/health',
      '/api/%6danagement/health',
      '/api%2fmanagement/health',
    ]) {
      expect((await request({ method: 'GET', path }))?.status).toBeGreaterThanOrEqual(400);
    }
    expect(
      (
        await request({
          method: 'GET',
          path: '/',
          headers: { authorization: `Bearer ${options.sessionToken}` },
        })
      )?.status,
    ).toBe(400);
    expect(
      (await request({ method: 'GET', path: '/', headers: { host: 'evil.example' } }))?.status,
    ).toBe(400);
    expect(calls).toBe(0);
  });
});
