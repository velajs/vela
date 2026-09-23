import { describe, expect, it } from 'vitest';
import { ENV } from '@velajs/vela';
import { ADMIN_BASE_PATH, DEV_TOKEN, createApp } from '../src/create-app';

async function capabilities(app: Awaited<ReturnType<typeof createApp>>, token: string) {
  const response = await app.getHonoApp().request(`${ADMIN_BASE_PATH}/rpc/studio.capabilities`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ args: {} }),
  });
  return response.status;
}

describe('createApp environment', () => {
  it('seeds ENV, and Studio reads VELA_STUDIO_TOKEN from it', async () => {
    const env = { VELA_STUDIO_TOKEN: 'token-from-env' };
    const app = await createApp({ env });
    try {
      expect(app.get(ENV)).toBe(env);
      expect(await capabilities(app, 'token-from-env')).toBe(200);
      expect(await capabilities(app, DEV_TOKEN)).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('falls back to the demo token without one, and an explicit token wins', async () => {
    const fallback = await createApp({ env: {} });
    const explicit = await createApp({
      env: { VELA_STUDIO_TOKEN: 'token-from-env' },
      token: 'explicit-token',
    });
    try {
      expect(await capabilities(fallback, DEV_TOKEN)).toBe(200);
      expect(await capabilities(explicit, 'explicit-token')).toBe(200);
      expect(await capabilities(explicit, 'token-from-env')).toBe(401);
    } finally {
      await fallback.close();
      await explicit.close();
    }
  });
});
