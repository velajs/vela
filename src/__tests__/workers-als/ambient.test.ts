import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// Validates the opt-in ambient container on real workerd with nodejs_als.
describe('opt-in ambient container on Cloudflare Workers (nodejs_als)', () => {
  it('getCurrentRequestContext() resolves the correct per-request context from a singleton', async () => {
    const r1 = await SELF.fetch('http://example.com/ambient', { headers: { 'x-request-id': 'req-a' } });
    const r2 = await SELF.fetch('http://example.com/ambient', { headers: { 'x-request-id': 'req-b' } });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ id: 'req-a' });
    expect(await r2.json()).toEqual({ id: 'req-b' });
  });
});
