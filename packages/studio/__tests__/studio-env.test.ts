import { describe, expect, it } from 'vitest';
import { Module, VelaFactory, type VelaEnv } from '@velajs/vela';
import { createCloudflareApp } from '@velajs/cloudflare';
import { StudioModule, STUDIO_RESOLVED_CONFIG, readStudioEnv } from '../src';
import type { StudioModuleOptions } from '../src';

const BASE = '/_vela/admin';

function studioApp(options: StudioModuleOptions = {}) {
  @Module({ imports: [StudioModule.forRoot(options)] })
  class AppModule {}
  return AppModule;
}

function rpc(token: string): RequestInit {
  return {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  };
}

describe('Studio configuration from ENV', () => {
  it('reads VELA_STUDIO_* variables and secrets from the application ENV', async () => {
    const env = { VELA_STUDIO_TOKEN: 'env-token', VELA_STUDIO_DATA_EDITABLE: 'true' };
    const app = await VelaFactory.create(studioApp(), { env });
    const config = app.get(STUDIO_RESOLVED_CONFIG);

    expect(config.enabled).toBe(true);
    expect(config.token).toBe('env-token');
    expect(config.editable.data).toBe(true);
    expect(
      (await app.getHonoApp().request(`${BASE}/rpc/app.routes`, rpc('env-token'))).status,
    ).toBe(200);
    await app.close();
  });

  it('ignores non-string values instead of enabling Studio with them', () => {
    const env: VelaEnv = { VELA_STUDIO_TOKEN: 42, VELA_STUDIO_DATA_EDITABLE: true };
    expect(readStudioEnv(env)).toEqual({
      token: undefined,
      data: undefined,
      schema: undefined,
      ops: undefined,
      timeTravel: undefined,
      transfer: undefined,
    });
  });

  it('stays closed without a seeded ENV', async () => {
    const app = await VelaFactory.create(studioApp());
    expect(app.get(STUDIO_RESOLVED_CONFIG).enabled).toBe(false);
    await app.close();
  });

  it('lets module options override ENV values', async () => {
    const app = await VelaFactory.create(studioApp({ token: 'option-token', enabled: false }), {
      env: { VELA_STUDIO_TOKEN: 'env-token' },
    });
    const config = app.get(STUDIO_RESOLVED_CONFIG);
    expect(config.token).toBe('option-token');
    expect(config.enabled).toBe(false);
    await app.close();
  });

  it('takes the Studio token from the Cloudflare runtime environment', async () => {
    const env = { VELA_STUDIO_TOKEN: 'worker-secret' };
    const app = await createCloudflareApp(studioApp(), { env });
    const hono = app.getHonoApp();

    expect((await hono.request(`${BASE}/rpc/app.routes`, rpc('worker-secret'), env)).status).toBe(
      200,
    );
    expect((await hono.request(`${BASE}/rpc/app.routes`, rpc('wrong'), env)).status).toBe(401);
    await app.close();
  });
});
