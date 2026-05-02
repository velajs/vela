import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// Live smoke tests for vela on the Cloudflare Workers runtime (workerd
// via miniflare). Validates the edge-runtime contract end-to-end —
// not just by static scan. The Worker entry at `./entry.ts` boots a
// real vela app inside workerd; every test below makes a real fetch.

describe('vela on Cloudflare Workers (live miniflare)', () => {
  it('boots and responds to a request', async () => {
    const res = await SELF.fetch('http://example.com/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('per-request DI scope works without AsyncLocalStorage', async () => {
    const r1 = await SELF.fetch('http://example.com/who-am-i', {
      headers: { 'x-user': 'alice' },
    });
    const r2 = await SELF.fetch('http://example.com/who-am-i', {
      headers: { 'x-user': 'bob' },
    });
    expect(await r1.json()).toEqual({ user: 'alice' });
    expect(await r2.json()).toEqual({ user: 'bob' });
  });

  it('handler chain executes in order: guard → pipe → interceptor → handler → response-interceptor', async () => {
    const res = await SELF.fetch('http://example.com/order-test');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { trace: string[] };
    expect(body.trace).toEqual([
      'guard',
      'pipe',
      'interceptor',
      'handler',
      'response-interceptor',
    ]);
  });

  it('OpenAPI document is mountable and served', async () => {
    const res = await SELF.fetch('http://example.com/docs.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      info: { title: string };
      paths: Record<string, unknown>;
    };
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.info.title).toBe('vela smoke');
    expect(doc.paths['/health']).toBeDefined();
  });
});
