import { describe, it, expect } from 'vitest';
import { Controller, ENV, Get, Inject, Module } from '@velajs/vela';
import { signUrl, STORAGE_SIGNED_URL_PURPOSE } from '@velajs/vela/security';
import { createCloudflareApp } from '../cloudflare-factory';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { encodeStorageKeyClaim, isStorageKeyWithinRoot } from '../storage/storage-key-claim';

function createMockR2() {
  const store = new Map<string, { body: string; contentType?: string }>();
  return {
    async put(key: string, value: unknown, options?: { httpMetadata?: { contentType?: string } }) {
      store.set(key, { body: String(value), contentType: options?.httpMetadata?.contentType });
      return { key };
    },
    async get(key: string) {
      const item = store.get(key);
      if (!item) return null;
      return {
        key,
        body: new Response(item.body).body,
        arrayBuffer: async () => new TextEncoder().encode(item.body).buffer,
        text: async () => item.body,
        httpMetadata: { contentType: item.contentType },
        size: item.body.length,
        customMetadata: undefined,
      };
    },
    async head(key: string) {
      const item = store.get(key);
      return item ? { key, size: item.body.length } : null;
    },
    async delete(key: string) {
      store.delete(key);
    },
    _store: store,
  };
}

@Controller('files')
class FilesController {
  constructor(@Inject(StorageService) private readonly storage: StorageService) {}

  @Get('/upload')
  async upload(): Promise<{ path: string }> {
    const result = await this.storage.put('hello.txt', 'hello world', { mimeType: 'text/plain' });
    return { path: result.path };
  }

  @Get('/exists')
  async exists(): Promise<{ exists: boolean }> {
    return { exists: await this.storage.exists('hello.txt') };
  }

  @Get('/sign')
  async sign(): Promise<{ url: string }> {
    const result = await this.storage.url('hello.txt', 'GET', 3600);
    return { url: result.url };
  }

  @Get('/sign-put')
  async signPut(): Promise<{ url: string }> {
    const result = await this.storage.url('hello.txt', 'PUT', 3600);
    return { url: result.url };
  }

  @Get('/sign-encoded-traversal')
  async signEncodedTraversal(): Promise<{ url: string }> {
    const result = await this.storage.url('%252e%252e/private/secret.txt', 'GET', 3600);
    return { url: result.url };
  }

  @Get('/sign-nan')
  async signNaN(): Promise<{ rejected: boolean }> {
    try {
      await this.storage.url('hello.txt', 'GET', Number('not-a-number'));
      return { rejected: false };
    } catch {
      return { rejected: true };
    }
  }
}

@Module({
  imports: [
    StorageModule.forRootAsync({
      inject: [ENV],
      // The synthetic environments below carry a mock bucket and the secret.
      useFactory: (env) => ({
        secret: Reflect.get(env, 'APP_SECRET'),
        disks: [{ disk: 'uploads', bucket: Reflect.get(env, 'MY_BUCKET'), root: 'uploads' }],
        defaultDisk: 'uploads',
        presignedUrl: { defaultExpiry: 3600, maxExpiry: 86400 },
      }),
    }),
  ],
  controllers: [FilesController],
})
class AppModule {}

describe('StorageModule (multi-disk R2 + presign proxy)', () => {
  it('asserts static and templated roots without time-of-verification re-expansion', () => {
    expect(isStorageKeyWithinRoot('uploads/hello.txt', 'uploads')).toBe(true);
    expect(isStorageKeyWithinRoot('private/hello.txt', 'uploads')).toBe(false);
    expect(isStorageKeyWithinRoot('uploads/2026/07/hello.txt', 'uploads/{year}/{month}')).toBe(
      true,
    );
    expect(
      isStorageKeyWithinRoot(
        'uploads/550e8400-e29b-41d4-a716-446655440000/hello.txt',
        'uploads/{uuid}',
      ),
    ).toBe(true);
  });

  it('uploads with the disk root applied, reports existence, and serves a valid presigned URL', async () => {
    const bucket = createMockR2();
    const env = { MY_BUCKET: bucket, APP_SECRET: 'test-secret' };
    const app = await createCloudflareApp(AppModule, { env });
    const hono = app.getHonoApp();

    // Upload → root 'uploads' is applied to the relative key.
    const uploaded = await hono.request('/files/upload', undefined, env);
    expect(uploaded.status).toBe(200);
    expect(await uploaded.json()).toEqual({ path: 'uploads/hello.txt' });
    expect(bucket._store.has('uploads/hello.txt')).toBe(true);

    // Exists.
    const exists = await hono.request('/files/exists', undefined, env);
    expect(await exists.json()).toEqual({ exists: true });

    // Presign, then fetch the signed URL through the proxy route.
    const signed = await hono.request('/files/sign', undefined, env);
    const { url } = (await signed.json()) as { url: string };
    expect(url).toContain('signature=');
    expect(new URL(url, 'http://localhost').pathname).toBe('/storage/uploads');
    expect(url).not.toContain('hello.txt');

    const download = await hono.request(url, undefined, env);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(download.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await download.text()).toBe('hello world');
  });

  it('never renders stored HTML or SVG inline on the authenticated API origin', async () => {
    const bucket = createMockR2();
    const env = { MY_BUCKET: bucket, APP_SECRET: 'test-secret' };
    const app = await createCloudflareApp(AppModule, { env });
    const hono = app.getHonoApp();

    for (const [name, contentType] of [
      ['payload.html', 'text/html'],
      ['payload.svg', 'image/svg+xml'],
    ] as const) {
      bucket._store.set(`uploads/${name}`, { body: '<script>attack()</script>', contentType });
      const query = new URLSearchParams({
        key: encodeStorageKeyClaim(`uploads/${name}`),
        method: 'GET',
      });
      const signed = await signUrl(`/storage/uploads?${query}`, env.APP_SECRET, {
        expiresIn: 60,
        method: 'GET',
        purpose: STORAGE_SIGNED_URL_PURPOSE,
      });
      const response = await hono.request(signed, undefined, env);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(contentType);
      expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  it('rejects tampered/unsigned presign-proxy requests with 403', async () => {
    const bucket = createMockR2();
    const env = { MY_BUCKET: bucket, APP_SECRET: 'test-secret' };
    const app = await createCloudflareApp(AppModule, { env });
    const hono = app.getHonoApp();

    await hono.request('/files/upload', undefined, env);

    // No signature at all → 403.
    const unsigned = await hono.request(
      `/storage/uploads?key=${encodeStorageKeyClaim('uploads/hello.txt')}&method=GET`,
      undefined,
      env,
    );
    expect(unsigned.status).toBe(403);

    // Tampered path under a valid-looking signature → 403.
    const signed = await hono.request('/files/sign', undefined, env);
    const { url } = (await signed.json()) as { url: string };
    const tampered = new URL(url, 'http://localhost');
    const claim = tampered.searchParams.get('key')!;
    tampered.searchParams.set('key', `${claim.slice(0, -1)}${claim.endsWith('A') ? 'B' : 'A'}`);
    const res = await hono.request(`${tampered.pathname}?${tampered.searchParams}`, undefined, env);
    expect(res.status).toBe(403);
  });

  it('does not honor a non-GET-scoped signed URL as a read (403)', async () => {
    const bucket = createMockR2();
    const env = { MY_BUCKET: bucket, APP_SECRET: 'test-secret' };
    const app = await createCloudflareApp(AppModule, { env });
    const hono = app.getHonoApp();

    await hono.request('/files/upload', undefined, env);

    // A PUT-scoped signed URL must not stream content when fetched via GET.
    const signed = await hono.request('/files/sign-put', undefined, env);
    const { url } = (await signed.json()) as { url: string };
    expect(url).toContain('method=PUT');
    const res = await hono.request(url, undefined, env);
    expect(res.status).toBe(403);
  });

  it('keeps encoded traversal attempts inside the configured R2 root', async () => {
    const bucket = createMockR2();
    const env = { MY_BUCKET: bucket, APP_SECRET: 'test-secret' };
    bucket._store.set('uploads/private/secret.txt', { body: 'rooted object' });
    bucket._store.set('private/secret.txt', { body: 'escaped object' });

    const app = await createCloudflareApp(AppModule, { env });
    const hono = app.getHonoApp();
    const signed = await hono.request('/files/sign-encoded-traversal', undefined, env);
    const { url } = (await signed.json()) as { url: string };

    const download = await hono.request(url, undefined, env);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('rooted object');
  });

  it('rejects validly signed claims outside the disk root or with dot-segment aliases', async () => {
    const bucket = createMockR2();
    const env = { MY_BUCKET: bucket, APP_SECRET: 'test-secret' };
    bucket._store.set('private/secret.txt', { body: 'escaped object' });
    const app = await createCloudflareApp(AppModule, { env });
    const hono = app.getHonoApp();

    for (const key of ['private/secret.txt', 'uploads/../private/secret.txt']) {
      const query = new URLSearchParams({ key: encodeStorageKeyClaim(key), method: 'GET' });
      const signed = await signUrl(`/storage/uploads?${query}`, env.APP_SECRET, {
        expiresIn: 60,
        method: 'GET',
        purpose: STORAGE_SIGNED_URL_PURPOSE,
      });
      const response = await hono.request(signed, undefined, env);
      expect(response.status).toBe(403);
    }
  });

  it('rejects a malformed opaque key claim after signature verification', async () => {
    const bucket = createMockR2();
    const env = { MY_BUCKET: bucket, APP_SECRET: 'test-secret' };
    const app = await createCloudflareApp(AppModule, { env });
    const hono = app.getHonoApp();
    const signed = await signUrl('/storage/uploads?key=%%%&method=GET', env.APP_SECRET, {
      expiresIn: 60,
      method: 'GET',
      purpose: STORAGE_SIGNED_URL_PURPOSE,
    });

    const response = await hono.request(signed, undefined, env);
    expect(response.status).toBe(400);

    const missingMethod = await signUrl(
      `/storage/uploads?key=${encodeStorageKeyClaim('uploads/hello.txt')}`,
      env.APP_SECRET,
      {
        expiresIn: 60,
        method: 'GET',
        purpose: STORAGE_SIGNED_URL_PURPOSE,
      },
    );
    expect((await hono.request(missingMethod, undefined, env)).status).toBe(403);
  });

  it('always sets an expiry and rejects a NaN expiry', async () => {
    const bucket = createMockR2();
    const env = { MY_BUCKET: bucket, APP_SECRET: 'test-secret' };
    const app = await createCloudflareApp(AppModule, { env });
    const hono = app.getHonoApp();

    // A normal presign carries an `expires` param (never a permanent URL).
    const signed = await hono.request('/files/sign', undefined, env);
    const { url } = (await signed.json()) as { url: string };
    expect(url).toContain('expires=');

    // NaN expiry is rejected by validateExpiry rather than silently omitting expires.
    const nan = await hono.request('/files/sign-nan', undefined, env);
    expect(await nan.json()).toEqual({ rejected: true });
  });
});
