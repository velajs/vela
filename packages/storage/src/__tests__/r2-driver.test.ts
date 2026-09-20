import { describe, expect, it } from 'vitest';
import { r2Driver } from '../drivers/r2';
import type { R2BucketLike, R2ObjectLike, R2PutValue } from '../drivers/r2/r2.types';
import { toBytes } from '../internal/body';

interface Entry {
  bytes: Uint8Array;
  httpMetadata?: { contentType?: string; cacheControl?: string };
  customMetadata?: Record<string, string>;
}

/** A hand-rolled in-memory R2Bucket stub matching the structural contract. */
function makeR2Stub(): R2BucketLike & { store: Map<string, Entry> } {
  const store = new Map<string, Entry>();
  const obj = (key: string, e: Entry): R2ObjectLike => ({
    key,
    size: e.bytes.byteLength,
    etag: `etag-${e.bytes.byteLength}`,
    uploaded: new Date(0),
    httpMetadata: e.httpMetadata,
    customMetadata: e.customMetadata,
  });
  return {
    store,
    async put(key, value: R2PutValue, options) {
      const bytes = await toBytes((value ?? '') as never);
      const e: Entry = {
        bytes,
        httpMetadata: options?.httpMetadata,
        customMetadata: options?.customMetadata,
      };
      store.set(key, e);
      return obj(key, e);
    },
    async get(key, options) {
      const e = store.get(key);
      if (!e) return null;
      let out = e.bytes;
      if (options?.range?.offset != null) {
        const off = options.range.offset;
        out = e.bytes.subarray(
          off,
          options.range.length != null ? off + options.range.length : undefined,
        );
      }
      return {
        ...obj(key, e),
        body: new Response(out).body as ReadableStream,
        arrayBuffer: async () => out.buffer as ArrayBuffer,
      };
    },
    async head(key) {
      const e = store.get(key);
      return e ? obj(key, e) : null;
    },
    async delete(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
    async list(options) {
      const prefix = options?.prefix ?? '';
      const objects = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, e]) => obj(k, e));
      return { objects, truncated: false, delimitedPrefixes: [] };
    },
    async createMultipartUpload(key, options) {
      const parts = new Map<number, Uint8Array>();
      return {
        uploadId: 'up-1',
        async uploadPart(partNumber, value: R2PutValue) {
          parts.set(partNumber, await toBytes((value ?? '') as never));
          return { partNumber, etag: `p${partNumber}` };
        },
        async complete(uploaded) {
          const ordered = uploaded
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((p) => parts.get(p.partNumber)!);
          const total = ordered.reduce((n, c) => n + c.byteLength, 0);
          const all = new Uint8Array(total);
          let o = 0;
          for (const c of ordered) {
            all.set(c, o);
            o += c.byteLength;
          }
          const e: Entry = {
            bytes: all,
            httpMetadata: options?.httpMetadata,
            customMetadata: options?.customMetadata,
          };
          store.set(key, e);
          return obj(key, e);
        },
        async abort() {
          parts.clear();
        },
      };
    },
  };
}

describe('r2Driver (binding mode)', () => {
  it('round-trips through the native binding', async () => {
    const bucket = makeR2Stub();
    const d = r2Driver({ bucket });
    await d.upload('a.txt', 'hello', { contentType: 'text/plain', metadata: { x: '1' } });
    expect(bucket.store.has('a.txt')).toBe(true);

    const f = await d.download('a.txt');
    expect(await f.text()).toBe('hello');
    expect(f.type).toBe('text/plain');
    expect(await d.exists('a.txt')).toBe(true);
    expect(await (await d.download('a.txt', { range: { start: 0, end: 1 } })).text()).toBe('he');
  });

  it('lists, copies, and bulk-deletes', async () => {
    const bucket = makeR2Stub();
    const d = r2Driver({ bucket });
    await d.upload('a', '1');
    await d.upload('b', '2');
    const list = await d.list({});
    expect(list.items.map((i) => i.key).sort()).toEqual(['a', 'b']);
    await d.copy('a', 'c');
    expect(await (await d.download('c')).text()).toBe('1');
    await d.deleteMany!(['a', 'b']);
    expect(await d.exists('a')).toBe(false);
  });

  it('runs multipart via the binding', async () => {
    const d = r2Driver({ bucket: makeR2Stub() });
    const mp = await d.createMultipartUpload!('big');
    const p1 = await mp.uploadPart(1, new TextEncoder().encode('foo'));
    const p2 = await mp.uploadPart(2, new TextEncoder().encode('bar'));
    await mp.complete([p1, p2]);
    expect(await (await d.download('big')).text()).toBe('foobar');
  });

  it('cannot presign; url() needs publicBaseUrl', async () => {
    const bucket = makeR2Stub();
    await r2Driver({ bucket }).upload('a', 'x');
    await expect(r2Driver({ bucket }).url('a')).rejects.toMatchObject({ code: 'Unsupported' });
    expect(await r2Driver({ bucket, publicBaseUrl: 'https://cdn.example.com' }).url('a')).toBe(
      'https://cdn.example.com/a',
    );
    await expect(
      r2Driver({ bucket }).signedUploadUrl('a', { expiresIn: 60 }),
    ).rejects.toMatchObject({ code: 'Unsupported' });
  });

  it('advertises binding capabilities', () => {
    const d = r2Driver({ bucket: makeR2Stub() });
    expect(d.supportsRange).toBe(true);
    expect(d.supportsServerSideCopy).toBe(false);
    expect(d.signedUrl).toEqual({ supported: false, upload: false });
  });
});
