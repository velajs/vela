import { Module, VelaFactory, type VelaApplication } from '@velajs/vela';
import { createWebSocketUpgradeGate, type UpgradeAuthenticator } from '@velajs/vela/websocket';
import { beforeAll, describe, expect, it } from 'vitest';
import { cloudflareAccessIssuer } from '../issuer';
import { CloudflareAccessModule, CloudflareAccessUpgradeAuthenticator } from '../vela';
import { makeKeyMaterial, mintToken, type TestKeyMaterial } from './harness';

const preset = cloudflareAccessIssuer('acme');
const AUD = 'app-audience-tag';
const EXPIRES_AT = Math.floor(Date.now() / 1000) + 300;

let keys: TestKeyMaterial;
beforeAll(async () => {
  keys = await makeKeyMaterial();
});

const token = (claims: Record<string, unknown>): Promise<string> =>
  mintToken({
    privateKey: keys.privateKey,
    kid: keys.kid,
    issuer: preset.issuer,
    audience: AUD,
    subject: 'user-1',
    claims,
    expiresAt: EXPIRES_AT,
  });

const upgrade = (jwt?: string): Request =>
  new Request('https://api.test/rooms/alpha/ws', {
    headers: jwt === undefined ? {} : { [preset.header]: jwt },
  });

async function application(): Promise<VelaApplication> {
  @Module({ imports: [CloudflareAccessModule.forRoot({ preset, aud: AUD, keySet: keys.jwks })] })
  class AppModule {}
  return VelaFactory.create(AppModule);
}

describe('CloudflareAccessUpgradeAuthenticator', () => {
  it('turns a verified Access token with a tenant claim into the upgrade identity', async () => {
    const app = await application();
    try {
      const authenticator: UpgradeAuthenticator = await app
        .getContainer()
        .construct(CloudflareAccessUpgradeAuthenticator);

      const identity = await authenticator.authenticate(
        upgrade(await token({ email: 'ada@example.test', tenantId: 'tenant-7' })),
        { gatewayPath: '/rooms/:room/ws', room: 'alpha' },
      );

      expect(identity).toEqual({
        principal: { issuer: preset.issuer, subject: 'user-1', principalType: 'user' },
        tenantId: 'tenant-7',
        expiresAtMs: EXPIRES_AT * 1000,
      });
    } finally {
      await app.close();
    }
  });

  it('refuses upgrades without a token, without a tenant, or with a foreign audience', async () => {
    const app = await application();
    try {
      const authenticate = createWebSocketUpgradeGate(app.getContainer(), {
        options: { path: '/rooms/:room/ws', authenticator: CloudflareAccessUpgradeAuthenticator },
      });
      const foreign = await mintToken({
        privateKey: keys.privateKey,
        kid: keys.kid,
        issuer: preset.issuer,
        audience: 'another-application',
        subject: 'user-1',
        claims: { tenantId: 'tenant-7' },
      });

      expect(await authenticate(upgrade(), 'alpha')).toBe(false);
      expect(await authenticate(upgrade(await token({ email: 'ada@example.test' })), 'alpha')).toBe(
        false,
      );
      expect(await authenticate(upgrade(foreign), 'alpha')).toBe(false);
      expect(await authenticate(upgrade(await token({ tenantId: 'tenant-7' })), 'alpha')).toEqual(
        expect.objectContaining({
          identity: expect.objectContaining({ tenantId: 'tenant-7' }),
        }),
      );
    } finally {
      await app.close();
    }
  });
});
