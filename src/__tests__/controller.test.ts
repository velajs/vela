import { MetadataRegistry } from '@velajs/vela';
import { Test } from '@velajs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StorageModule } from '../index';
import type { StorageHttpOptions } from '../index';
import { s3Driver } from '../drivers/s3';
import { memoryDriver } from '../drivers/memory';

function s3Mock() {
  return s3Driver({
    endpoint: 'https://s3.us-east-1.amazonaws.com',
    region: 'us-east-1',
    bucket: 'b',
    forcePathStyle: true,
    credentials: { accessKeyId: 'AK', secretAccessKey: 'sk' },
    fetch: (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.searchParams.get('list-type') === '2') {
        return new Response('<ListBucketResult><Contents><Key>a.txt</Key><Size>3</Size></Contents><IsTruncated>false</IsTruncated></ListBucketResult>');
      }
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch,
  });
}

async function appWith(http: StorageHttpOptions, useMemory = false) {
  const moduleRef = await Test.createTestingModule({
    imports: [StorageModule.forRoot({ driver: useMemory ? memoryDriver() : s3Mock(), http })],
  }).compile();
  const app = await moduleRef.createApplication();
  return app.getHonoApp();
}

const post = (path: string, body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('StorageController', () => {
  beforeEach(() => MetadataRegistry.clear());
  afterEach(() => MetadataRegistry.clear());

  it('default-deny: rejects when no authorizer is configured', async () => {
    const app = await appWith({ defaultPolicy: 'deny' });
    const res = await app.request('/api/storage/sign-upload', post('/api/storage/sign-upload', { key: 'a.txt' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
  });

  it('mints a presigned PUT when allowed', async () => {
    const app = await appWith({ authorize: () => true });
    const res = await app.request('/api/storage/sign-upload', post('x', { key: 'a.txt', contentType: 'text/plain' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key).toBe('a.txt');
    expect(body.upload.method).toBe('PUT');
    expect(new URL(body.upload.url).searchParams.get('X-Amz-Signature')).toBeTruthy();
  });

  it('applies allow-with-overrides (server rewrites the key)', async () => {
    const app = await appWith({ authorize: (a) => ('key' in a ? { key: `safe/${a.key}` } : true) });
    const res = await app.request('/api/storage/sign-upload', post('x', { key: 'a.txt' }));
    expect((await res.json()).key).toBe('safe/a.txt');
  });

  it('rejects unsafe keys with invalid_key', async () => {
    const app = await appWith({ authorize: () => true });
    const res = await app.request('/api/storage/sign-upload', post('x', { key: '../secret' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_key');
  });

  it('lists and deletes', async () => {
    const app = await appWith({ authorize: () => true });
    const list = await app.request('/api/storage/list?prefix=a');
    expect(list.status).toBe(200);
    expect((await list.json()).items[0].key).toBe('a.txt');

    const del = await app.request('/api/storage/delete', post('x', { keys: ['a.txt'] }));
    expect(del.status).toBe(200);
  });

  it('redirects downloads to a signed URL', async () => {
    const app = await appWith({ authorize: () => true, download: 'redirect' });
    const res = await app.request('/api/storage/download?key=a.txt');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('X-Amz-Signature=');
  });

  it('reports capability_unsupported for presign on a memory driver', async () => {
    const app = await appWith({ authorize: () => true }, true);
    const res = await app.request('/api/storage/sign-upload', post('x', { key: 'a.txt' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('capability_unsupported');
  });
});
