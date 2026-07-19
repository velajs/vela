import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createStudioHandler } from '../src/handler';
import { resolveOptions } from '../src/options';
import { startStudioServer } from '../src/server';
import type { StudioServer } from '../src/types';

const FROM = import.meta.url;
const MASTER = 'MASTER-ADMIN-SECRET-9f3a';

/** A fake app origin that records every forwarded request. */
interface FakeOrigin {
  origin: string;
  requests: { url: string; method: string; authorization: string | undefined }[];
  close: () => Promise<void>;
}

async function startFakeOrigin(): Promise<FakeOrigin> {
  const requests: FakeOrigin['requests'] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests.push({
      url: req.url ?? '',
      method: req.method ?? '',
      authorization: req.headers.authorization,
    });
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true, enabled: true, echo: req.url }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const servers: StudioServer[] = [];
const origins: FakeOrigin[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all(origins.splice(0).map((o) => o.close()));
});

// ---------------------------------------------------------------------------
// The security crux: the token-injection proxy, tested via the handler core so
// the browser-supplied Authorization can be inspected deterministically.
// ---------------------------------------------------------------------------
describe('token-injection proxy (security crux)', () => {
  it('injects the MASTER bearer server-side, overwriting the browser value, and forwards to the app', async () => {
    let captured: { url: string; authorization: string | null } | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      captured = {
        url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        authorization: new Headers(init?.headers).get('authorization'),
      };
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const resolved = resolveOptions({
      workerOrigin: 'https://app.example.com',
      adminToken: MASTER,
      fetchImpl,
    });
    const handle = createStudioHandler(resolved);

    const res = await handle(
      new Request('http://127.0.0.1:9999/_vela/admin/rpc/listRows', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
          // The browser never legitimately holds the master token; even a forged
          // Authorization must be discarded and replaced server-side.
          authorization: 'Bearer BROWSER-FORGED-JUNK',
        },
        body: '{"args":{}}',
      }),
      '127.0.0.1',
    );

    expect(res?.status).toBe(200);
    expect(captured?.authorization).toBe(`Bearer ${MASTER}`);
    expect(captured?.url).toBe('https://app.example.com/_vela/admin/rpc/listRows');
  });

  it('returns 502 (never 5xx-crash) when the app origin is unreachable', async () => {
    const resolved = resolveOptions({
      workerOrigin: 'http://127.0.0.1:1', // nothing listening
      adminToken: MASTER,
    });
    const handle = createStudioHandler(resolved);
    const res = await handle(
      new Request('http://127.0.0.1:9999/_vela/admin/health', {
        headers: { 'sec-fetch-site': 'same-origin' },
      }),
      '127.0.0.1',
    );
    expect(res?.status).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// Security-gate matrix — every gate answers 403.
// ---------------------------------------------------------------------------
describe('security-gate matrix (all → 403)', () => {
  const handle = createStudioHandler(
    resolveOptions({
      workerOrigin: 'http://127.0.0.1:1',
      adminToken: MASTER,
      fetchImpl: async () => new Response(''),
    }),
  );

  it('rejects a non-loopback socket peer', async () => {
    const res = await handle(new Request('http://127.0.0.1/'), '203.0.113.7');
    expect(res?.status).toBe(403);
  });
  it('rejects a non-localhost Host header (DNS rebind)', async () => {
    const res = await handle(
      new Request('http://127.0.0.1/', { headers: { host: 'attacker.example.com' } }),
      '127.0.0.1',
    );
    expect(res?.status).toBe(403);
  });
  it('rejects an X-Forwarded-* request (proxy front)', async () => {
    const res = await handle(
      new Request('http://127.0.0.1/', { headers: { 'x-forwarded-for': '1.2.3.4' } }),
      '127.0.0.1',
    );
    expect(res?.status).toBe(403);
  });
  it('rejects a cross-site proxied POST (CSRF)', async () => {
    const res = await handle(
      new Request('http://127.0.0.1/_vela/admin/rpc/deleteRows', {
        method: 'POST',
        headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
        body: '{}',
      }),
      '127.0.0.1',
    );
    expect(res?.status).toBe(403);
  });
  it('rejects a non-JSON proxied POST (CSRF content-type)', async () => {
    const res = await handle(
      new Request('http://127.0.0.1/_vela/admin/rpc/deleteRows', {
        method: 'POST',
        headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'text/plain' },
        body: 'x',
      }),
      '127.0.0.1',
    );
    expect(res?.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: a real loopback server + a real fake app origin.
// ---------------------------------------------------------------------------
describe('startStudioServer (end-to-end over a real socket)', () => {
  it('serves the SPA shell and never leaks the master token to the browser', async () => {
    const origin = await startFakeOrigin();
    origins.push(origin);
    const server = await startStudioServer({
      workerOrigin: origin.origin,
      adminToken: MASTER,
      editable: true,
      resolveFrom: FROM,
    });
    servers.push(server);

    const res = await fetch(server.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('window.__VELA_BASE_PATH__');
    expect(html).toContain('<script type="module" src="/studio.js">');
    // The master admin token must NEVER appear in the browser-facing document.
    expect(html).not.toContain(MASTER);
    // A NON-secret session token is injected for auto-auth (editable opt-in).
    expect(html).toContain('window.__VELA_ADMIN_TOKEN__');
  });

  it('serves the built studio.js bundle and a code-split chunk', async () => {
    const origin = await startFakeOrigin();
    origins.push(origin);
    const server = await startStudioServer({ workerOrigin: origin.origin, resolveFrom: FROM });
    servers.push(server);

    const entry = await fetch(new URL('/studio.js', server.url));
    expect(entry.status).toBe(200);
    expect(entry.headers.get('content-type')).toContain('javascript');
    const body = await entry.text();
    const chunkMatch = body.match(/chunk-[A-Z0-9]+\.js/);
    expect(chunkMatch).not.toBeNull();
    const chunk = await fetch(new URL(`/${chunkMatch?.[0] ?? ''}`, server.url));
    expect(chunk.status).toBe(200);
  });

  it('rejects a non-JSON proxied POST end-to-end (CSRF) with 403', async () => {
    const origin = await startFakeOrigin();
    origins.push(origin);
    const server = await startStudioServer({
      workerOrigin: origin.origin,
      adminToken: MASTER,
      resolveFrom: FROM,
    });
    servers.push(server);
    const res = await fetch(new URL('/_vela/admin/rpc/deleteRows', server.url), {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' },
      body: 'x',
    });
    expect(res.status).toBe(403);
    // The gate fired BEFORE any forward — the app origin saw nothing.
    expect(origin.requests).toHaveLength(0);
  });

  it('proxies an admin request with the master bearer injected server-side', async () => {
    const origin = await startFakeOrigin();
    origins.push(origin);
    const server = await startStudioServer({
      workerOrigin: origin.origin,
      adminToken: MASTER,
      resolveFrom: FROM,
    });
    servers.push(server);

    const res = await fetch(new URL('/_vela/admin/health', server.url), {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(res.status).toBe(200);
    expect(origin.requests).toHaveLength(1);
    expect(origin.requests[0].url).toBe('/_vela/admin/health');
    expect(origin.requests[0].authorization).toBe(`Bearer ${MASTER}`);
  });
});
