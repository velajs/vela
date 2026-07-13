import { describe, it, expect, beforeEach } from 'vitest';
import { Controller, Get, Module, MetadataRegistry } from '@velajs/vela';
import { createCloudflareApp } from '../cloudflare-factory';
import { R2Module } from '../modules/r2.module';
import { R2Service } from '../services/r2.service';
beforeEach(() => {
  MetadataRegistry.clear();
});

function createMockR2() {
  const store = new Map<string, { body: string; metadata: Record<string, string> }>();

  return {
    get: async (key: string) => {
      const item = store.get(key);
      if (!item) return null;
      return {
        key,
        body: item.body,
        text: async () => item.body,
        json: async () => JSON.parse(item.body),
        arrayBuffer: async () => new TextEncoder().encode(item.body).buffer,
        customMetadata: item.metadata,
      };
    },
    head: async (key: string) => {
      const item = store.get(key);
      if (!item) return null;
      return { key, size: item.body.length, customMetadata: item.metadata };
    },
    put: async (key: string, value: string, options?: Record<string, unknown>) => {
      store.set(key, { body: String(value), metadata: {} });
      return { key };
    },
    delete: async (keys: string | string[]) => {
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const k of keyList) store.delete(k);
    },
    list: async () => ({
      objects: [...store.entries()].map(([key, item]) => ({ key, size: item.body.length })),
      truncated: false,
    }),
    _store: store,
  };
}

describe('R2Module', () => {
  it('should inject R2Service with working put/get/delete', async () => {
    const mockR2 = createMockR2();

    @Controller('/storage')
    class StorageController {
      constructor(private r2: R2Service) {}

      @Get('/upload')
      async upload() {
        await this.r2.bucket.put('test.txt', 'hello world');
        return { ok: true };
      }

      @Get('/download')
      async download() {
        const obj = (await this.r2.bucket.get('test.txt')) as {
          text: () => Promise<string>;
        } | null;
        if (!obj) return { content: null };
        const text = await obj.text();
        return { content: text };
      }

      @Get('/remove')
      async remove() {
        await this.r2.bucket.delete('test.txt');
        return { ok: true };
      }
    }

    @Module({
      imports: [R2Module.forRoot({ binding: 'ASSETS' })],
      controllers: [StorageController],
    })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const hono = app.getHonoApp();

    // Upload
    const uploadRes = await hono.request('/storage/upload', undefined, { ASSETS: mockR2 });
    expect(uploadRes.status).toBe(200);

    // Download
    const downloadRes = await hono.request('/storage/download', undefined, { ASSETS: mockR2 });
    expect(downloadRes.status).toBe(200);
    expect(await downloadRes.json()).toEqual({ content: 'hello world' });

    // Delete
    const deleteRes = await hono.request('/storage/remove', undefined, { ASSETS: mockR2 });
    expect(deleteRes.status).toBe(200);

    // Verify deleted
    const downloadRes2 = await hono.request('/storage/download', undefined, { ASSETS: mockR2 });
    expect(await downloadRes2.json()).toEqual({ content: null });
  });

  it('should support list and head operations', async () => {
    const mockR2 = createMockR2();
    mockR2._store.set('file1.txt', { body: 'content1', metadata: {} });
    mockR2._store.set('file2.txt', { body: 'content2', metadata: {} });

    @Controller('/storage')
    class StorageController {
      constructor(private r2: R2Service) {}

      @Get('/list')
      async listFiles() {
        const result = await this.r2.bucket.list();
        return result;
      }

      @Get('/head')
      async headFile() {
        const meta = await this.r2.bucket.head('file1.txt');
        return { meta };
      }
    }

    @Module({
      imports: [R2Module.forRoot({ binding: 'BUCKET' })],
      controllers: [StorageController],
    })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const hono = app.getHonoApp();

    const listRes = await hono.request('/storage/list', undefined, { BUCKET: mockR2 });
    expect(listRes.status).toBe(200);
    const listData = (await listRes.json()) as { objects: unknown[] };
    expect(listData.objects.length).toBe(2);

    const headRes = await hono.request('/storage/head', undefined, { BUCKET: mockR2 });
    expect(headRes.status).toBe(200);
    const headData = (await headRes.json()) as { meta: { key: string } };
    expect(headData.meta.key).toBe('file1.txt');
  });
});
