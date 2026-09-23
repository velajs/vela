import { describe, expect, it } from 'vitest';
import { AdminClient, AdminError } from '../src/client/admin-client';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('AdminClient', () => {
  it.each([
    [{ ok: 'true', op: 'app.routes', data: [] }, 200],
    [
      { ok: true, op: 'app.modules', data: [], meta: { ms: 1, op: 'app.modules', mode: 'read' } },
      200,
    ],
    [
      {
        ok: true,
        op: 'app.routes',
        data: [{ method: 'GET', path: 123, handler: 'X', source: 'controller' }],
        meta: { ms: 1, op: 'app.routes', mode: 'read' },
      },
      200,
    ],
    [
      { ok: true, op: 'app.routes', data: [], meta: { ms: 1, op: 'app.routes', mode: 'read' } },
      500,
    ],
    [
      {
        ok: false,
        op: 'app.routes',
        status: 403,
        error: { code: 'X', title: 'Error', message: 7, status: 403 },
      },
      403,
    ],
    [
      {
        ok: false,
        op: 'app.routes',
        status: 403,
        error: { code: 'X', title: 'Error', message: 'Error', status: 403 },
      },
      401,
    ],
  ] as const)('rejects malformed wire responses %#', async (payload, status) => {
    const client = new AdminClient({
      baseUrl: 'http://host',
      fetchImpl: async () => jsonResponse(payload, status),
    });
    await expect(client.rpc('app.routes', {})).rejects.toMatchObject({
      code: 'STUDIO_BAD_RESPONSE',
      status,
    });
  });

  it('unwraps an ok envelope to its data', async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        ok: true,
        op: 'app.routes',
        data: [{ method: 'GET', path: '/x', handler: 'X#y', source: 'controller' }],
        meta: { ms: 1, op: 'app.routes', mode: 'read' },
      })) as typeof fetch;
    const client = new AdminClient({ baseUrl: 'http://host', fetchImpl });
    const data = await client.rpc('app.routes', {});
    expect(data).toHaveLength(1);
    expect(data[0]?.path).toBe('/x');
  });

  it('throws an AdminError carrying body.hint/docsUrl and status on an error envelope', async () => {
    const fetchImpl = (async () =>
      jsonResponse(
        {
          ok: false,
          op: 'data.listRows',
          error: {
            code: 'STUDIO_OP_FORBIDDEN',
            title: 'Forbidden',
            status: 403,
            message: 'Read-only Studio.',
            hint: 'Enable dataEditable.',
            docsUrl: 'https://vela.dev/errors/forbidden',
          },
          status: 403,
        },
        403,
      )) as typeof fetch;
    const client = new AdminClient({ baseUrl: 'http://host', fetchImpl });
    await expect(client.rpc('data.listRows', { model: 'user' })).rejects.toBeInstanceOf(AdminError);
    try {
      await client.rpc('data.listRows', { model: 'user' });
      expect.unreachable('should have thrown');
    } catch (err) {
      const adminError = err as AdminError;
      expect(adminError.status).toBe(403);
      expect(adminError.body.hint).toBe('Enable dataEditable.');
      expect(adminError.docsUrl).toBe('https://vela.dev/errors/forbidden');
      expect(adminError.code).toBe('STUDIO_OP_FORBIDDEN');
    }
  });

  it('sends without an Authorization header when no token is set (server decides)', async () => {
    let sentAuth: string | null = 'unset';
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      sentAuth = headers.get('authorization');
      return jsonResponse({
        ok: true,
        op: 'app.routes',
        data: [],
        meta: { ms: 1, op: 'app.routes', mode: 'read' },
      });
    }) as typeof fetch;
    const client = new AdminClient({ baseUrl: 'http://host', fetchImpl });
    await client.rpc('app.routes', {});
    expect(sentAuth).toBeNull();
  });

  it('attaches a Bearer token once set', async () => {
    let sentAuth: string | null = null;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentAuth = new Headers(init?.headers).get('authorization');
      return jsonResponse({
        ok: true,
        op: 'app.modules',
        data: [],
        meta: { ms: 1, op: 'app.modules', mode: 'read' },
      });
    }) as typeof fetch;
    const client = new AdminClient({ baseUrl: 'http://host', adminToken: 'secret', fetchImpl });
    await client.rpc('app.modules', {});
    expect(sentAuth).toBe('Bearer secret');
    client.setToken(undefined);
    await client.rpc('app.modules', {});
    expect(sentAuth).toBeNull();
  });

  it('maps an aborted signal to an AdminError', async () => {
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return jsonResponse({
        ok: true,
        op: 'app.routes',
        data: [],
        meta: { ms: 1, op: 'app.routes', mode: 'read' },
      });
    }) as typeof fetch;
    const client = new AdminClient({ baseUrl: 'http://host', fetchImpl });
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.rpc('app.routes', {}, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(AdminError);
  });

  it('wraps a non-JSON response in a synthetic AdminError', async () => {
    const fetchImpl = (async () =>
      new Response('<html>502 Bad Gateway</html>', { status: 502 })) as typeof fetch;
    const client = new AdminClient({ baseUrl: 'http://host', fetchImpl });
    try {
      await client.rpc('app.routes', {});
      expect.unreachable('should have thrown');
    } catch (err) {
      const adminError = err as AdminError;
      expect(adminError).toBeInstanceOf(AdminError);
      expect(adminError.code).toBe('STUDIO_BAD_RESPONSE');
      expect(adminError.status).toBe(502);
    }
  });

  it('health() reports enabled + protocolVersion', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ enabled: true, protocolVersion: 3 }), {
        status: 200,
      })) as typeof fetch;
    const client = new AdminClient({ baseUrl: 'http://host', fetchImpl });
    await expect(client.health()).resolves.toEqual({ enabled: true, protocolVersion: 3 });
  });

  it('health() rejects an application on the protocol before the scope rename', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ enabled: true, protocolVersion: 2 }), {
        status: 200,
      })) as typeof fetch;
    const client = new AdminClient({ baseUrl: 'http://host', fetchImpl });
    await expect(client.health()).rejects.toMatchObject({ code: 'STUDIO_BAD_RESPONSE' });
  });
});
