import { describe, it, expect, beforeEach } from 'vitest';
import { Controller, Get, Inject, Module, MetadataRegistry } from '@velajs/vela';
import { createCloudflareApp } from '../cloudflare-factory';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';

beforeEach(() => {
  MetadataRegistry.clear();
});

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
    StorageModule.forRoot({
      disks: [{ disk: 'uploads', binding: 'MY_BUCKET', root: 'uploads' }],
      defaultDisk: 'uploads',
      presignedUrl: { defaultExpiry: 3600, maxExpiry: 86400 },
    }),
  ],
  controllers: [FilesController],
})
class AppModule {}

describe('StorageModule (multi-disk R2 + presign proxy)', () => {
  it('uploads with the disk root applied, reports existence, and serves a valid presigned URL', async () => {
    const bucket = createMockR2();
    const env = { MY_BUCKET: bucket, APP_SECRET: 'test-secret' };
    const app = await createCloudflareApp(AppModule);
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

    const download = await hono.request(url, undefined, env);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('hello world');
  });

  it('rejects tampered/unsigned presign-proxy requests with 403', async () => {
    const bucket = createMockR2();
    const env = { MY_BUCKET: bucket, APP_SECRET: 'test-secret' };
    const app = await createCloudflareApp(AppModule);
    const hono = app.getHonoApp();

    await hono.request('/files/upload', undefined, env);

    // No signature at all → 403.
    const unsigned = await hono.request(
      '/storage/uploads/uploads/hello.txt?method=GET',
      undefined,
      env,
    );
    expect(unsigned.status).toBe(403);

    // Tampered path under a valid-looking signature → 403.
    const signed = await hono.request('/files/sign', undefined, env);
    const { url } = (await signed.json()) as { url: string };
    const tampered = url.replace('hello.txt', 'secret.txt');
    const res = await hono.request(tampered, undefined, env);
    expect(res.status).toBe(403);
  });

  it('does not honor a non-GET-scoped signed URL as a read (403)', async () => {
    const bucket = createMockR2();
    const env = { MY_BUCKET: bucket, APP_SECRET: 'test-secret' };
    const app = await createCloudflareApp(AppModule);
    const hono = app.getHonoApp();

    await hono.request('/files/upload', undefined, env);

    // A PUT-scoped signed URL must not stream content when fetched via GET.
    const signed = await hono.request('/files/sign-put', undefined, env);
    const { url } = (await signed.json()) as { url: string };
    expect(url).toContain('method=PUT');
    const res = await hono.request(url, undefined, env);
    expect(res.status).toBe(403);
  });

  it('always sets an expiry and rejects a NaN expiry', async () => {
    const bucket = createMockR2();
    const env = { MY_BUCKET: bucket, APP_SECRET: 'test-secret' };
    const app = await createCloudflareApp(AppModule);
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
