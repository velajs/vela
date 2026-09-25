import { describe, expect, it } from 'vitest';
import { Controller, Post, Module, VelaFactory } from '../../index';
import { SecurityModule, Secret } from '../../security/index';
import {
  getTrustedRequestIdentity,
  setTrustedRequestIdentity,
  setTrustedRequestTenant,
  createTrustedRequestIdentityStore,
} from '../../module-kit';

describe('security on native Workers', () => {
  it('honors missing-origin compatibility without permitting a hostile origin', async () => {
    @Controller('/security')
    class Routes {
      @Post()
      mutate() {
        return { ok: true };
      }
    }
    @Module({
      imports: [SecurityModule.forRoot({ originProtection: { allowMissingOrigin: true } })],
      controllers: [Routes],
    })
    class App {}
    const app = await VelaFactory.create(App);
    try {
      expect(
        (
          await app.fetch(
            new Request('https://app.invalid/security', {
              method: 'POST',
              headers: { cookie: 'session=test' },
            }),
          )
        ).status,
      ).toBe(201);
      expect(
        (
          await app.fetch(
            new Request('https://app.invalid/security', {
              method: 'POST',
              headers: { cookie: 'session=test', origin: 'https://evil.invalid' },
            }),
          )
        ).status,
      ).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('keeps attachment isolation and private redaction without Node APIs', () => {
    const request = new Request('https://app.invalid');
    const store = createTrustedRequestIdentityStore<Secret<string>>();
    const principal = { issuer: 'accounts', subject: 'alice', principalType: 'user' } as const;
    setTrustedRequestIdentity(request, { principal });
    store.set(request, new Secret('payload'));
    setTrustedRequestTenant(request, getTrustedRequestIdentity(request)!, 'tenant');
    expect(store.get(request)?.reveal()).toBe('payload');
    expect(JSON.stringify(store.get(request))).toBe('"[Redacted]"');
    expect(store.get(new Request(request))).toBeUndefined();
    setTrustedRequestIdentity(request, { principal });
    expect(store.get(request)).toBeUndefined();
  });
});
