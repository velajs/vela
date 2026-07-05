import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// Live workerd (miniflare) validation of THIS session's new surfaces, under the
// bare edge-runtime contract (no nodejs_compat — see wrangler.toml).

describe('vela session features on Cloudflare Workers (live miniflare)', () => {
  it('request-scope bubbling rebuilds a singleton controller per request (from @Inject metadata only)', async () => {
    const r1 = await SELF.fetch('http://example.com/bubble');
    const r2 = await SELF.fetch('http://example.com/bubble');
    const n1 = ((await r1.json()) as { n: number }).n;
    const n2 = ((await r2.json()) as { n: number }).n;
    // Fresh request-scoped counter each request → strictly incrementing.
    expect(n2).toBe(n1 + 1);
  });

  it('i18n (intl-messageformat) bundles and runs under workerd, honoring Accept-Language', async () => {
    const en = await SELF.fetch('http://example.com/i18n', { headers: { 'accept-language': 'en' } });
    expect(await en.json()).toEqual({ msg: 'Hello, Ada!', locale: 'en' });

    const fr = await SELF.fetch('http://example.com/i18n', { headers: { 'accept-language': 'fr' } });
    expect(await fr.json()).toEqual({ msg: 'Bonjour, Ada !', locale: 'fr' });
  });

  it('storage HMAC signing/verification works with Web Crypto under workerd', async () => {
    const res = await SELF.fetch('http://example.com/sign-check');
    expect(await res.json()).toEqual({ valid: true, tampered: false });
  });

  it('named-route signed URL round-trips through UrlGeneratorService + SignedUrlGuard under workerd', async () => {
    // UrlGeneratorService.signedUrl builds + signs the named route with Web Crypto.
    const gen = await SELF.fetch('http://example.com/signed/make');
    const { url } = (await gen.json()) as { url: string };
    expect(url).toMatch(/^\/signed\/protected\?expires=\d+&signature=/);

    // The SignedUrlGuard verifies that signature → 200.
    const ok = await SELF.fetch(`http://example.com${url}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });

    // Flipping the last signature char is rejected → 403.
    const tampered = url.slice(0, -1) + (url.endsWith('A') ? 'B' : 'A');
    const bad = await SELF.fetch(`http://example.com${tampered}`);
    expect(bad.status).toBe(403);
  });
});
