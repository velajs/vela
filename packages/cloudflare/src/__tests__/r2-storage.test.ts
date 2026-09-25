import { describe, expect, it } from 'vitest';
import { Module, VelaFactory } from '@velajs/vela';
import { StorageModule, StorageService } from '@velajs/storage';
import { createCloudflareApp } from '../index';
import { r2Storage } from '../storage';

/** The R2 operations the storage driver calls, over an in-memory map. */
function bucket(objects = new Map<string, string>()) {
  const object = (key: string, value: string) => ({
    key,
    size: value.length,
    etag: `etag-${key}`,
    uploaded: new Date(0),
    httpMetadata: { contentType: 'text/plain' },
    customMetadata: {},
    body: new Response(value).body!,
    text: async () => value,
    arrayBuffer: async () => new TextEncoder().encode(value).buffer,
  });
  return {
    objects,
    async put(key: string, value: string) {
      objects.set(key, value);
      return object(key, value);
    },
    async get(key: string) {
      const value = objects.get(key);
      return value === undefined ? null : object(key, value);
    },
    async head(key: string) {
      const value = objects.get(key);
      return value === undefined ? null : object(key, value);
    },
    async delete(key: string | string[]) {
      for (const name of [key].flat()) objects.delete(name);
    },
    async list() {
      return { objects: [], delimitedPrefixes: [], truncated: false };
    },
    async createMultipartUpload() {
      throw new Error('unused');
    },
  };
}

describe('r2Storage({ binding })', () => {
  const storage = StorageModule.forRoot({ driver: r2Storage({ binding: 'UPLOADS' }) });
  @Module({ imports: [storage] })
  class App {}

  it('drives @velajs/storage from the R2 bucket of each application ENV', async () => {
    const east = bucket();
    const west = bucket();
    const a = await createCloudflareApp(App, { env: { UPLOADS: east } });
    const b = await createCloudflareApp(App, { env: { UPLOADS: west } });
    await a.get(StorageService).upload('greeting.txt', 'hello east');
    await b.get(StorageService).upload('greeting.txt', 'hello west');
    expect(east.objects.get('greeting.txt')).toBe('hello east');
    expect(west.objects.get('greeting.txt')).toBe('hello west');
    expect(await (await a.get(StorageService).download('greeting.txt')).text()).toBe('hello east');
    await Promise.all([a.close(), b.close()]);
  });

  it('reads no binding while the application boots, then names the Wrangler key', async () => {
    const app = await createCloudflareApp(App, { env: {} });
    await expect(app.get(StorageService).upload('a.txt', 'x')).rejects.toThrow(
      "ENV.UPLOADS is not set: declare the R2 bucket binding 'UPLOADS' under r2_buckets",
    );
    await app.close();
  });

  it('rejects another kind of binding', async () => {
    const app = await VelaFactory.create(App, { env: { UPLOADS: { get: () => null } } });
    await expect(app.get(StorageService).exists('a.txt')).rejects.toThrow(
      'ENV.UPLOADS is not a binding of type R2 bucket',
    );
    await app.close();
  });

  it('validates the reference when declared', () => {
    expect(() => r2Storage({ binding: '' })).toThrow('non-empty');
  });
});
