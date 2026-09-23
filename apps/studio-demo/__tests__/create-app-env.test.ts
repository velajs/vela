import { describe, expect, it } from 'vitest';
import { ENV } from '@velajs/vela';
import { countRegisteredClasses } from '@velajs/vela/internal';
import { ADMIN_BASE_PATH, DEV_TOKEN, MODEL_IDS, createApp } from '../src/create-app';

async function rpc(
  app: Awaited<ReturnType<typeof createApp>>,
  token: string,
  op: string,
  args: Record<string, unknown> = {},
): Promise<Response> {
  return app.getHonoApp().request(`${ADMIN_BASE_PATH}/rpc/${op}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ args }),
  });
}

async function capabilities(app: Awaited<ReturnType<typeof createApp>>, token: string) {
  return (await rpc(app, token, 'studio.capabilities')).status;
}

async function tagLabel(app: Awaited<ReturnType<typeof createApp>>): Promise<unknown> {
  const response = await rpc(app, DEV_TOKEN, 'data.readRow', { model: MODEL_IDS.tag, id: 't1' });
  const body: unknown = await response.json();
  const row: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'data') : null;
  return typeof row === 'object' && row !== null ? Reflect.get(row, 'label') : undefined;
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

  it('declares no classes when it builds another application, each with its own store', async () => {
    const first = await createApp({ env: {} });
    const before = countRegisteredClasses();
    const second = await createApp({ env: {} });
    try {
      expect(countRegisteredClasses()).toBe(before);
      const patch = { model: MODEL_IDS.tag, id: 't1', patch: { label: 'changed' } };
      expect((await rpc(first, DEV_TOKEN, 'data.writeRow', patch)).status).toBe(200);
      expect(await tagLabel(first)).toBe('changed');
      expect(await tagLabel(second)).toBe('fiction');
    } finally {
      await first.close();
      await second.close();
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
