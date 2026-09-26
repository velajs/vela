import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';

// Exercise the built portable root and optional subpath in workerd, without
// nodejs_compat, against Miniflare's native Secrets Store implementation.
test('Secrets Store material supports rotation, immutable IDs and retry in Workers', async () => {
  const mf = new Miniflare({
    workers: [
      {
        config: {
          name: 'crypto-secrets-test',
          type: 'worker',
          compatibilityDate: '2026-09-20',
          manifest: {
            mainModule: 'worker.js',
            modules: {
              'worker.js': {
                type: 'esm',
                contents: `
        import { CryptoService } from './index.js';
        import { SecretsStoreKeyProvider } from './cloudflare/index.js';
        const services = new WeakMap();
        const context = { namespace: 'documents', purpose: 'content' };
        export default { async fetch(request, env) {
          let rings = services.get(env);
          if (!rings) {
            rings = {
              old: new CryptoService(new SecretsStoreKeyProvider({ activeKeyId: 'v1', keys: { v1: env.KEY_V1 } })),
              rotated: new CryptoService(new SecretsStoreKeyProvider({ activeKeyId: 'v2', keys: { v1: env.KEY_V1, v2: env.KEY_V2 } })),
              retired: new CryptoService(new SecretsStoreKeyProvider({ activeKeyId: 'v2', keys: { v2: env.KEY_V2 } })),
            };
            services.set(env, rings);
          }
          const [ring, operation] = new URL(request.url).pathname.slice(1).split('/');
          try {
            return new Response(await rings[ring][operation](await request.text(), context));
          } catch (error) { return new Response(error.message, { status: 503 }); }
        }};
      `,
              },
              'index.js': {
                type: 'esm',
                contents: await readFile(new URL('../dist/index.js', import.meta.url), 'utf8'),
              },
              'cloudflare/index.js': {
                type: 'esm',
                contents: await readFile(
                  new URL('../dist/cloudflare/index.js', import.meta.url),
                  'utf8',
                ),
              },
            },
          },
          env: {
            KEY_V1: { type: 'secrets-store-secret', storeId: 'test-store', secretName: 'key-v1' },
            KEY_V2: { type: 'secrets-store-secret', storeId: 'test-store', secretName: 'key-v2' },
          },
        },
      },
    ],
  });
  try {
    const admin1 = (await mf.getSecretsStoreSecretAPI('KEY_V1'))();
    const admin2 = (await mf.getSecretsStoreSecretAPI('KEY_V2'))();
    const key1 = Buffer.alloc(32, 1).toString('base64url');
    const key2 = Buffer.alloc(32, 2).toString('base64url');
    const id1 = await admin1.create(key1);
    await admin2.create(key2);
    const call = async (route, body) =>
      mf.dispatchFetch('https://worker.test/' + route, { method: 'POST', body });
    const sealed = await call('old/encryptText', 'synthetic text');
    assert.equal(sealed.status, 200);
    const original = await sealed.text();
    assert.equal(await (await call('rotated/decryptText', original)).text(), 'synthetic text');
    const rotated = await (await call('rotated/reencrypt', original)).text();
    assert.equal(await (await call('retired/decryptText', rotated)).text(), 'synthetic text');
    assert.equal((await call('retired/decryptText', original)).status, 503);
    await admin1.update(key2, id1);
    const changed = await call('old/encryptText', 'synthetic text');
    assert.equal(changed.status, 503);
    assert.equal(await changed.text(), 'Secrets Store wrapping key could not be loaded');
    await admin1.update(key1, id1);
    assert.equal((await call('old/encryptText', 'synthetic text')).status, 200);
    await admin1.delete(id1);
    assert.equal((await call('old/encryptText', 'synthetic text')).status, 503);
    await admin1.create(key1);
    assert.equal((await call('old/encryptText', 'synthetic text')).status, 200);
  } finally {
    await mf.dispose();
  }
});
