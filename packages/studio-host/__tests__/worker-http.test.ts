import { afterEach, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { parseStudioConnection, parseTryItResponse } from '@velajs/studio-protocol';
import { startStudioServer } from '../src/server';
import type { StudioServer } from '../src/types';

let worker: Miniflare | undefined;
let host: StudioServer | undefined;
afterEach(async () => {
  await host?.close();
  await worker?.dispose();
});

describe('real Worker HTTP forwarding', () => {
  it('executes with native bindings/context over HTTP and keeps browser/admin/API credentials separate', async () => {
    worker = new Miniflare({
      workers: [
        {
          config: {
            name: 'api',
            type: 'worker',
            compatibilityDate: '2026-06-01',
            env: {
              MARKER: { type: 'text', value: 'native-env' },
              MASTER: { type: 'text', value: 'worker-admin-secret' },
              CACHE: { type: 'kv', id: 'cache' },
            },
            manifest: {
              mainModule: 'worker.js',
              modules: {
                'worker.js': {
                  type: 'esm',
                  contents: `export default {
        async fetch(request, env, ctx) {
          const url = new URL(request.url);
          if (url.pathname === '/custom/admin/rpc/api.authorizeTryIt') {
            if (request.headers.get('authorization') !== 'Bearer ' + env.MASTER || request.headers.has('cookie'))
              return new Response('unauthorized', { status: 401 });
            return Response.json({ ok: true, data: { authorized: true } });
          }
          if (url.pathname === '/redirect') return new Response(null, { status: 302, headers: { location: '/target' } });
          if (url.pathname === '/target') return new Response('redirect should not be followed', { status: 500 });
          await env.CACHE.put('last', url.pathname);
          ctx.waitUntil(env.CACHE.put('background', 'completed'));
          return Response.json({ marker: env.MARKER, saved: await env.CACHE.get('last'),
            method: request.method, query: url.searchParams.get('q'),
            authorization: request.headers.get('authorization'), cookie: request.headers.get('cookie'),
            body: await request.json() }, { status: 201, headers: { 'set-cookie': 'worker-session=private' } });
        }
      }`,
                },
              },
            },
          },
        },
      ],
    });
    const origin = await worker.ready;
    host = await startStudioServer({
      workerOrigin: origin.origin,
      adminPath: '/custom/admin',
      basePath: '/tools/studio',
      adminToken: 'worker-admin-secret',
      resolveFrom: import.meta.url,
    });
    const htmlResponse = await fetch(host.url);
    expect(htmlResponse.status).toBe(200);
    expect(htmlResponse.headers.get('cache-control')).toBe('no-store');
    const html = await htmlResponse.text();
    expect(html).not.toContain('worker-admin-secret');
    const serialized = html.match(/window\.__VELA_STUDIO__=(.*?);<\/script>/)?.[1];
    const connection = parseStudioConnection(JSON.parse(serialized ?? 'null'));
    expect(connection.adminBasePath).toBe('/custom/admin');
    expect(connection.routerBasePath).toBe('/tools/studio');
    const response = await fetch(new URL(connection.apiRequestPath, host.url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
        authorization: `Bearer ${connection.sessionToken}`,
        cookie: 'browser-session=private',
      },
      body: JSON.stringify({
        method: 'PATCH',
        path: '/users/a%20b',
        query: { q: 'hello' },
        headers: { authorization: 'Bearer API-USER', cookie: 'api-session=explicit' },
        body: { active: true },
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    const result = parseTryItResponse(await response.json());
    expect(result.status).toBe(201);
    expect(result.body).toEqual({
      marker: 'native-env',
      saved: '/users/a%20b',
      method: 'PATCH',
      query: 'hello',
      authorization: 'Bearer API-USER',
      cookie: 'api-session=explicit',
      body: { active: true },
    });
    const redirect = await fetch(new URL(connection.apiRequestPath, host.url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${connection.sessionToken}`,
      },
      body: JSON.stringify({ method: 'GET', path: '/redirect' }),
    });
    expect(parseTryItResponse(await redirect.json())).toMatchObject({
      status: 302,
      headers: { location: '/target' },
    });
  }, 20_000);
});
