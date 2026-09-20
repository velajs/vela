import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// REQUEST_CONTEXT must work under workerd without AsyncLocalStorage —
// per-request state is carried strictly through the Hono context + the
// per-request child container.

describe('REQUEST_CONTEXT under workerd', () => {
  it('issues a distinct id per request', async () => {
    const r1 = await SELF.fetch('http://example.com/req-ctx');
    const r2 = await SELF.fetch('http://example.com/req-ctx');
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const a = (await r1.json()) as { id: string; hasRawRequest: boolean };
    const b = (await r2.json()) as { id: string };
    expect(a.id).not.toBe(b.id);
    expect(a.hasRawRequest).toBe(true);
  });

  it('mirrors an inbound x-request-id header', async () => {
    const res = await SELF.fetch('http://example.com/req-ctx', {
      headers: { 'x-request-id': 'workerd-supplied-42' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe('workerd-supplied-42');
  });
});
