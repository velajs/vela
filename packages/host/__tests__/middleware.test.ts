import { describe, expect, it } from 'vitest';
import { studioMiddleware } from '../src/middleware';
import type { StudioMiddlewareContext, StudioMiddlewareOptions } from '../src/middleware';

const MASTER = 'MASTER-ADMIN-SECRET-mw';

const ctx = (request: Request): StudioMiddlewareContext => ({ req: { raw: request } });

/** A recording `fetch`: proves whether the proxy forwarded, and with which bearer. */
function recordingFetch(): { calls: { authorization: string | null }[]; fetchImpl: typeof fetch } {
  const calls: { authorization: string | null }[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    calls.push({ authorization: new Headers(init?.headers).get('authorization') });
    return new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetchImpl };
}

/** A same-origin loopback admin GET (passes Host + CSRF gates once admitted). */
const adminRequest = (): Request =>
  new Request('http://localhost/_vela/admin/health', {
    headers: { host: 'localhost', 'sec-fetch-site': 'same-origin' },
  });

const baseOptions = (fetchImpl: typeof fetch): StudioMiddlewareOptions => ({
  workerOrigin: 'https://app.example.com',
  adminToken: MASTER,
  fetchImpl,
});

describe('studioMiddleware fail-closed peer verification', () => {
  it('rejects 403 and NEVER forwards the master token when no getRemoteAddress and no opt-out', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const mw = studioMiddleware(baseOptions(fetchImpl));
    let nextCalled = false;
    const res = await mw(ctx(adminRequest()), async () => {
      nextCalled = true;
    });
    expect(res?.status).toBe(403);
    expect(nextCalled).toBe(false);
    // The peer is unverifiable → the handler never ran → the token never left.
    expect(calls).toHaveLength(0);
  });

  it('passes when getRemoteAddress reports a loopback peer (peer verified)', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const mw = studioMiddleware({ ...baseOptions(fetchImpl), getRemoteAddress: () => '127.0.0.1' });
    const res = await mw(ctx(adminRequest()), async () => {});
    expect(res?.status).toBe(200);
    // Admitted → the proxy forwarded with the master bearer injected server-side.
    expect(calls).toEqual([{ authorization: `Bearer ${MASTER}` }]);
  });

  it('rejects when getRemoteAddress reports a NON-loopback peer', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const mw = studioMiddleware({
      ...baseOptions(fetchImpl),
      getRemoteAddress: () => '203.0.113.7',
    });
    const res = await mw(ctx(adminRequest()), async () => {});
    expect(res?.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('passes with the explicit loopbackOnly:false opt-out (caller owns the trust boundary)', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const mw = studioMiddleware({ ...baseOptions(fetchImpl), loopbackOnly: false });
    const res = await mw(ctx(adminRequest()), async () => {});
    expect(res?.status).toBe(200);
    expect(calls).toEqual([{ authorization: `Bearer ${MASTER}` }]);
  });
});
