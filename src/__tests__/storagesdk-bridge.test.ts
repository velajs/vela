import { describe, expect, it } from 'vitest';
import { storageSdkDriver, type StorageSdkAdapterLike } from '../storagesdk';
import { StorageError } from '../index';
import { toBytes } from '../internal/body';

interface Entry {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
  metadata?: Record<string, string>;
}

function fakeAdapter(withMove = false): StorageSdkAdapterLike & { store: Map<string, Entry> } {
  const store = new Map<string, Entry>();
  const meta = (path: string, e: Entry) => ({
    path,
    size: e.bytes.byteLength,
    contentType: e.contentType,
    etag: 'e',
    lastModified: new Date(0),
    metadata: e.metadata,
  });
  const adapter: StorageSdkAdapterLike & { store: Map<string, Entry> } = {
    name: 'fake',
    store,
    async upload(path, body, opts) {
      const bytes = new Uint8Array(await toBytes(body));
      const e: Entry = { bytes, contentType: opts?.contentType ?? 'application/octet-stream', metadata: opts?.metadata };
      store.set(path, e);
      return meta(path, e);
    },
    async download(path) {
      const e = store.get(path);
      if (!e) throw new StorageError('NotFound', path);
      return { ...meta(path, e), body: e.bytes };
    },
    async head(path) {
      const e = store.get(path);
      if (!e) throw new StorageError('NotFound', path);
      return meta(path, e);
    },
    async list(opts) {
      const prefix = opts?.prefix ?? '';
      return {
        items: [...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, e]) => meta(k, e)),
      };
    },
    async url(path) {
      return `https://cdn.example.com/${path}`;
    },
    async delete(path) {
      store.delete(path);
    },
    async copy(from, to) {
      const e = store.get(from);
      if (e) store.set(to, { ...e, bytes: new Uint8Array(e.bytes) });
    },
  };
  if (withMove) {
    adapter.move = async (from, to) => {
      const e = store.get(from);
      if (e) store.set(to, e);
      store.delete(from);
    };
  }
  return adapter;
}

describe('storageSdkDriver bridge', () => {
  it('maps core operations (path<->key, buffered body -> StoredFile)', async () => {
    const d = storageSdkDriver(fakeAdapter());
    expect(d.name).toBe('storagesdk:fake');
    const r = await d.upload('docs/a.txt', 'hello', { contentType: 'text/plain', metadata: { o: '1' } });
    expect(r.size).toBe(5);
    const f = await d.download('docs/a.txt');
    expect(await f.text()).toBe('hello');
    expect(f.metadata).toEqual({ o: '1' });
    expect((await d.list({ prefix: 'docs/' })).items.map((i) => i.key)).toEqual(['docs/a.txt']);
    expect(await d.url('docs/a.txt')).toBe('https://cdn.example.com/docs/a.txt');
  });

  it('synthesizes capability flags conservatively', () => {
    const d = storageSdkDriver(fakeAdapter());
    expect(d.supportsRange).toBe(false);
    expect(d.supportsMetadata).toBe(true);
    expect(d.supportsServerSideCopy).toBe(true);
    expect(d.signedUrl).toEqual({ supported: true, upload: false });
    expect(typeof d.createMultipartUpload).toBe('undefined'); // gated as Unsupported by the facade
  });

  it('falls back to head() for exists and throws Unsupported for presign', async () => {
    const d = storageSdkDriver(fakeAdapter());
    await d.upload('k', 'v');
    expect(await d.exists('k')).toBe(true);
    expect(await d.exists('missing')).toBe(false);
    await expect(d.signedUploadUrl('k', { expiresIn: 60 })).rejects.toMatchObject({ code: 'Unsupported' });
  });

  it('exposes move only when the adapter has it', async () => {
    expect(storageSdkDriver(fakeAdapter(false)).move).toBeUndefined();
    const d = storageSdkDriver(fakeAdapter(true));
    await d.upload('a', '1');
    await d.move!('a', 'b');
    expect(await d.exists('a')).toBe(false);
    expect(await (await d.download('b')).text()).toBe('1');
  });
});
